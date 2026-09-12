# Mike

Talk to Claude Code from a pair of Even Realities G2 glasses — or from a browser
tab — without holding a button and without a phone app in the way.

What stays on your machine: your voice, which is transcribed by whisper on the
GPU and never uploaded; the transcripts; and the route, which is your own server
and certificate rather than somebody's tunnel. What does not: the conversation
itself, because the thing doing the work is Claude Code, and every turn goes to
Anthropic like any other.

One long-lived agent, **Mike**, is who you reach. He is Mycroft Holmes IV from
*The Moon Is a Harsh Mistress*, or as near as this machine gets: he calls you
Man, he answers "Hello, Man" when you call his name, and he delegates real work
to **workers** — named Claude Code sessions with their own model, directory and
transcript. You switch between them by speaking. He can see what they are doing
and act on it.

```
glasses / browser ──ws──► server ──► Mike (opus) ──MCP──► spawn/switch/leave/end workers
                             │                                      │
                             ├── whisper on the GPU                 └── workers (claude -p)
                             └── sessions, transcripts, replay
```

## Status

| phase | what | state |
|---|---|---|
| **1** | Server: TLS, HTTP, WebSocket, sessions, replay, auth | built, running |
| **2** | MCP tool surface in the same process | built, running |
| **3** | Mike + workers, routing, context injection, handoff | built, running |
| **4** | Even Hub client: lens view + companion view | built, running |
| **5a** | Voice from the browser: VAD, segments, whisper, addressing modes | built, running |
| **5b** | Voice from the glasses' own microphones | built; needs a hardware session |
| **6** | Waiting: streamed answers, named turns, and the client hang | built; the hang is found and fixed |

The reasoning for each lives in [`PRD/`](PRD/), one document per phase. They are
the design record, not a summary of the code — read the relevant one before
changing anything, especially the "why" paragraphs, which exist because the
obvious alternative was tried and measured.

## Installing

You need:

- **Node 22.18 or later.**
- **Claude Code**, logged in, with a subscription that covers it: every turn Mike
  or a worker takes is a `claude` invocation on this machine.
- For voice, **Python 3 with `venv`** and ideally an **NVIDIA GPU**. faster-whisper
  runs on a CPU too, slower.
- Optionally **systemd**, to start at boot, and a **TLS certificate** if the phone
  is going to reach the server from outside your LAN.

Then:

```bash
git clone <this repository> mike && cd mike
npm install        # server and client dependencies; builds the client into ./public
npm run setup      # the wizard — see below
npm start          # the server, unless the wizard installed it as a service
```

### The wizard

`npm run setup` asks about everything a fresh clone cannot know. Every question
has a default in brackets, so Enter is usually the answer.

| it asks | what it means |
|---|---|
| **path to `claude`** | the binary Mike and the workers run; found on `PATH` |
| **directory workers start in**, and Mike's own | where a new worker's Claude Code session runs; `dirs.json` adds spoken names for others |
| **worker permissions** | `readonly` reads and runs read-only commands; `edits` may change files; `full` runs with your user's full power — see the warning under Deployment |
| **models** | Mike's (opus) and a worker's default (sonnet) |
| **port, bind address, TLS** | what the server listens on; a certificate and key make it HTTPS |
| **public URL** | what the *phone* connects to — a router forward, a hostname, or this machine's LAN address; default `https://<LAN address>:3456` |
| **transcription service** | whether to create the Python venv with faster-whisper (about 2.5 GB with the CUDA libraries), and on which device |
| **start at boot** | whether to write two systemd units, install them with sudo and start them now |

The answers land in `~/.config/mike/env` (mode 600; the token is in it), which
`npm start` and the systemd units both read. Every server flag has a `MIKE_*`
variable, so anything the wizard did not ask about can be added there by hand;
`node server.js --help` lists them. Run the wizard again to change something —
the token is kept.

It ends by printing the pairing link and showing it as a QR code in the
terminal. For scripts, `npm run setup -- --defaults` answers everything without
asking (no voice, no autostart) and `--dry-run` shows what would be written.

### Pairing the phone

Install the Mike app in the Even Hub app on the phone. On its first start it
shows one button, **Scan QR**: point the camera at the code the wizard printed
(or run `npm run setup` again to see it), and the app has the server's address
and the token. Nothing else is configured on the phone — there is no settings
screen. Opening the link once in an ordinary browser pairs that browser the
same way.

