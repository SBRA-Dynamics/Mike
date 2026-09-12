# QA review — PRD 1 (server foundation)

Independent adversarial review of `/home/robin/jarvis` at commit `78eaf0e`.
Everything below was verified against a running server unless marked *by reading*.

Counts: **1 critical, 12 major, 14 minor, 6 nits.**

Headline: the transport core (framing, auth ordering, keepalive, replay-while-attached,
turn-survives-drop) is genuinely sound and well thought through. The damage is at the
edges — one unvalidated network-controlled string that reaches `path.join`, a persistence
model that can reissue sequence numbers, three R1.5/R1.8 deliverables that exist as dead
code or not at all, and a test suite that does not currently pass and whose two most
important assertions cannot fail.

---

## CRITICAL

### C1 — A client picks its own `sessionId`, and that string is used verbatim as a filename

**Severity:** critical
**Where:** `src/connection.js:79` → `src/sessions.js:85-86`, `:100-110`, `:132-146`

`onHello` passes the client-supplied `m.sessionId` straight to `store.getOrCreate(id)`,
which passes it to `join(this.dir, `${id}.meta.json`)` and `join(this.dir, `${id}.jsonl`)`.
`validateC2S` (`src/protocol.js:53`) checks only `typeof === "string"`. `path.join`
resolves `..` segments, so the write lands wherever the client says.

**Verified repro** (server on :34777, data dir `…/scratchpad/data/sessions`):

```js
ws.send(JSON.stringify({ type:"hello", protocol:1, token:TOKEN,
                         sessionId:"../../../ESCAPED" }));
ws.send(JSON.stringify({ type:"say", text:"ARBITRARY-CONTENT-HERE" }));
```

Result — files created three levels above the data directory:

```
/tmp/.../ae50417f-…/ESCAPED.meta.json
/tmp/.../ae50417f-…/ESCAPED.jsonl
  {"type":"text","text":"echo: ARBITRARY-CONTENT-HERE","from":"echo","seq":3}
```

The server even echoes the traversal path back as `ready.sessionId` and logs
`session=../../..`.

**Why it matters.** It is an arbitrary file write with attacker-chosen path, attacker-chosen
content and a `.jsonl` / `.meta.json` suffix, running as whatever user the service runs as
— which R1.1 says will *not* be root but will be Robin's own account, i.e. the account that
owns `~/.ssh`, `~/.config/systemd/user`, and the repo. `SessionStore.delete()` unlinks the
same two computed paths, so the same flaw is an arbitrary-delete primitive the moment
R1.5's delete action is wired up (see M5). It is gated behind the bearer token, which is why
it is not an unauthenticated RCE — but "the token holder is trusted" is not a property you
want load-bearing, and PRD 2 will expose this same process to tool calls.

It is also a straight R1.5 violation: *"A session has a stable id (UUID) chosen by the
server."* The server never chooses; `getOrCreate` accepts whatever arrives.

**Fix shape:** reject any `sessionId` that is not a v4 UUID before it reaches the store,
and make `#metaPath`/`#logPath` assert the resolved path is inside `this.dir` (the same
check `serveStatic` already does).

---

## MAJOR

### M1 — `GET /%` hangs the request forever (unauthenticated)

**Severity:** major
**Where:** `server.js:107`

`decodeURIComponent` throws `URIError` on malformed percent-encoding. It is not in a
try/catch, so the throw escapes `onRequest`, is caught by the process-wide
`uncaughtException` handler (`server.js:219`), and **the response is never written**.

**Verified:**

```
$ curl -m 3 -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:34777/%"
000      (curl timed out; nothing was ever sent back)

server log:
[…] ERROR UNCAUGHT: URIError: URI malformed
    at serveStatic (file:///home/robin/jarvis/server.js:107:14)
```

Every such request leaks a socket and a pending `ServerResponse` until the client gives up;
with HTTP keep-alive the connection is wedged permanently. A trivial loop exhausts the
server's socket budget from the open internet with no token. It also means the process is
routinely running *after* an uncaught exception, which is exactly the state Node documents
as undefined — see M11.

