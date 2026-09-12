# Mike

Talk to Claude Code from a pair of Even Realities G2 glasses — or from a browser
tab — without holding a button and without a phone app in the way.

What stays on your machine: your voice, which is transcribed by whisper on the
GPU and never uploaded; the transcripts; and the route, which is your own server
and certificate rather than somebody's tunnel. What does not: the conversation
itself, because the thing doing the work is Claude Code, and every turn goes to
Anthropic like any other.

One long-lived agent, **Mike**, is who you reach. He delegates real work to
**workers**: named Claude Code sessions with their own model, directory and
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

## Running it

```bash
npm install                   # server and client dependencies; builds the client into ./public
npm run setup                 # the wizard: token, Claude Code, voice, autostart
npm start                     # the server, reading ~/.config/mike/env
```

`npm run setup` asks about everything a fresh clone cannot know: where
Claude Code is and where workers should work, what a worker may do, port and
TLS, whether to install the transcription service (a Python venv with
faster-whisper, about 2.5 GB with the CUDA libraries), and whether to install
two systemd units so it all starts at boot. Every answer has a default; the
answers land in `~/.config/mike/env`, which `npm start` and the units read.
Run it again to change something — the token is kept. `npm run setup --
--defaults` answers everything without asking (no voice, no autostart), and
`--dry-run` shows what would be written.

It also asks for the public URL the phone reaches the server at — by default
`https://<this machine's LAN address>:3456` — and ends by showing the pairing
link with the token as a QR code in the terminal: scan it with the app's
Scan QR button, or open the link once in a browser.

Voice needs the transcription service running as well:

```bash
npm run whisper               # faster-whisper large-v3-turbo, loopback 3461
```

The two do not start each other. The model takes a second to load and should
outlive a server restart, and a server whose ears are down says so in one line
rather than refusing to run.

`node server.js --help` lists every flag; each has a `MIKE_*` environment
variable, which is how the env file sets them. The ones that matter most:

- `--engine stub` — run the whole system without spending money
- `--handler echo` — pin the transport without a model at all
- `--worker-perms readonly|edits|full` — what a worker may do (see below)
- `--whisper off` — no voice

## Deployment

The wizard writes two systemd units to `~/.config/mike/systemd/` and, if you
say yes, installs and starts them with sudo. `mike-server.service` and
`services/whisper/mike-whisper.service` in the repository are the reference
deployment on kontoret, with TLS and `--worker-perms full`.

The server reads its bearer token from the env file (mode 600, never on the
command line where `ps` would show it) and serves the client from `./public`.
The client is handed the token once, in a link, and keeps it in SDK storage.

**`--worker-perms full` is the riskiest line in the unit file.** It runs worker
turns with `--dangerously-skip-permissions`, so on an internet-facing listener the
bearer token becomes the ability to run code on the machine. It is deliberate and
it is not the default.

## Testing

```bash
npm test              # seven suites, no model, no money, no network
npm run test:browser  # headless Chrome, real client, real whisper, fake mic
npm run test:lens     # the EvenHub simulator, headless on Xvfb, real framebuffer
npm run test:live     # real claude, real money — the acceptance tests
```

`npm test` is ~760 assertions and runs in about a minute. The `claude` binary is
replaced by [`test/fixtures/fake-claude.mjs`](test/fixtures/fake-claude.mjs),
which reproduces the half of the CLI that matters — including its nastier
behaviour, like reporting an API failure as exit 0.

Two conventions worth keeping:

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
src/
  protocol.js        the versioned wire protocol, shared with the client
  sessions.js        durable sessions, JSONL transcripts, replay
  connection.js      one socket: handshake, auth, resume, keepalive
  handler.js         the conversation: routing, turns, notices
  mike.js          his identity, prompt and worker-context injection
  workers.js         the registry; workerEngine.js drives real sessions
  mcp.js tools.js    the tool surface Mike acts through
  routing.js         who an utterance is for, and the addressing modes
  whisper.js audio.js  transcription client and audio intake
client/              the Even Hub plugin: lens + companion, one build
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
