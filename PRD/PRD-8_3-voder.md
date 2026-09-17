# PRD 8.3 — The voder

Speech out: Mike's and the workers' answers, spoken, on a device with a speaker.

In the book Mike hears through a *vocoder* and speaks through a *voder* — Heinlein
took both names from Bell Labs machines of 1938 and 1939, one that analyzed
speech and one that synthesized it. `mike-whisper` is the vocoder half and has
been running since PRD 5a. This is the other half.

## Goal

Mannie holds the watch, asks Bosse whether the tests pass, lowers the arm, and
hears *"Two failed, both in the handler suite"* from the wrist — and the same
answer is on the lens and the phone as text, as it is today.

## Scope

Server-side synthesis as a service next to whisper, one new message type, and
playback on the watch. The service and the message are **not** a watch feature:
the browser and the phone can play them too, and are given a switch for it here.
The glasses cannot, having no speaker.

Only answers are spoken. Not the transcript, not history, not mail read aloud.

## Why the service runs on this machine

PRD 0: *no speech sent to an external API*. That rule was written about the
microphone and applies at least as strongly to the answers, which are the
content of the work. Hosted TTS would be simpler and sound better, and is ruled
out for the same reason hosted STT was.

## Architecture

```
workerEngine / mike ──text──► handler ──► voder.js ──HTTP 127.0.0.1:3462──► mike-voder
                                   │            │                          (Python, own venv)
                                   │            └──► speech ──► connections that asked
                                   └──► text ──► every connection, as today
```

**mike-voder** is a systemd service like `mike-whisper`: a Python process on
loopback, warm, restartable on its own, and reached over HTTP for the reasons
`src/whisper.js`'s header gives — a GPU or model process that takes seconds to
load has no business inside Node, and a synthesis that wedges must be survivable
by killing one process.

The contract is as small as whisper's:

```
POST /speak      body: { text, voice, sampleRate }
                 -> 200, application/octet-stream: s16le mono PCM at sampleRate
                    X-Voder-Ms: synthesis time
GET  /voices     -> [{ id, language, sampleRate }]
GET  /healthz    -> { ok, engine, device, warm }
```

One sentence per request. Streaming inside a sentence is not worth a protocol:
a sentence is short, and the first one is what the latency budget is about.

## Requirements

### R8.3.1 — The engine

Chosen by the measurement in *Risks*, against three requirements that are not
negotiable:

1. **A Swedish voice and an English voice**, because Mannie speaks both and the
   answers follow.
2. **Local**, on the 5060 Ti or the CPU, with no network access at run time.
3. **Shares the GPU with whisper** (`large-v3-turbo`, float16) inside 16 GB,
   without either one being evicted.

Piper is the starting candidate: it runs fast on a CPU, which keeps it off
whisper's GPU entirely, and it ships a Swedish voice (`sv_SE-nst-medium`)
besides many English ones. Other engines are compared on the same sentences
before Piper is accepted; any candidate's Swedish support and its license
(code *and* voice model) are checked, not assumed.

### R8.3.2 — Which language

The voice follows the language of the answer, decided per answer, not per
session:

1. the language whisper reported for the utterance that started the turn, when
   the turn started from speech
2. otherwise a cheap text rule — Swedish letters and a short list of Swedish
   function words — on the answer itself
3. otherwise the configured default, `MIKE_VODER_LANGUAGE`

A wrong guess reads Swedish with an English voice, which is comic and
comprehensible. It is not worth a model call.

### R8.3.3 — What is spoken