### M2 — `seq` can be reused after a restart, and a client silently loses messages

**Severity:** major
**Where:** `src/sessions.js:36-52` (`emit`), `:88-96` (`#loadAll`), `:143-146`

`emit` appends to the JSONL **first** (`:44`) and rewrites the meta **second** (`:45`).
A crash in between leaves the transcript ahead of the persisted `seq`. On boot,
`#loadAll` takes `seq` from the meta file alone and never reconciles it with the highest
`seq` actually present in the JSONL. Neither write is `fsync`ed, so a machine crash can
lose the tail of either file independently, in either order.

**Verified** — set meta `seq` from 7 back to 5 (the state a crash between `:44` and `:45`
produces), restart, and reconnect with the `resumeFrom: 7` the client legitimately holds:

```
ready: {"cursor":5, "resumed":true, "missed":0, "gap":false}     ← cursor went BACKWARDS,
                                                                   reported as "nothing missed"
server then issues:  seq 6 state   seq 7 text "AFTER RESTART…"   seq 8 state
transcript now contains two different messages both labelled "seq":6
```

A client whose only tool for ordering and de-duplication is `seq` — which is all the
protocol gives it — must drop 6 and 7 as already-seen, and therefore **silently loses the
reply**. This is precisely the failure acceptance criterion 3 exists to prevent, and it
survives across the restart that acceptance criterion 4 covers.

The comment at `sessions.js:130-131` ("a half-written meta would lose the sequence number
and make replay silently wrong after a crash") identifies the exact hazard and then only
defends against a *torn* meta, not a *stale* one.

**Fix shape:** on load, `seq = max(meta.seq, max seq in the JSONL)`. One line, and it makes
the JSONL the authority it was chosen to be.

### M3 — `replayGap` cannot detect a `resumeFrom` ahead of the server

**Severity:** major
**Where:** `src/sessions.js:59-63`

```js
replayGap(from) {
    if (!this.recent.length) return from > 0 && from < this.seq;
    return from > 0 && from < this.recent[0].seq - 1;
}
```

Both branches only ask whether `from` is too *old*. Nothing asks whether `from > this.seq`.
When it is, `replay(from)` returns `[]` and the client is told `missed: 0, gap: false` —
"you are fully caught up" — which is the one answer that is definitely wrong.

Two ways to reach it: M2's rewind, and an unknown session id (`getOrCreate` creates a fresh
empty session rather than saying "gone"). **Verified:**

```
hello { sessionId:"00000000-dead-beef-…", resumeFrom:999 }
→ ready {"cursor":0,"resumed":true,"missed":0,"gap":false}
```

A client that reconnects to a server whose data directory was moved, or to a session the
user deleted on another device, is told its resume succeeded and then sits on a silent
socket. `gap: true` is the honest answer for both cases.

### M4 — The test suite does not pass; it fails ~2 runs in 3

**Severity:** major
**Where:** `test/run.mjs:74-82`, cause in `src/connection.js:83-98`

Three consecutive runs of `node test/run.mjs`: **FAIL, PASS, FAIL** — always the same
assertion, `inget replayas i onödan — missed=1`.

Root cause, confirmed by instrumentation: `c2` connects with a `sessionId` but **no**
`resumeFrom`, so `from` defaults to 0 and the server replays the *entire* buffer, including
a `state{busy:false}` from `c1`'s earlier turn:

```
c2 ready: {"cursor":4,"resumed":false,"missed":4,"gap":false}
c2 messages:  1 text "Mike transport online"   2 state true
              3 text "echo: hej"                 4 state false   ← replayed
              5 text "Mike transport online"   ← greeting emitted AGAIN
```

Line 74's `waitFor(m => m.type === "state" && m.busy === false)` uses `Array.find` over the
whole history, so it matches that *replayed* seq-4 idle and returns immediately — before the
current turn's real trailing idle (seq 8) has arrived. `before` is then the text's seq, the
idle lands afterwards, and `missed` is 1. Whether the 25 ms poll tick happens to land before
or after that idle decides the run.

The comment at `run.mjs:72-73` shows the author saw the symptom and misdiagnosed it as
benign. It is not benign: the fix is `resumeFrom`, and the surprising behaviour it is
papering over is M6.