To build the app yourself, `cd client && npm run pack` produces `mike.ehpk` from
`client/app.json`; the icon (`client/icon-moon-24.txt`, with the pixels listed
row by row), the description and the screenshots for the store listing are in
`client/` too.

### Running by hand

```bash
npm start          # the server, reading ~/.config/mike/env
npm run whisper    # the transcription service, loopback port 3461
```

The two do not start each other. The model takes a second to load and should
outlive a server restart, and a server whose ears are down says so in one line
rather than refusing to run. Flags worth knowing:

- `--engine stub` — run the whole system without spending money
- `--handler echo` — pin the transport without a model at all
- `--worker-perms readonly|edits|full` — what a worker may do
- `--whisper off` — no voice

## Using it

**Say his name.** In the default mode, *by name*, only sentences that start with
"Mike" or the active worker's name are sent on; everything else in the room is
dropped, and the lens says so. "Mike" on its own is a call: he answers at once,
without a model turn — "Hello, Man." — and the next thing you say is his even
without the name. The other modes are *always* (everything reaches a model),
*hold to talk* (the microphone is open only while the touchpad is held) and
*paused*.

**Workers.** "Mike, start a worker on the firmware" spawns one and switches you
to it; you are talking to the worker from then on, and "Mike, …" still reaches
Mike. A worker you do not name gets one from the book — Wyoh, Prof, Mannie, Mum,
Grandpaw, Milla, Greg, Hans or Sidris, whichever is free. Switch, leave, end,
rename and read workers by asking Mike.

**Spoken commands**, matched before anything else, in every mode, in Swedish or
English — so there is no state you cannot talk your way out of:

| say | does |
|---|---|
| "pause input", "stop listening" / "continue input" | pause and resume |
| "change input to always / by name / push to talk" | the addressing mode |
| "mic on", "mic off" | the microphone switch |
| "display on", "display off" | the lens; off stays off until you say on |
| "stop", "cancel", "avbryt" … | kill the running turn and drop what was queued |
| "null program" | the same, in Mike's words: forget the job, stand by |

**The touchpad.** A tap is the microphone switch (or, on a dark lens, just
lights it); swipes page through a long reply; a hold is push-to-talk in every
mode; a double tap is the system's exit dialog.

**The lens** is a window: a title bar with who you are talking to, the status
("thinking 12s", "still listening", "Wyoh asks"), the page counter, and at the
right end a mark for the microphone — ● hearing, ○ not. Thirty seconds after the
last thing said or heard it goes dark; a reply, your voice, or a tap lights it
again. Mike's asides while you are talking to a worker appear under the worker's
name as "Mike: …", so the title bar always says who your next sentence goes to.

**The phone** shows the same frame the glasses get, the transcript, a text box
for typing to Mike, and the microphone controls. Typed lines skip the addressing
gate — typing is already aimed at the machine.

## Deployment

The wizard writes two systemd units to `~/.config/mike/systemd/` and, if you
say yes, installs and starts them with sudo. They run as your user, read
`~/.config/mike/env`, restart on failure and log to `~/mike-server.log` and
`~/mike-whisper.log`. `mike-server.service` and
`services/whisper/mike-whisper.service` in the repository are the reference
deployment on kontoret, with TLS from certbot and `--worker-perms full`.

The server reads its bearer token from the env file, never from the command
line where `ps` would show it, and serves the client from `./public`. The client
is handed the token once, in a link, and keeps it in SDK storage.

**`--worker-perms full` is the riskiest setting there is.** It runs worker turns
with `--dangerously-skip-permissions`, so on an internet-facing listener the
bearer token becomes the ability to run code on the machine. It is deliberate
and it is not the default.

## Testing

```bash
npm test              # eight suites, no model, no money, no network
npm run test:browser  # headless Chrome, real client, real whisper, fake mic
npm run test:lens     # the EvenHub simulator, headless on Xvfb, real framebuffer
npm run test:live     # real claude, real money — the acceptance tests
```

`npm test` is ~1040 assertions and runs in a few minutes. The `claude` binary is
replaced by [`test/fixtures/fake-claude.mjs`](test/fixtures/fake-claude.mjs),
which reproduces the half of the CLI that matters — including its nastier
behaviour, like reporting an API failure as exit 0. The voice fixtures under
`test/fixtures/voice` are Swedish speech from piper; `test/voice.mjs` says how
to make more.

