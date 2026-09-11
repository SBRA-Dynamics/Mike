# Jarvis

Talk to Claude Code from a pair of Even Realities G2 glasses — or from a browser
tab — without holding a button, without a phone app in the way, and without
anything leaving the house.

One long-lived agent, **Jarvis**, is who you reach. He delegates real work to
**workers**: named Claude Code sessions with their own model, directory and
transcript. You switch between them by speaking. He can see what they are doing
and act on it.

```
glasses / browser ──ws──► server ──► Jarvis (opus) ──MCP──► spawn/switch/leave/end workers
                             │                                      │
                             ├── whisper on the GPU                 └── workers (claude -p)
                             └── sessions, transcripts, replay
```

## Status

| phase | what | state |
|---|---|---|
| **1** | Server: TLS, HTTP, WebSocket, sessions, replay, auth | built, running |
| **2** | MCP tool surface in the same process | built, running |
| **3** | Jarvis + workers, routing, context injection, handoff | built, running |
| **4** | Even Hub client: lens view + companion view | built, running |
| **5a** | Voice from the browser: VAD, segments, whisper, addressing modes | built, running |
| **5b** | Voice from the glasses' own microphones | not started |

The reasoning for each lives in [`PRD/`](PRD/), one document per phase. They are
the design record, not a summary of the code — read the relevant one before
changing anything, especially the "why" paragraphs, which exist because the
obvious alternative was tried and measured.

## Running it

```bash
npm install
npm run build:client          # the Even Hub client, built into ./public
npm start                     # http://localhost:3460, token printed on first run
```

Voice also needs the transcription service:

```bash
npm run whisper               # faster-whisper large-v3-turbo on the GPU, loopback 3461
```

The two do not start each other. The model takes a second to load and should
outlive a server restart, and a server whose ears are down says so in one line
rather than refusing to run.

`node server.js --help` lists every flag. The ones that matter most:

- `--engine stub` — run the whole system without spending money
- `--handler echo` — pin the transport without a model at all
- `--worker-perms readonly|edits|full` — what a worker may do (see below)
- `--whisper off` — no voice

## Deployment

Two systemd units, both included:

```bash
sudo cp jarvis-server.service services/whisper/jarvis-whisper.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now jarvis-whisper jarvis-server
```

The server reads its bearer token from `/etc/jarvis.env` (root-only, never on the
command line where `ps` would show it) and serves the client from `./public` over
TLS. The client is handed the token once, in a link, and keeps it in SDK storage.

**`--worker-perms full` is the riskiest line in the unit file.** It runs worker
turns with `--dangerously-skip-permissions`, so on an internet-facing listener the
bearer token becomes the ability to run code on the machine. It is deliberate and
it is not the default.

## Testing

```bash
npm test              # six suites, no model, no money, no network
npm run test:browser  # headless Chrome, real client, real whisper, fake mic
npm run test:lens     # the EvenHub simulator, headless on Xvfb, real framebuffer
npm run test:live     # real claude, real money — the acceptance tests
```

`npm test` is ~635 assertions and runs in under a minute. The `claude` binary is
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

## Layout

```
server.js            entry point: TLS, HTTP, static, WebSocket, wiring
src/
  protocol.js        the versioned wire protocol, shared with the client
  sessions.js        durable sessions, JSONL transcripts, replay
  connection.js      one socket: handshake, auth, resume, keepalive
  handler.js         the conversation: routing, turns, notices
  jarvis.js          his identity, prompt and worker-context injection
  workers.js         the registry; workerEngine.js drives real sessions
  mcp.js tools.js    the tool surface Jarvis acts through
  routing.js         who an utterance is for, and the addressing modes
  whisper.js audio.js  transcription client and audio intake
client/              the Even Hub plugin: lens + companion, one build
prompts/             Jarvis's system prompt and the worker template, editable live
services/whisper/    the transcription service
PRD/                 why any of it is shaped the way it is
```

## Non-goals

Images on the lens, text-to-speech (the G2 has no speaker), transcription on the
phone, offline operation, and speaker identification as a security boundary —
the SDK says its own speaker tagging is not one.