### M5 — R1.5's "listed, resumed and deleted" is dead code; the gap-recovery path is a dead end

**Severity:** major
**Where:** `src/sessions.js:112-117` (`list`), `:119-128` (`delete`), `:149-158` (`history`);
`src/handler.js:35-44`

`grep` across the whole tree: `list()`, `delete()` and `history()` are **never called by
anything**. The only `control` action implemented is `setTitle`. So:

- **list** — no way for any client to enumerate sessions. R1.5 bullet 4.
- **delete** — no way to delete one. R1.5 bullet 4.
- **transcript** — persisted faithfully to disk and then unreadable by any client. R1.5
  bullet 2 and acceptance criterion 4 are half-satisfied: the bytes survive, the
  conversation does not.

This last one has a concrete consequence. When the replay buffer is exceeded the server
sends (`connection.js:99`):

> `"too much missed to replay; reload the transcript"`

**Verified** — 510 messages then `resumeFrom: 1` returns `gap:true, missed:0` and that
error. There is no way to reload the transcript. The client is instructed to perform an
operation the protocol does not have, and those messages are gone. Acceptance criterion 3
("replays exactly what was missed") has an unhandled cliff at 500 messages — roughly 170
turns of the echo handler, and far fewer once PRD 3 streams tokens.

### M6 — `onOpen` broadcasts to the whole session, and a connect without `resumeFrom` dumps the entire buffer

**Severity:** major
**Where:** `src/connection.js:83-102`, `src/handler.js:16-18`, `src/sessions.js:36-52`

Two coupled problems, both visible in the M4 trace:

1. `const from = Number.isInteger(m.resumeFrom) ? m.resumeFrom : 0` then `replay(0)` returns
   **everything in `recent`** — up to 500 messages — while `ready` reports `resumed: false`.
   A client opening a known session fresh (the normal first load on a new device) is told
   "this is not a resume" and simultaneously handed the whole backlog. R1.3 says the server
   replays "only what was missed".
2. `handler.onOpen` calls `session.emit(...)`, and `emit` broadcasts to **every** attached
   socket and appends to the durable transcript. So each time any device connects, every
   other device already on that session receives the greeting again, and the transcript
   accumulates one greeting per connect. Verified: seq 5 above is a second greeting arriving
   at a connection that had just been replayed the first one.

PRD 0 makes this a product problem, not a cosmetic one: "switch between PC and glasses
inside the same conversation" means two devices attached at once is the *designed* case.
Anything per-connection must go through the connection's own `send()`, never `emit()`.

The same flaw applies to `emit(msg.error(...))` at `connection.js:49` and `:54`: one client's
malformed frame or duplicate hello is broadcast to every other device on the session and
written to the permanent transcript. **Verified** — a duplicate hello produced
`{"type":"error","message":"already said hello","seq":2}` on the session.

### M7 — The two most important replay assertions cannot fail

**Severity:** major
**Where:** `test/run.mjs:94-99`, `:134-138`, `:151`, `:159-161`

Acceptance criterion 3 is "replays exactly what was missed, **once**". What the suite
actually asserts:

- `run.mjs:93` — `missed >= 1` where the setup guarantees 3. "At least one" is not "exactly
  what was missed".
- `run.mjs:94-95` — *"replay dupliceras inte"* builds `replayed` from `c5.messages` in the
  same tick `connect()` resolved. If the replayed frames have not been delivered yet the
  array is empty, and `new Set([]).size === 0 === [].length` **passes vacuously**. An
  implementation that replayed every message twice would still pass on a slow tick.
- `run.mjs:97-99` — *"för gammal resumeFrom rapporteras som gap"* asserts
  `gap === true || missed > 0`. At that point the session holds ~20 messages against a
  `REPLAY_DEPTH` of 500, so `gap` is **always false** and the right-hand side is always true.
  **The gap branch — `replayGap`, the `gap` flag, and the error at `connection.js:99` — has
  zero test coverage.** That is the branch M3 is broken in.