| message | spoken |
|---|---|
| `text` from Mike or the active worker | yes |
| `text` with `background: true` | no — the user switched away on purpose (the lens's rule) |
| `text` with `command: true` (*Stopped.*, *Input: always.*) | no — the screen says it, and a spoken confirmation of *stop* is a contradiction |
| `error` | the first sentence, prefixed *Problem:* |
| `heard`, `progress`, `turn` | no |

Before synthesis the text is made speakable, in `src/speech.js`:

- Markdown is removed; list markers become pauses.
- A fenced code block becomes *"code on the screen"*, once per answer.
- A path or URL is reduced to its last part: `/home/robin/mike/src/handler.js`
  is spoken as *handler.js*, and a URL as its host. The exact rules are a table
  in the file, and tested.
- An answer is spoken up to 600 characters, cut at a sentence end, followed by
  *"the rest is on the screen"*. Answers are written for a 50 × 10 lens already,
  so this rarely triggers; when it does, a minute of speech is the wrong medium.

### R8.3.4 — When it is spoken, and the budget

Today the answer text arrives when the turn ends (PRD 6: `progress` carries the
text blocks as they are written, but the final answer is the process's
`result`). The voder speaks the final answer, so that intermediate narration
between tool calls — *"I'll read the file first"* — is never spoken.

It is split into sentences; the first is synthesized and sent at once, and the
rest follow in order. The budget, from `text` emitted to the first sample
leaving the server:

| stage | target |
|---|---|
| speakable text + first sentence split | < 20 ms |
| synthesis of a 12-word sentence | < 400 ms |
| total to first `speech` | **< 500 ms** |

### R8.3.5 — The wire

A new server-to-client type:

```js
S2C.SPEECH = "speech"
{ type: "speech", id, part, text, pcm, sampleRate, final }
```

- `id` names the answer (the `seq` of the `text` it speaks), `part` counts its
  sentences from 0, `final` marks the last one.
- `text` is the sentence, so a client can highlight what is being said.
- `pcm` is base64 s16le mono, like `audio` the other way.

It is sent only to connections that asked, with the connection's own `send`,
never `session.emit` or `session.transient`: audio is neither conversation
history nor something every attached device wants, and a 3 s sentence is 130 KB
of base64 that has no place in a 500-message replay buffer. A reconnect does not
replay speech; the text is replayed as always.

Asking is a control action, per connection:

```js
{ type: "control", action: "setSpeech", args: { on: true, sampleRate: 16000 } }
```

Speech follows the session, not the device a turn came from: an answer to a
line typed on the keyboard is spoken on a watch in the same conversation that
asked for speech. A keyboard can never ask — it is sent nothing — and
`src/devices.js` refuses `setSpeech` from one like any other control.

`sampleRate` is 16000, 22050 or 24000. The watch asks for 16000: its small
speaker gains nothing above that, and the shared I2S bus already runs at that
rate for the ES7210. A browser may ask for the engine's native rate. Off is the
default for every connection.

### R8.3.6 — Stopping

- `interrupt`, the spoken *stop*, and a new hold (PRD 8.2) stop the speech of the
  current answer: unsent sentences are dropped on the server, and the client
  stops playback the moment it acts, without waiting for the server.
- A new command, matched like the mode commands in every mode:
  *"quiet"* / *"tyst"* stops the speech and leaves the turn running.
- *"speech on"* / *"speech off"* (*"läs upp"* / *"sluta läsa upp"*) toggles
  `setSpeech` for the connection the command came from — which is the device the
  user is holding. Typed on the keyboard, it toggles nothing and says *say it on
  the device that should speak*: the keyboard has no speaker, and guessing which
  device was meant is the kind of cleverness that turns speech on in a meeting.

### R8.3.7 — Playback on the watch

- Playback goes out through the ES8311 while the ES7210 can keep capturing on the
  same bus (PRD 8.2 R8.2.1). A touch-down during playback stops playback at
  once, because the user who starts talking is done listening; capture starts
  without waiting for it, and the echo reference keeps the last syllables of
  the answer out of the segment.
- Parts are queued in PSRAM and played in order, with a 150 ms gap between
  sentences.
- The watch stays connected while an answer it asked to hear is being received
  and played (PRD 8.1 R8.1.8's rule, extended from `busy` to "speaking").
- Volume is the ES8311's output volume, starting at 80 and set by the
  measurement in *Risks*, adjustable by a swipe on the *last answer* screen
  while playing.

### R8.3.8 — Playback in the browser and the phone

The companion view gets a speaker toggle next to the microphone, sending
`setSpeech`, and plays parts through Web Audio. Whether the Even App's WebView
plays audio while the phone screen is off is unknown and measured before
promising it (*Risks*); if it does not, the toggle says *speech needs the phone
awake*.

### R8.3.9 — Honest degradation

A server whose voder is not running still starts and still answers in text. A
connection that turned speech on is told once, as
`event` `speechUnavailable` with a one-line reason, and not again until the
voder has been healthy and failed again. The answer text is never delayed by
the voder: `text` is emitted first, always, and synthesis runs after it.

### R8.3.10 — Operations

- `services/voder/serve.py`, `mike-voder.service`, loopback port 3462
- `npm run voder` for development, as `npm run whisper`
- the setup wizard asks, like it does for whisper, whether to create the venv,
  which engine and voices to download, and on which device
- `MIKE_VODER` (`http://127.0.0.1:3462` or `off`), `MIKE_VODER_LANGUAGE`,
  `MIKE_VODER_VOICE_SV`, `MIKE_VODER_VOICE_EN`
- the log line per sentence: characters, voice, synthesis ms — never the text

## Risks, to be measured before the engine is chosen

| risk | test | decides |
|---|---|---|
| **Swedish quality** | 20 answers taken from real transcripts, spoken by each candidate, listened to on the watch speaker and on headphones | the engine |
| **Latency** | synthesis ms per sentence for the same set, cold and warm, CPU and GPU | R8.3.4's budget, CPU or GPU |
| **GPU memory** | whisper and the voder loaded together, a turn running both | whether a GPU engine is possible at all |
| **The watch speaker** | the 20 answers at volume 60, 80, 100, at arm's length and at the ear | whether the watch speaks, or only the phone does |
| **Watch battery** | 30 answers played, current logged by the AXP2101 | the cost of speech against PRD 8.1's day |
| **WebView audio** | Web Audio playback with the phone locked, in the Even App | R8.3.8 |

## Acceptance criteria

1. With speech on, an answer from the active worker is heard on the watch; the
   same text appears on the lens and the phone at the same time as before
2. A background answer is not spoken; a command confirmation is not spoken
3. A Swedish answer is spoken with the Swedish voice and an English answer with
   the English one, in the same session
4. A new hold on the watch silences playback before capture starts
5. *"quiet"* stops speech and the turn continues to its answer on screen
6. First `speech` leaves the server within 500 ms of `text` for a one-sentence
   answer, measured over 20 turns
7. With `mike-voder` stopped, every answer still arrives as text, and the watch
   shows *speech unavailable* once
8. No `speech` message is ever written to a transcript or replayed after a
   reconnect
9. The log contains no answer text from the voder

## Files

```
services/voder/serve.py            the service
services/voder/mike-voder.service
src/voder.js                       client of the service, health, degradation
src/speech.js                      speakable text, sentence split, language rule
firmware/watch/main/playback.c     queue, stop on touch-down, volume
client/src/speech.ts               Web Audio playback and the toggle
test/voder.mjs                     speech.js tables, routing of setSpeech, what is and is not spoken
```

`src/protocol.js` gains `S2C.SPEECH` and `CONTROL.SET_SPEECH`; `src/routing.js`
the *quiet* and *speech on/off* commands; `src/handler.js` the hook after `text`
is emitted.

## Non-goals

- Voice cloning, a custom voice for Mike, or emotion. A clear voice first.
- Speaking while the answer is still being written. See *Open questions*.
- Reading mail, files or the transcript aloud.
- Speech on the glasses. No speaker.

## Open questions

- **Speaking before the turn ends.** `claude -p` can emit partial messages
  (`--include-partial-messages`), which would let the first sentence be spoken
  while the rest is still being written — the largest possible cut in perceived
  latency. It also means speaking text that is not yet final, and narration that
  a tool call then makes wrong. It belongs to PRD 6's streaming, and is tried
  after this PRD is in use.
- **Mike's voice.** The book gives Mike several voices; one for Mike and one for
  all workers would make it audible who is talking without saying the name.
  Cheap once there are two voices per language to choose from.
- **Barge-in by voice.** The watch feeds its codec's output back into the ES7210
  as an echo reference, so esp-sr's AEC can hear the user over an answer. Saying
  *stop* while the voder speaks, without touching anything, is therefore
  possible on the watch — and it needs VAD running during playback, which is
  PRD 8.0's *Later*, not this PRD.
