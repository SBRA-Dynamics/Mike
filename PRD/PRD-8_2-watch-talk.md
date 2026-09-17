# PRD 8.2 — The watch: talk

One job: make the watch's microphone a push-to-talk source for the pipeline
PRD 5a already built, and show on the watch what was heard and what came back.

## Goal

Mannie holds a thumb on the watch, says *"Bosse, run the tests again"*, lets go,
and sees *heard: Bosse, run the tests again*, then what Bosse is doing, then
Bosse's answer — without the glasses on and without taking out the phone.

## Scope, stated narrowly on purpose

Everything downstream of a segment is PRD 5a's and is not rebuilt here:
transcription, turn assembly, routing, the mode commands, `heard`, `turn` and
`progress`. If watch audio turns into the same `audio` messages the browser
sends, this phase is mostly done.

What is new is what the watch has that a browser does not: two microphones at
arm's length behind an ES7210, a reference of its own speaker for echo
cancellation, a battery, and a radio that may be asleep when the thumb goes
down. And one thing the server does not do yet: let a hold on one device be an
address without changing the mode another device is listening in.

No speech output. That is PRD 8.3.

## Requirements

### R8.2.1 — Capture

- The ES7210 through the BSP's `bsp_audio_codec_microphone_init()`, 16 kHz,
  16-bit — the wire format of R5a.1, so nothing is resampled. It delivers the
  two microphones (MIC1, MIC2) and the codec-output reference (MIC3) as
  separate channels
  (`AUDIO_INPUT_REFERENCE` in Xiaozhi's board file for this watch).
- **What goes on the wire is one channel, and which one is measured, not
  chosen** (*Risks*): the better of the two microphones as it is, or esp-sr's
  AFE output with two-microphone noise suppression and AEC against the
  reference. The AFE costs CPU and a few frames of delay; it is used only if
  whisper does measurably better with it.
- Input gain starts at the ES7210's default in the BSP and is tuned by the
  measurement, not by ear.
- Capture runs from touch-down to release, plus a **tail** of 300 ms so a last
  syllable said while the thumb lifts survives. The tail is a measured number,
  not a guess, once the first recordings exist.
- Capture and playback use different chips on one I2S bus (ES7210 in, ES8311
  out) and can run at the same time. The rule that matters is therefore not
  codec ownership but intent: a hold stops playback (PRD 8.3 R8.3.7), because
  the user who starts talking is done listening.
- A hold longer than 15 s is cut into segments with `reason: "maximum"`, as the
  browser's segmenter does, and the hold continues.

### R8.2.2 — The gesture

Hold anywhere on the face or the list, **not** a row: a hold that starts on a
name must not switch worker when it ends. The press is recognized after 250 ms
so a tap stays a tap.

That makes the stop of R8.1.6 and the talk of this phase the same long press.
They are separated by state: while `busy`, a long press stops; while idle, it
talks. A user who wants to talk over a running turn says *stop* first, or holds
again once it has stopped. This is deliberate: the one gesture must never do
something the screen did not just show it would do, and the screen says which
(R8.2.5).

### R8.2.3 — A hold is an address, on this device only

In `PushToTalk` a hold is the address (R5a.4): what is said while held is
admitted as `Always` admits it. The watch needs that behavior for its own
segments **without** putting the session into `PushToTalk`, because the session
mode belongs to the glasses too, and a thumb on the wrist must not close the
microphone on a face.

So `audio` gains an optional field:

```js
{ type: "audio", pcm, final, sampleRate, reason, held: true }
```

A segment with `held: true` is routed as a `PushToTalk` segment whatever the
session's mode is — **including `Ignore`**. `Ignore` exists for an open
microphone in a room where the user is talking to somebody else; a hold on the
wrist is not ambient, and refusing it would make the watch look broken in
exactly the mode people forget they left on. The mode commands are matched
first as always, so *"continue listening"* said during a hold still works.

The field is validated like the others in `validateC2S` (a boolean or absent),
and it is available to every client: the browser's hold button can send it too.

### R8.2.4 — One sentence, one turn, however many microphones heard it

With the glasses in `Always` or `ByName` and the watch held to the mouth, both
hear the same sentence, and today that becomes two turns. While a hold is open
on any connection of a session, the server drops non-held `audio` from the
**other** connections of that session, from the hold's start until 2 s after
its end, and logs each drop. The held segment wins because it is the one the
user chose.

The rule is about microphones. A line typed on the keyboard during a hold is a
`say`, not `audio`, and is never dropped by it: it is typed, and the keyboard's
turn follows the ordinary rules.

The hold's start and end are the watch's `speaking` messages, sent on touch-down
and after the tail. Today `speaking` is tracked per session (`talking` in
`src/handler.js`); with two microphones in one session it must be tracked per
connection, and a session counts as speaking while any of its connections is.

### R8.2.5 — Feedback on the screen

The watch has a speaker and a motor but, in this phase, uses them only to say
that the microphone is live (R8.2.6). The screen carries the rest, in the order
R5a.8 names:

| state | shown |
|---|---|
| thumb down, ES7210 opening | *opening* |
| capture live | *listening*, a level bar from the peak of each 60 ms frame |
| released, waiting for Wi-Fi or upload | *sending* |
| `heard` | the words, under *heard* |
| `heard`, then dropped by routing | the words, struck through, with the reason |
| `turn` held / queued / started | *still listening* / *queued* / the worker's name |
| `progress` | the tool or the first sentence, as the lens shows it |
| `text` | the answer, on the *last answer* screen, which the watch switches to |

*opening* and *listening* are two words for the same reason they are on the
lens (PRD 5b R5b.3): a user who starts talking the moment the thumb lands loses
the first syllable if *listening* is shown before it is true.

While idle, the face shows a small *hold to talk* hint; while busy, *hold to
stop*.

### R8.2.6 — Live, without looking

A hold is often done without looking, so the moment capture is live is marked
by something that does not need eyes: **one short buzz of the motor**. Not a
tick from the speaker — it would be recorded at the start of every segment, and
with the watch at the mouth the reference cannot fully cancel a sound that
loud. If the motor's spin-up is heard in the recordings (*Risks*), the buzz is
moved to the end of the hold, where it says *sent* instead. If no motor is
fitted (PRD 8.1's first measurement), the screen alone carries it.

### R8.2.7 — Talking to a sleeping watch

Under PRD 8.1's strategy A the chip is in deep sleep, and a touch cannot wake
it (the FT3168 interrupt is on GPIO 38, not an RTC pin). The wake is a press on
PWR or a raised wrist, and the network starts connecting at once, before
anyone has touched the screen. The watch does not wait for the network to start
listening:

1. the wake starts Wi-Fi association, TLS resumption and `hello`
2. touch-down opens the ES7210 and capture starts into PSRAM, whether or not
   the connection is up yet
3. on release the segment waits in PSRAM until `ready`, then is sent
4. if no connection is made within 15 s the segment is dropped, the screen says
   *not sent — offline*, and nothing is retried later: a sentence arriving
   minutes after it was said is worse than one that never arrived

The segment's `speaking` messages are sent on connect, before the segment, so
the turn assembly sees them in order even though they were late.

### R8.2.8 — Noise, recorded on the watch

The spoken command *"record noise"* (PRD 5a's `noiseRequested`) is honored by the
watch with `device: "watch"`, so recordings from the wrist, from a pocket and in
the car can be compared with the glasses' and the browser's in `noise/`. It
records the same channel R8.2.1 sends, so a noise recording describes what
whisper actually gets.

## Risks, to be measured before building the UI

| risk | test | decides |
|---|---|---|
| **Transcription quality** | the same 20 sentences, Swedish and English, read at the mouth and at chest height, through our whisper; compare with the browser | whether the watch is a microphone at all, and at what distance |
| **Which channel** | the 20 sentences recorded as mic 1, mic 2 and the AFE's two-mic output, all through whisper | R8.2.1: raw microphone or AFE |
| **Gain** | the 20 sentences at three ES7210 gain settings around the BSP default | R8.2.1's gain |
| **First syllable** | a sentence started on touch-down, from a sleeping watch and an awake one | whether R8.2.7's order works |
| **The buzz** | the motor pulse at touch-down, then listen to the first 300 ms of 20 segments | R8.2.6: buzz at the start or at the end |
| **Sleeve and wind** | noise recordings from the wrist while walking, and in a pocket | whether a hold from a pocket is usable |
| **Two microphones** | glasses in `Always`, the watch held, 20 sentences | R8.2.4: exactly 20 turns |

The first test comes before any UI: a firmware that records a hold to PSRAM and
sends it as `audio`, and the server's own log line (`heard … in … ms`) is the
measurement.

## Acceptance criteria

1. Holding the watch and speaking gives a turn to the right worker, with the
   glasses off
2. With the session in `ByName`, an unaddressed held sentence reaches the active
   worker; the same sentence from the glasses is still dropped
3. With the session in `Ignore`, a held sentence gets through, and the glasses'
   microphone stays paused
4. With the glasses in `Always` and the watch held, one sentence makes one turn
5. From a sleeping watch woken by PWR or a raised wrist, a sentence started on
   the first touch-down arrives with its first word
6. While a turn runs, the same long press stops it and never records
7. A held segment with the network off is dropped after 15 s and never sent
   later
8. A watch segment and a browser segment take the identical path through the
   server once past R8.2.3's routing rule
9. With the keyboard connected, a line typed during a watch hold and the held
   sentence both become turns, in the order they arrived

## Files

```
firmware/watch/main/audio.c    ES7210 capture, channel choice or AFE, tail, segmenting
firmware/watch/main/talk.c     the hold, R8.2.7's order, feedback states
```

Server: `src/protocol.js` (`held`), `src/routing.js` (a held segment routes as
`PushToTalk`), `src/handler.js` (per-connection `speaking`, R8.2.4's drop), and
`src/devices.js` (PRD 8.1) lets a watch send `audio` and `speaking`, which a
keyboard still may not.
Tests in `test/prd5a.mjs` for `held` and the drop, since they are properties of
the audio path and not of the watch.

## Non-goals

- Continuous listening, VAD or a wake word on the watch. Later (PRD 8.0),
  even though the two microphones and the echo reference make it possible.
- Opus. PCM until bandwidth is shown to matter.
- Speech output. PRD 8.3.
- Speaker identification. One user, one wrist.

## Open questions

- **Talking over a running turn.** R8.2.2 makes a long press during `busy` a
  stop. If saying *stop* and holding again turns out to be the common case,
  a hold during `busy` could stop and then record in one gesture. Use it first.
- **A hold from the glasses touchpad is also an address.** It is, today, only in
  `PushToTalk` mode. With `held` on the wire, the glasses could send it in every
  mode too. That is PRD 5b's decision, not this one's.