- `run.mjs:136` — *"sökvägsflykt blockeras"* does `fetch(base + "/../../../../etc/passwd")`.
  The WHATWG URL parser collapses `..` **client-side**, so the request that reaches the
  server is `GET /etc/passwd`. The test proves the server has no `etc/passwd` under its
  static root. Verified with raw sockets: a real `GET /../../../../etc/passwd` returns 200
  `index.html`. (The server *is* safe here — but not because of this test.) Asserting on
  `!body.includes("root:")` rather than on a 403 means "200 index.html for everything" also
  passes. The `%2e%2e%2f` variant on line 137 *is* a genuine test.
- `run.mjs:143-152` — the restart section sets a title `"överlever omstart"` specifically so
  persistence can be checked, then **never asserts it after the restart**. Nor does anything
  check the transcript survived. Only `cursor` is compared.
- `run.mjs:159-161` — `server.log()` is reassigned by `harness.restart()` (`harness.mjs:56`)
  to the *new* process's log. The UNCAUGHT/UNHANDLED check therefore covers only the three
  messages sent after the restart; every exception raised during the preceding 40
  assertions is thrown away. M1's `UNCAUGHT` would not be caught by this check.

Untested entirely: TLS (R1.1, acceptance 1), certificate reload (acceptance 5), ping/pong
keepalive (an explicit R1.3 bullet), the hello timeout, duplicate hello, binary frames,
`maxPayload`, `interrupt`, `audio`, the dev proxy, concurrent turns, and crash-mid-write.
`longevity.mjs` defaults to a loopback server, which does not exercise R1.4's actual risk —
that one needs the phone, mobile data and the real hostname, and is manual.

### M8 — R1.8 operations: no systemd unit, no message-type log, no turn duration, no worker in `/healthz`

**Severity:** major
**Where:** repository root (absent), `src/connection.js` (all `log.` calls), `server.js:149-157`

R1.8 lists four things. Status:

| R1.8 requirement | Status |
|---|---|
| systemd unit, `Restart=always`, starts at boot | **Absent.** No `.service` file, no README, no deploy notes anywhere in the tree. |
| Logs to a real file, never an inherited tty | Partly. `src/log.js` wraps `process.stdout.write` in try/catch — good mitigation — but "logs to a real file" depends on the `StandardOutput=append` its own comment names, and that configuration does not exist. |
| Every inbound message type logged | **Not done.** `connection.js` logs hello, close, and errors. A successful `say`/`control`/`interrupt` leaves no trace at all. |
| Every worker spawn/switch, turn duration | **Not done.** Nothing times a turn. (Workers are PRD 3; turn duration is not.) |
| `/healthz` returns uptime, session count, **active worker** | Two of three. `server.js:150-153` returns `ok, version, protocol, uptime, sessions, connections` — no worker, though `session.worker` exists and is persisted. |

Acceptance criterion 7 ("starts at boot and recovers from a crash within 5 s") has neither
an artifact nor a test. It cannot currently be demonstrated.

### M9 — R1.1's non-root + ACL half is undelivered

**Severity:** major
**Where:** repository root (absent); `server.js:190` mentions the symptom only

R1.1 is two requirements. The reload half works (see V4). The second half — *"The process
must not run as root; certificate files are made readable through an ACL instead"* — has no
artifact: no `setfacl` line, no `CAP_NET_BIND_SERVICE` setup, no unit file, no documentation.
`server.js:190` prints `ports below 1024 need CAP_NET_BIND_SERVICE` at the moment of failure,
which is a hint, not a deliverable. Since this is the thing most likely to be got wrong once,
at 3 a.m., under a renewal that already broke, it needs to be written down while it is fresh.

### M10 — `fail()` silently fails to close the socket, and reflects the payload back pre-auth

**Severity:** major
**Where:** `src/connection.js:18-21`, `src/protocol.js:75`

```js
const fail = (code, message) => {
    try { ws.send(JSON.stringify(msg.error(message, true))); } catch { }
    try { ws.close(code, message); } catch { }     // ← swallows the failure
};
```