Conventions worth keeping:

- **Every assertion must be falsifiable.** New tests are checked against
  deliberately broken source before they are kept, and the commit says which
  mutations were run. A test that cannot fail is worse than no test, because it
  buys confidence it has not earned.
- **A suite must leave nothing behind.** Servers, browsers, simulators and
  `claude` children are all tracked and reaped; the suites assert it.
- **We do not open the microphone in the simulator.** With
  `--aid alsa:null`, simulator 0.9.5 sends audio at ~170× real time, and
  `audioControl(false)` does not always stop it. When it doesn't, the
  simulator grows by ~700 MB/s until the kernel kills it. When a worker
  starts it, it runs in mike-server's cgroup, so the kernel took the
  whole service down with it, three times on 2026-09-12, turn and all. This
  was reproduced with a 40-line page that has no Mike code, so it is not
  the client, and nothing on our side fixes it. The glasses microphone is
  tested on the glasses, and in the unit suites against a stand-in bridge.
  `test/prd5b-lens.mjs` still opens it and must not be run until that part
  is taken out.

## Things that were measured, not assumed

- **Two drivers of one Claude Code session silently lose turns.** A terminal and
  the server both `--resume`ing the same id do not error and do not corrupt — the
  transcript becomes a tree and one branch wins. So a worker id handed to a
  terminal is a baton, not a second seat (PRD 3, "PC ↔ glasses handoff").
- **The lens is 576×288 with a proportional font.** Fifty `i` is 249 px and fifty
  `W` is 800 px, so wrapping at 50 columns is not enough — the client enforces
  both a column and a pixel budget, or the glasses re-wrap where the preview
  never showed (PRD 4 R4.2).
- **Whisper answers in 300–360 ms** for realistic utterances on a 5060 Ti,
  against an 800 ms budget. A fixture that repeats one sentence measures 1.4 s,
  which is the model's repetition collapse rather than the service.
- **An image on the lens costs ~1.4 s.** Text is the only interactive channel.
- **A hold window measured from transcript to transcript merges almost
  nothing.** The second half of a sentence has to be finished, go quiet for
  the hangover and be transcribed before it can arrive, so its own length
  counts against the window: 3 merges in 40 spoken turns in the server log,
  and the one that merged had 25 ms to spare. The client now reports its
  detector opening and closing a segment (`speaking`), and the window stops
  counting while somebody is talking into it (PRD 6, item 7).
- **One frame of zeros took the noise floor to its minimum in a single step,
  and it stayed there.** The floor fell by half the distance to every quieter
  frame, so a BLE gap padded with zeros put it at -70 dB; room tone was then
  9 dB above it, a segment opened, and a floor that did not move while a
  segment was open never recovered. On the glasses that was every segment
  exactly 15 000 ms long, words arriving 5–6 s late and syllables cut at the
  boundary. The floor now follows the quietest frame of the last 1.5 s,
  ignores dropouts, and keeps following the room while a segment is open
  (PRD 6, item 8).
- **Opening the glasses microphone costs ~180 ms**, and the first audio frame
  lands ~3 ms after that — measured through the simulator's own Flutter bridge
  (`openMs=181 leadInMs=184`), against the ~160 ms fixed per-SDK-call cost
  measured on the hardware. A push-to-talk user who speaks as they press loses
  about a fifth of a second, which is why the lens says "opening" before it says
  "held" (PRD 5b R5b.3).
- **`audioControl(false)` answers `false` even when it really stopped.** Only the
  answer to an OPEN is worth reading; treating the close's answer as a failure
  would put a red error on the lens every time the user let go.
- **`audioControl(true, Glasses)` really is refused before the startup page
  exists** — R5b.1's sequencing constraint, observed rather than assumed, which
  is why the phone microphone is the fallback rather than a failure.
- **The system exit dialog swallows `LONG_PRESS_RELEASE`.** A hold that is never
  released is a microphone left running on somebody's face, so any other gesture
  ends a hold.
- **`LONG_PRESS_EVENT` is 9 and `LONG_PRESS_RELEASE_EVENT` is 10**, they arrive
  separately, and the simulator's `/api/input` accepts `long_press` and
  `long_press_release`. None of that is in either set of documentation; the
  0.0.15 typings and the simulator binary agree with each other.
