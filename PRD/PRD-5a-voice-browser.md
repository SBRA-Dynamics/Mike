# PRD 5a — Voice, from the browser

The whole voice pipeline, with the browser's microphone as the source.

## Goal

Talk to Mike and to workers by speaking into a laptop or a phone browser, see
what was understood, and read the answer — with no glasses involved at all.

## Why this is its own phase, and first

Every unknown in the voice phase is a *glasses* unknown: battery, BLE bandwidth,
`speakerRole` accuracy, whether an always-on mic on someone's face is practical
at all. None of them are unknowns about transcription, segmentation, addressing,
or the wire.

So this phase builds everything that is not the glasses, against a microphone
that is always available, costs no battery anyone is watching, and can be tested
at a desk in a second. It is also useful on its own: dictating to a worker from
the desktop instead of typing is worth having whether or not the glasses ever
carry a microphone.

PRD 5b then has one job — turn glasses audio into the same segments this phase
already knows what to do with.

## Architecture

```
browser mic ──► client: resample, VAD, segment
                          │
                          └── PCM segment ──► server: whisper (RTX 5060 Ti)
                                                  │
                      screen ◄── reply ◄── Mike/worker ◄── text
                          ▲
                          └── "heard: ..." so the user sees what was understood
```

**Transcription runs on the server.** The browser should not carry a model, the
audio has to reach the server anyway, and local whisper on the 5060 Ti keeps
speech off the internet — the same reason the rest of this system is self-hosted.

**The recognised text comes back** as a `heard` message, not only as a turn in
the conversation. With dictation, seeing what was understood is the difference
between trusting the system and guessing at it.

## Requirements

### R5a.1 — Capture

`getUserMedia({ audio: … })` in the existing client, with echo cancellation and
noise suppression left on: the browser's own are better than anything worth
writing here, and this is a desk microphone in a room with a fan.

The pipeline wants **16 kHz, signed 16-bit little-endian, mono** — the format
PRD 5b's glasses frames arrive in, chosen here so one segment format serves both
sources. Browsers capture at 44.1 or 48 kHz, so the client resamples. Resampling
happens once, in the client, before anything else sees the audio.

Permission is asked for when the user first turns the microphone on, never at
page load. A page that asks for a microphone before being told to is a page
people close.

### R5a.2 — No speaker filtering, and what that costs

PRD 5b's `speakerRole` does not exist here: a laptop microphone cannot tell the
wearer from the room. So the addressing mode (R5a.4) carries the entire burden
of deciding what was meant for the system.

This is the one place the two phases genuinely differ in behaviour rather than
plumbing, and it should be stated in the client rather than discovered:
`Always` with a desk microphone means every word spoken in the room reaches a
model. `ByName` and `PushToTalk` are the modes that make sense here, and
`PushToTalk` is the honest default for a shared room.

### R5a.3 — Segmentation

Energy-based voice activity detection over the captured frames, with a hangover
so an ordinary pause does not split a sentence. A segment ends on silence or at
a maximum length. Segments, not a continuous stream, go to the server: whisper
is markedly better given a whole utterance than a sliding window.

In `PushToTalk` the hold delimits the utterance and the release ends it; VAD
still runs, to trim silence from both ends before whisper sees it.

This is the piece PRD 5b reuses unchanged. It must therefore take frames, not a
`MediaStream` — a function from PCM to segments, with no browser API inside it,
so the glasses can hand it their frames and get the same behaviour.

### R5a.4 — Addressing modes

Four modes decide what reaches the conversation. This section is the whole
specification for all of them; PRD 5b adds only the glasses gesture for
`PushToTalk`.

| mode | what reaches the conversation | mic |
|---|---|---|
| **Ignore** | nothing — input is paused | open |
| **ByName** | only utterances beginning with "Mike" or the active worker's name | open |
| **Always** | everything the user says | open |
| **PushToTalk** | only what is said while the control is held | closed until held |

The table is about **spoken** input, which is the only kind with an ambient
problem. Typed input is never gated by the mode — see PRD 3, "The prefix
requirement is conditional".

`ByName` is the default. `Always` is for sitting down to work, when every
sentence is meant for the system. `Ignore` is for a conversation you are having
with someone else. `PushToTalk` is for a room where an open microphone is not
acceptable at all.

#### PushToTalk

The other three modes leave the microphone running and decide in software what
to keep. That is the right trade in a kitchen and the wrong one in a meeting.
**`Ignore` is not the same thing: it keeps listening and discards.**
`PushToTalk` is the only mode where the microphone is actually off, and that
difference is the whole reason it exists.

In this phase the control is a press-and-hold button in the companion view.
PRD 5b adds the glasses touchpad.

**No prefix is required while held.** Holding the control *is* the address. A
prefix still overrides, so "Mike, …" during a hold reaches him even when a
worker is active.

#### The mode commands are always live

**In every mode, including Ignore, the mode commands are recognised and acted
on.** This is a safety property, not a convenience: there must be no state the
user can reach from which they cannot speak their way out. They are matched
before the mode gate, never after it.

| said | effect |
|---|---|
| "Hey Mike, pause input" / "pausa input" | → Ignore |
| "Hey Mike, continue input" / "fortsätt input" | → the mode in use before it was paused |
| "Hey Mike, change input to always" / "ändra input till alltid" | → Always |
| "Hey Mike, change input to by name" / "ändra input till via namn" | → ByName |
| "Hey Mike, change input to push to talk" / "ändra input till håll in" | → PushToTalk |
| "turn on the mic" / "slå på mikrofonen" | microphone on |
| "turn off the mic" / "stäng av micken" | microphone off |