`validateC2S`'s fallback error is `` `unknown type "${type}"` `` and `type` is an arbitrary
client string up to `maxPayload` (4 MB). The WebSocket close *reason* is capped at 123 bytes;
`ws` throws `RangeError` above that (`node_modules/ws/lib/sender.js:197`). The `catch {}`
eats it, so **the connection is not closed** — while the contract the tests assert
("a bad frame closes the connection") is silently violated.

**Verified**, no token, pre-auth: five 1 MB frames of `{"type":"AAAA…"}` produced a ~1 MB
error message reflected back to the peer and `closed === null` throughout; the socket
survived until the 10 s hello timeout finally closed it with a short reason. So an
unauthenticated peer gets both a reflector and an extended hold on server resources.

The same pattern means every `fail()` in this file is best-effort in a way the code does not
acknowledge. Cap the reason (`message.slice(0, 100)`), send the full text in the `error`
frame, and don't echo attacker-supplied strings back at all.

### M11 — `uncaughtException` is swallowed and `/healthz` always answers `ok: true`

**Severity:** major
**Where:** `server.js:219-220`, `:150-151`

```js
process.on("uncaughtException", (e) => log.error(`UNCAUGHT: ${e.stack || e.message}`));
```

The comment says "a bug in one connection must never take the process down with it". The
effect is that the process keeps running in a state Node explicitly documents as undefined,
with no way for anything outside to notice: `/healthz` hard-codes `ok: true` and returns 200
regardless. Combined with M8 (no `Restart=always` unit) and M1 (an easy way to *reach* an
uncaught exception), the deployment story is a process that can wedge, keep passing its own
health check, and never be restarted. That is close to the 69 GB incident R1.8 was written
about: the failure was not the exception, it was that nothing noticed.

At minimum, `/healthz` should degrade after an uncaught exception, and the handler should
log and then exit so the supervisor (once it exists) does its job.

### M12 — No per-session serialization: turns interleave and `state.busy` lies

**Severity:** major (for PRD 3; benign today)
**Where:** `src/connection.js:36`, `:59-64`

`ws.on("message", async …)` awaits `handler.onMessage` but nothing serializes concurrent
messages on a session. **Verified** — three `say` frames sent back to back:

```
seq 2 state busy=true    seq 3 state busy=true    seq 4 state busy=true
seq 5 text "echo: A"     seq 6 state busy=false
seq 7 text "echo: B"     seq 8 state busy=false
seq 9 text "echo: C"     seq 10 state busy=false
```

`state` is a per-turn announcement, not a session state machine: after seq 6 the client shows
idle while two turns are still running. With real Claude Code workers (PRD 3) two overlapping
turns on one session means interleaved model output, ambiguous `interrupt` semantics, and a
routing decision made against a `worker` field another turn is concurrently changing. A
per-session queue belongs here, in PRD 1, where the session object already is — not bolted on
in PRD 3.

---

## MINOR

### m1 — Static root escapes through symlinks and serves dotfiles
`server.js:104-132`. The check is purely lexical; there is no `realpath` comparison, and the
comment at `:105-106` ("normalising alone is not enough to prove it did not") claims a
stronger guarantee than the code delivers. **Verified:** a symlink in the root to a file
outside it is served (`/leak.txt` → `secret-outside-root`), a symlink to `/etc` serves
`/etcdir/hostname`, and `/.env` is served with its contents. Vite builds do not produce
symlinks, so this is only reachable if `--static` points somewhere hand-assembled — but the
404-falls-back-to-`index.html` rule means nobody will ever notice a misconfigured root.

### m2 — Non-SNI clients never see a renewed certificate
`server.js:167-172`. `cert`/`key` are read once into the server options; `SNICallback` only
runs when the client sends a servername. **Verified:** after an in-place cert swap, an SNI
handshake returned `CN=renewed.example` while `-noservername` still returned
`CN=first.example`. Browsers and the Even Hub client all send SNI, so this is a corner — but
a 90-day Let's Encrypt cert against a process meant to run for months will eventually serve
something expired to whatever does not.