- **The Even App's console is bridged through a promise nobody owns, so a global
  error handler that logs is a loop.** `flutter_inappwebview` replaces
  `console.error` with one that ships the line to the host through
  `callHandler`; that returns a promise, nothing awaits it, and when it rejects
  the rejection is unhandled — which calls the handler, which logs, which
  rejects. Counted in the server's log at 588 identical reports in one second,
  three separate times, each ending in a dead socket. The report path now rate
  limits itself before it touches the console, and `test/prd4-browser.mjs`
  builds the same bridge in a real browser so it cannot come back (PRD 6).

- **The SDK's timers are not the browser's, and a chain that re-arms itself is
  an infinite loop on them.** `@evenrealities/even_hub_sdk` 0.0.15 replaces
  `window.setTimeout` and friends with "shadow timers" the host ticks through
  `__tickShadowTimers`. The tick iterates a Map while callbacks run, a Map
  visits entries added during iteration, so a callback that re-arms itself
  with a delay shorter than the tick's elapsed time is fired, re-armed and
  fired again inside one call that never returns. The lens repaints once a
  second while a turn runs, so this was "the app hangs after the first
  sentence, and the phone gets hot". The same layer fires one-shots twice,
  which is where the multiplying heartbeat came from. The client now keeps
  its own handles on the host's timers (`client/src/timers.ts`) and
  `test/prd6-timers.mjs` holds the shipped SDK to that description (PRD 6).

## Layout

```
server.js            entry point: TLS, HTTP, static, WebSocket, wiring
scripts/setup.mjs    the wizard; postinstall.mjs builds the client on npm install
src/
  protocol.js        the versioned wire protocol, shared with the client
  sessions.js        durable sessions, JSONL transcripts, replay
  connection.js      one socket: handshake, auth, resume, keepalive
  handler.js         the conversation: routing, turns, notices
  mike.js          his identity, prompt and worker-context injection
  workers.js         the registry; workerEngine.js drives real sessions
  mcp.js tools.js    the tool surface Mike acts through
  routing.js         who an utterance is for, the addressing modes, the commands
  names.js           spoken names, folded for matching; the book's names
  whisper.js audio.js  transcription client and audio intake
client/              the Even Hub plugin: lens + companion, one build
  src/lens/render.ts     the frame: title bar, body, bottom edge, both budgets
  src/state.ts           one model, two faces: what the lens and the phone show
  src/audio/segment.ts   PCM in, utterances out — no browser, no clock, no SDK
  src/audio/capture.ts   the browser's microphone; glasses.ts the glasses'
  src/audio/voice.ts     the addressing modes, with either microphone behind them
prompts/             Mike's system prompt and the worker template, editable live
services/whisper/    the transcription service
PRD/                 why any of it is shaped the way it is
```

Ideas with no home yet are in [`IDEAS.md`](IDEAS.md), with the reasoning
attached so it does not have to be worked out twice.

## Non-goals

Images on the lens, text-to-speech (the G2 has no speaker), transcription on the
phone, offline operation, and speaker identification as a security boundary —
the SDK says its own speaker tagging is not one.

## Still to measure, on a face

PRD 5b's risk table is the only part of the system that cannot be settled at a
desk. The client prints one line per change of microphone state and one per
thirty seconds of captured audio, so a session is "wear them, hold the touchpad,
read the log":

```
[mike] mic listening glasses held=true live=true tracks=1 sent=0 \
         frames=300 bytes=960000 openMs=181 leadInMs=184 roles=0/0/300 dropped=0
```

- **Battery** — `Always`, 30 minutes, battery before and after. Kills always-on.
- **Bandwidth** — `bytes` over the same session against the ~100 KB/s BLE budget,
  while the lens is also being updated. Kills continuous capture.
- **`speakerRole` accuracy** — `roles=self/other/unknown` with two people
  talking. The simulator reports `unknown` for every frame, so this number has
  never been seen. If `unknown` dominates, R5b.2's filter is decoration.
- **Lead-in** — `leadInMs` on a real BLE link, to decide whether a hold needs to
  keep the microphone open for a moment after the release. There is no such tail
  today, deliberately: it weakens exactly what PushToTalk promises, and nothing
  should weaken that on an unmeasured guess.