The last two are not modes — they are whether there is a microphone for a mode
to listen with — but they are matched at the same point and for a sharper
reason. Turning it off leaves the user unable to be heard at all, so the way
back must be one they can reach: hold the touchpad and say it. The server has no
microphone and does not own the switch; it relays the request so every attached
device agrees about whether anything is listening, and the request is transient,
because replaying it on a reconnect would open a microphone hours later.

Transitions available in each mode:

- **Ignore** → continue (back to the previous mode)
- **ByName** → pause, or change to always or push to talk
- **Always** → pause, or change to by name or push to talk
- **PushToTalk** → said during a hold: pause, or change to by name or always

`PushToTalk` is the one mode where the safety property needs care. The
microphone is off, so nothing spoken can be heard until the control is held —
the escape is to **hold and say the command**, which works because the commands
are matched before the gate there too. The invariant survives, but it now
depends on the control, so the control must never be conditional on anything:
no page state, no active worker, no connection status may stop a hold from
opening the microphone. The mode control in the companion is the second way out,
and the typed path a third (typing is never gated at all).

"Continue" restores the mode that was active before pausing rather than a fixed
default, and it can restore `PushToTalk` like any other: resuming must not drop
the user into an open microphone, which is the one thing that mode prevents.

#### Matching

The commands arrive through speech recognition, so the matcher must tolerate
what that produces: casing, trailing punctuation, "Hey Mike" / "Hej Mike" /
bare "Mike", and the Swedish and English forms of each. Matching happens on
the server against the transcribed text, where the whole utterance is available.
The same commands work when typed, so the desktop and the glasses behave alike.

#### Conversation mode

After a reply, a short window may follow during which `ByName` does not require
the prefix, so a back-and-forth does not need his name every turn. This is a
timeout on top of the mode, not a mode of its own, and it never applies in
`Ignore`. It does not apply in `PushToTalk` either: the hold already says which
words are meant for the system, and a timed window that opened the microphone
without a gesture would break the promise the mode makes.

#### Visibility and persistence

The current mode is part of the `state` message, shown by the client, and shown
on the lens status line when it is anything other than the default. A mode the
user cannot see is a mode they will be surprised by.

`PushToTalk` needs one thing more: whether capture is live *right now*, not just
which mode is set. A hold-to-talk the user cannot confirm is listening is a mode
they will speak into and lose.

The mode is per session and survives a server restart. It defaults from config
for a fresh session.

*Implementation note, 2026-09-11:* `src/routing.js` implements three modes.
`PushToTalk` lands with this phase, because it is the only mode whose behaviour
is a microphone decision rather than a routing one — the routing half of it is
`Always`, scoped to the hold.

### R5a.5 — Transcription service

- whisper (large-v3 or distil-large) on the GPU, loaded once and kept warm
- Swedish and English, auto-detected
- Exposed only on loopback; the WebSocket carries audio to the server
- The same voice normalisation as typed input is **not** applied: whisper
  produces real punctuation and paths, unlike phone dictation. Normalisation
  stays for the typed path.
- A segment that transcribes to nothing produces nothing: no empty turn, no
  "I didn't catch that". Silence that was mistaken for speech should cost the
  user nothing at all.

### R5a.6 — The wire

`audio` already exists in the protocol (PRD 1, `C2S.AUDIO`, base64 PCM) and was
specified for exactly this. The client sends one message per segment.

Utterances that arrive this way carry `origin: "voice"` when they reach routing,
which is what the addressing gate acts on (PRD 3). Typed input stays ungated.

A segment is bounded: a maximum length in the client, and a size limit on the
server. An unbounded audio message is a way to fill a disk.

### R5a.7 — Latency budget

End to end, from end of speech to first text on screen:

| stage | target |
|---|---|
| segment flush | < 200 ms |
| transcription | < 800 ms |
| routing + first token | model dependent |

Under two seconds to "it heard me" is the bar. Slower than that and the user
starts repeating themselves.

### R5a.8 — Feedback

The user must always know which of these is true: idle, listening, heard,
thinking. In the companion this can be a proper indicator; on the lens it is one
short status line, sharing the slot the background notices use.

The `heard` text is shown as soon as it exists, before the answer — and it is
shown even when the utterance is then dropped by the mode gate, because "it
heard me and decided I wasn't talking to it" and "it didn't hear me" are
different problems with different fixes.

## Risks

Small compared to PRD 5b, but not zero.

| risk | test | kills |
|---|---|---|
| **Whisper latency** | time a 5-second Swedish utterance on the 5060 Ti | R5a.7 |
| **Room noise** | record segments with a fan and a pan going, transcribe | usability |
| **VAD splitting sentences** | speak with ordinary pauses, count segments | segmentation |
| **Echo from the speakers** | play a reply aloud while capturing | always-on in a browser |

## Acceptance criteria

1. With the microphone on in a browser tab, saying "Mike, what time is it"
   produces an answer on screen without touching anything
2. What was heard is shown before the answer
3. "Hey Mike, pausa input" stops everything reaching the conversation, and
   "fortsätt input" brings back the mode that was active before — both spoken,
   with nothing touched
4. Holding the push-to-talk button captures only while held, and the microphone
   is demonstrably off when it is not held
5. A segment that is silence produces no turn
6. Speaking with ordinary pauses produces one segment per sentence, not five
7. The same segmentation code, given a recorded PCM file, produces the same
   segments outside a browser — the property PRD 5b depends on

## Non-goals

- Wake-word detection. The addressing modes are the wake word.
- Text-to-speech.
- Transcription in the browser.