### m3 — A handshake during the certbot swap window fails instead of falling back
`server.js:80-93`. `secureContext()` does two `statSync` calls per handshake; if either
throws (the brief window where certbot has the file open/renamed), the `catch` passes the
error to `cb` rather than returning the cached `certCache.ctx`. **Verified:** with the cert
briefly moved away, the handshake fails with `no peer certificate available` and the server
logs `WARN client error: ENOENT` — attributing a server-side problem to the client, which is
exactly the wrong breadcrumb at renewal time. Falling back to the last good context is both
safer and what the cache is for.

### m4 — The token is a command-line flag and is printed to the log
`server.js:46`, `:61`, `:201`. R1.7 says the token is *"stored in a root-only file, exposed
through systemd's `EnvironmentFile`, **never on a command line**"*. `--token <hex>` is the
first documented option in `--help`, is what the test harness uses, and is visible in `ps` to
every user on the box. The env var path exists and is correct — the flag should at least
carry a warning, or be dev-only. Separately, a generated token is written to the log at
`:201`, which under the R1.8 configuration means a secret in a long-lived log file.

### m5 — Token comparison is not constant time, contrary to its own comment
`src/connection.js:71-72`. `m.token === config.token` short-circuits on the first differing
byte, and the length pre-check leaks the length. The comment says "constant-time-ish … avoids
leaking it through early-exit timing", which is the opposite of what the code does. Over a
network the attack is impractical; the *comment* is the bug, because it will be believed.
`crypto.timingSafeEqual` on equal-length buffers costs nothing.

### m6 — `console.error` in the persistence path bypasses the protected logger
`src/sessions.js:139`, `:145`. `src/log.js` exists precisely because a raw `console.*` threw
`EIO` into a request path and wrote 69 GB. These two call sites are raw `console.error`, in
the one code path that runs on every single emitted message, with no try/catch and no
timestamp. They also spam without bound: the C1 probe produced one line per message
indefinitely. If `console.error` itself throws, it propagates out of `appendEvent` → `emit` →
the handler's catch at `connection.js:63`, which calls `emit` again and throws again.

### m7 — `--ping abc` → `NaN` → a ping every 1 ms, per connection
`server.js:67`, `src/connection.js:30-34`. `parseInt("abc")` is `NaN`, and
`setInterval(fn, NaN)` is coerced to 1 ms. **Verified:** `setInterval(…, NaN)` fired 5 times
in 7 ms. A typo in the unit file turns the keepalive into a busy loop hammering every client.
`--port abc` has the same shape: `listen(NaN)` binds a random port and the service is
unreachable with no error. Validate both.

### m8 — Dev-proxy mode cannot carry Vite's HMR WebSocket
`server.js:134-143`, `:181`. `proxyToDev` handles HTTP only; `WebSocketServer({ path: "/ws" })`
destroys any upgrade to another path. **Verified:** an upgrade to `/vite-hmr` closes with
1006. R1.2 offers dev-proxy as a mode; without HMR it is a worse `--static`. PRD 4 is written
in Vite + TypeScript, so this lands the day the client work starts.

### m9 — `ready` deviates from the R1.6 table: `seq` renamed, `workers[]` missing
`src/protocol.js:85`, `:20`. The spec's payload is `{ sessionId, seq, worker, workers[] }`.
The implementation sends `{ sessionId, cursor, protocol, worker, mode, resumed, missed, gap }`.
The `seq`→`cursor` rename is deliberate and well argued in the comment at `:81-84` — but the
PRD is the shared contract and was not updated, so a client written from the PRD looks for
the wrong field. `workers[]` is simply absent and never populated (grep: the identifier
appears only in a comment), which PRD 4's session picker needs.

### m10 — Dead `catch` in `emit`; no backpressure anywhere
`src/sessions.js:47-50`. `ws.send()` on a non-OPEN socket does not throw — `ws` routes it to
`sendAfterClose`, which without a callback does nothing at all except inflate
`_sender._bufferedBytes` (`node_modules/ws/lib/websocket.js:1138-1159`). So
`catch { this.sockets.delete(ws) }` never runs; the real cleanup is the `close` handler, and
the comment on `:49` describes a mechanism that does not exist. More importantly, nothing
checks `ws.bufferedAmount` before sending. A phone on a stalled mobile link makes the server
buffer without limit in memory — and PRD 5 wants to push audio down this same path.

