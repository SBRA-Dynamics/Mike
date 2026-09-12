# PRD 1 — Server foundation

TLS, HTTP, WebSocket, static hosting, the wire protocol, auth, and operations.
Everything later phases stand on.

## Goal

One Node.js process that a browser, a phone or a pair of glasses can connect to
over the public internet, which serves the client to them and carries the
conversation both ways.

## Why this is its own phase

The previous attempt worked for a day and then spent an evening on transport
bugs that had nothing to do with the product: a stream cut at 30 s, a client
that would not render an unsolicited replay, a first message that arrived before
anyone was listening. Those are transport problems, and they are cheaper to
solve once, deliberately, than to patch under a feature.

## Requirements

### R1.1 — TLS

Serve HTTPS on a public port using Let's Encrypt certificates for a hostname the
user controls. Certificates must be re-read when certbot renews them, without a
restart. The process must not run as root; certificate files are made readable
through an ACL instead.

### R1.2 — Static hosting

Serve the built client (`dist/` from PRD 4) from the same origin as the
WebSocket. Same-origin removes CORS from the picture entirely and means the
client never needs a configured server address — it already knows where it came
from.

Dev mode may proxy to a Vite dev server instead.

### R1.3 — WebSocket as the only conversation channel

One bidirectional connection carries everything: user input, assistant output,
status, worker switches, transcription results.

This replaces the previous SSE-plus-POST split, which forced three workarounds:
a deferred first turn (the client posted before it was listening), a replay
buffer with a cursor, and a polling fallback that was never used. A single
duplex channel has none of those problems by construction.

Requirements:
- Ping/pong keepalive, interval configurable, default 20 s
- Automatic reconnect is the client's job; the server must make it cheap by
  accepting a `resumeFrom` sequence number and replaying only what was missed
- Every outbound message carries a monotonic `seq` per session
- A dropped connection must not disturb a running worker turn

### R1.4 — Transport risk: prove the stream survives

**This is the one thing in PRD 1 that can invalidate the design, and it must be
tested before anything is built on top.**

Measured previously: Node's `https.Server` terminated every long-lived SSE
stream at exactly 30 seconds over the phone's mobile path, with heartbeats
flowing and no error. A raw TCP TLS bridge in front of a plain HTTP server did
not. The mechanism was never identified.

Acceptance test: a WebSocket held open from the phone over mobile data, through
the real hostname and port, for **10 minutes**, with a message exchanged at the
start and end. If it dies, fall back to the proven topology — plain HTTP on
loopback behind a raw TLS bridge — and treat that as the supported deployment.

**Downgraded to a routine check (decided 2026-09-11).** Not a gate on the
phases after it. MyProject already holds WebSockets open indefinitely over the same
network to the same phone, which is the strongest evidence available, and the
suspected culprit — even-terminal's non-standard SSE client, which was never an
EventSource — is out of the system entirely. The one observation that does not
fit the client theory is that the A/B swapped the *server* front end with the
client unchanged and the stream went from 30 s to >90 s; so the honest reading
is an interaction, not a settled cause. WebSocket is a different mechanism from
SSE either way. Run the test when there are real turns to keep alive, not
echoes: `node test/longevity.mjs --url wss://<host>/ws --token <token>
--minutes 10` from the phone's network.

### R1.5 — Sessions

- A session has a stable id (UUID) chosen by the server
- Sessions survive a server restart: id, title, transcript, and which worker was
  active. Restarting must not lose a conversation
- Storage is a file per session; no database
- A session can be listed, resumed and deleted

### R1.6 — Wire protocol

JSON messages, versioned from day one, typed in a single shared schema file that
both server and client import. No field exists for compatibility with anything
external.

Client to server:

| type | payload | meaning |
|---|---|---|
| `hello` | `{ protocol, sessionId?, resumeFrom? }` | open or resume |
| `say` | `{ text }` | a user utterance, already text |
| `audio` | `{ pcm, final }` | a chunk of speech (PRD 5) |
| `interrupt` | `{}` | stop the current turn |
| `control` | `{ action, args }` | switch worker, list, delete |

Server to client:

| type | payload | meaning |
|---|---|---|
| `ready` | `{ sessionId, seq, worker, workers[] }` | connection accepted |
| `text` | `{ text, from }` | output, tagged with who said it |
| `state` | `{ busy, worker }` | turn and routing state |
| `heard` | `{ text, confidence }` | what STT understood (PRD 5) |
| `event` | `{ kind, data }` | worker created, switched, ended |
| `error` | `{ message, fatal }` | something went wrong |

`from` matters: the client must be able to show whether Mike or a worker is
speaking, and the lens has no room for a label unless it is short.

### R1.7 — Auth

A single shared bearer token, passed in the `hello` message and validated before
anything else. Stored in a root-only file, exposed to the process through
systemd's `EnvironmentFile`, never on a command line.

An unauthenticated `/healthz` for monitoring is the only exception.

### R1.8 — Operations

- systemd unit, `Restart=always`, starts at boot
- Logs to a real file, never to an inherited tty. A previous server wrote **69 GB**
  of one stacktrace because its stdout pointed at a terminal that had closed;
  every `console.log` threw `EIO` and requests silently never completed
- Structured log lines: connection open/close with reason, every inbound message
  type, every worker spawn/switch, turn duration
- `/healthz` returns uptime, session count, active worker

## Non-goals

- Multi-user, accounts, per-user tokens
- Horizontal scaling
- Any endpoint that exists only for a third-party client

## Acceptance criteria

1. `https://<host>/` serves the client over a valid certificate
2. A WebSocket opened from the phone over mobile data survives **10 minutes**
3. Killing the connection mid-turn and reconnecting with `resumeFrom` replays
   exactly what was missed, once
4. Restarting the service keeps session list and transcripts intact
5. A certbot renewal is picked up without a restart
6. Bad token is refused before any session is created
7. The service starts at boot and recovers from a crash within 5 s

## Open questions

- Keep driving Claude Code through the **CLI** (`claude -p --output-format
  stream-json`), which is proven, or move to the Agent SDK? The CLI needs no
  dependency and gives `--resume` for free. Default: CLI, revisit in PRD 3.
- Session storage format: JSONL per session, or a single file per session with
  the full state? JSONL appends cheaply and survives partial writes.