### m11 — Nothing bounds sessions, replay memory, or transcript growth
`src/sessions.js:17`, `:100-110`; `src/connection.js:49`. **Verified:** 60 sessions created
in 856 ms from one client, two files each, nothing evicted, `/healthz` reporting 65. There is
no cap, no LRU, no expiry, and `#loadAll` reads every meta file synchronously at boot, so
startup time and resident memory grow forever. `REPLAY_DEPTH` is 500 *messages* with no byte
budget, and `say` accepts 100 000 characters — 50 MB of replay buffer per session at the
limit. Malformed frames are also persisted (M6), so an authenticated client can grow the
transcript at line rate.

### m12 — Synchronous filesystem I/O on the only event loop that carries the conversation
`server.js:115`, `:118`, `:125`; `src/sessions.js:44-45`. Every HTTP request does
`statSync` + `existsSync` + a whole-file `readFileSync`; every emitted message does an
`appendFileSync` **plus** a full meta rewrite **plus** a `rename`. PRD 0 puts TLS, static
hosting, the WebSocket, MCP, worker lifecycle and STT in this one process. A 5 MB wasm blob
being fetched blocks every conversation for the duration of the read, and PRD 3's
token-by-token streaming means one file rewrite and one rename **per token**. The meta only
needs writing when `seq` matters (on reconnect, on shutdown) or on a timer.

### m13 — No `X-Forwarded-For` handling, though R1.4 names the proxy topology as the fallback
`src/connection.js:13`. `peer` is `req.socket.remoteAddress`. R1.4's documented fallback is
"plain HTTP on loopback behind a raw TLS bridge" — under which every log line reads
`127.0.0.1` and the connection logs R1.8 asks for become useless in exactly the deployment
the PRD says to expect.

### m14 — No `Origin` check on the WebSocket upgrade
`server.js:181-182`. Any web page in Robin's browser can open `wss://<host>/ws`. Not directly
exploitable — the credential is a bearer token in `hello`, not a cookie, so a cross-origin
page has nothing to replay — but it does mean unauthenticated strangers can reach the hello
window (M10) from any page, and R1.2's rationale leans on same-origin.

---

## NITS

- **n1** `history()` reads the entire file into memory to return the last 200 lines
  (`sessions.js:152`). Fine at 500 lines, not at a year of conversation.
- **n2** `server.on("error")` calls `process.exit(1)` for *any* server error, not just the
  two it diagnoses (`server.js:188-193`).
- **n3** `ws.sessionId = session.id` (`connection.js:81`) is set and never read.
- **n4** British spellings in comments — "normalising" (`server.js:106`), "honour"
  (`handler.js:7`), "behaviour" (`run.mjs:73`) — against the American-spelling convention.
- **n5** `harness.mjs:25` picks a random port in 34000–34999 with no collision retry, and
  `restart()` (`:66-77`) does not verify the replacement process actually came up — it loops
  for 10 s and returns regardless.
- **n6** `protocol.js` ships no types and no server→client validator. PRD 4's client is
  TypeScript; "a single shared schema file that both server and client import" will import
  as `any` unless a `.d.ts` or JSDoc types come with it.

---

## Verified as genuinely working

Not everything here is broken, and several things are better than they had to be.

- **V1 — Auth ordering is correct (R1.7, acceptance 6).** The token is checked at
  `connection.js:72`, before `store.getOrCreate` at `:79`. A bad token creates no session —
  confirmed against `/healthz` (`sessions: 0`) — and closes with 4001. A wrong protocol
  version closes with 4002, and a non-hello first message closes with 4002. `/healthz` is the
  only unauthenticated surface, as specified.
- **V2 — A turn genuinely survives a dropped connection (R1.3).** Killing the socket
  mid-turn and reconnecting with `resumeFrom` delivers the reply. `onClose` deliberately
  cancels nothing (`connection.js:115-118`), and the session — not the connection — owns the
  state. This is the design decision the whole phase rests on and it is right.
- **V3 — Replay while the buffer holds is correct.** `replay(from)` returns `> from` with no
  off-by-one, `replayGap`'s `recent[0].seq - 1` boundary is exactly right, and `ready` is
  sent through the connection's own `send()` rather than `emit()` so it neither consumes a
  seq nor reaches other clients — with a comment explaining why. Multi-client fan-out
  delivers identical `seq` to both, verified.
- **V4 — Certificate reload works for SNI clients (R1.1, acceptance 5).** Verified end to
  end: swapped cert and key in place, and the next SNI handshake served `CN=renewed.example`
  with `INFO certificate loaded` in the log. The mtime cache means it is not a disk hit per
  handshake. (Caveats m2, m3.)
- **V5 — The percent-encoded traversal defence is real.** `/%2e%2e%2f%2e%2e%2fetc%2fpasswd`
  returns 403. The `resolve` + `startsWith(root + sep)` check at `server.js:109` is the
  correct shape, including the `path.sep` that stops the `public-secret` sibling trick. Null
  bytes (`/foo%00.png`) do not escape. Only symlinks get past it (m1).
- **V6 — Keepalive and the hello timeout are sound.** The alive/ping/terminate pattern
  (`connection.js:29-34`) is the standard correct one, both timers are cleared on `close`,
  and a socket that never says hello is closed after 10 s. No timer, listener or socket leak
  found in `attachConnection` beyond M10's close-reason case.
- **V7 — Binary frames, malformed JSON and malformed shapes are handled distinctly and
  correctly.** Binary → 4003 with a reason. Broken JSON → close. Valid JSON with a bad shape
  after hello → an error frame and the connection survives, which is the right call and is
  properly tested. `validateC2S` never throws.
- **V8 — Duplicate hello is guarded** (`connection.js:54`) — though the error goes to the
  whole session (M6).
- **V9 — The meta write is atomic against a process crash** (temp file + `rename`,
  `sessions.js:132-141`), a corrupt meta file does not stop the server booting (`:94`), and a
  torn final JSONL line is dropped on read (`:155`). The intent of the storage design is
  right; M2 is a missing reconciliation, not a wrong architecture.
- **V10 — `src/log.js` wraps `process.stdout.write` in try/catch**, which is the actual
  lesson of the 69 GB incident and is correctly applied — everywhere except `sessions.js`
  (m6).
- **V11 — The handler seam is clean.** `createEchoHandler` has a documented three-method
  contract, and `connection.js` wraps `onMessage` in try/catch so a handler throw costs one
  error frame rather than the process. PRD 3 can drop in behind it without touching transport.
- **V12 — `longevity.mjs` is a well-built instrument for R1.4.** It proves traffic flowed
  rather than only that the socket was open, and it names the ~30 s signature explicitly so
  the result is interpretable by someone who does not know the history. It just has not been
  run against the thing that matters (phone, mobile data, real hostname) — and until it has,
  R1.4 and acceptance criterion 2 are open.

---

## Suggested order of work

1. **C1** — validate `sessionId` as a UUID and assert the resolved path stays in the data
   dir. One function, closes an arbitrary-write primitive.
2. **M1** — wrap `decodeURIComponent` in try/catch and return 400. Two lines, closes an
   unauthenticated hang.
3. **M2 + M3** — reconcile `seq` from the JSONL on load; make `replayGap` return true for
   `from > this.seq`. Together these are the difference between acceptance criterion 3 being
   true and being true-when-nothing-goes-wrong.
4. **M4 + M7** — fix the flaky test, then make the replay and traversal assertions capable of
   failing. Until then the suite is not evidence.
5. **M6 + M12** — per-connection `send` for per-connection messages, and a per-session turn
   queue. Both get much more expensive after PRD 3 is written on top of them.
6. **M5, M8, M9** — wire `list`/`delete`/`history` to `control` actions, write the systemd
   unit and the ACL notes, add the missing log lines and `worker` to `/healthz`.
7. **R1.4** — run `longevity.mjs` from the phone, over mobile data, through the real
   hostname, for 10 minutes. It is the one thing in this phase that can still invalidate the
   design, and it is the one thing still untested.
