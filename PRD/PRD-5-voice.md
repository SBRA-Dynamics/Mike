# PRD 5 — Voice pipeline

Hands-free. The only phase with physical unknowns, and deliberately last.

## Goal

Hold a conversation while your hands are busy: speak without pressing anything,
have it understood, and read the answer on the lens.

## What the SDK gives us, and what it does not

Checked against `@evenrealities/even_hub_sdk` 0.0.15.

**No speech-to-text.** Nothing in the SDK matches asr, speech, transcribe,
recognise or stt. Even's own Conversate feature is a native app function on a
separate BLE service; it is not reachable from a plugin. The official `asr`
template ships an empty STT stub and says to bring your own.

**But the hard half is exposed.** Every audio frame arrives as:

```ts
class AudioEvent {
  audioPcm: Uint8Array;                 // 16 kHz, signed 16-bit LE, mono
  source: AudioInputSource;             // Glasses | Phone
  direction: number | null;             // beamforming tag from the 4-mic array
  speakerRole: AudioSpeakerRole;        // Self | Other | Unknown
}
```

`speakerRole` is the Even app's own algorithm deciding whether the wearer is
speaking or someone else is. That is precisely what makes Conversate good at
picking one voice out of a room, and it is handed to plugins per frame.

The SDK is explicit that it is *"an app algorithm result; this is not a firmware
identity assertion"* — a heuristic, not identity. Good enough to decide what to
transcribe. Not something to trust for anything that matters.

## Architecture

```
glasses mics ──► plugin: filter by speakerRole, VAD, segment
                          │
                          └── PCM segment ──► server: whisper (RTX 5060 Ti)
                                                  │
                        lens ◄── reply ◄── Jarvis/worker ◄── text
                          ▲
                          └── "heard: ..." so the user sees what was understood
```

**Transcription runs on the server.** The glasses cannot, the phone should not,
and the audio has to reach the server anyway. Local whisper on the 5060 Ti keeps
speech off the internet, which is the same reason the rest of this system is
self-hosted.

**The recognised text comes back to the client** as a `heard` message, not just
into the conversation. With dictation, seeing what was understood is the
difference between trusting the system and guessing at it.

## Requirements

### R5.1 — Capture

Continuous capture from the glasses' mic array via `audioControl(true,
AudioInputSource.Glasses)`. Requires `g2-microphone` in `app.json` and a created
startup page. Phone mic as a fallback where the glasses are unavailable.

Audio must stop on exit, backgrounding and error. Leaving the mic running on the
hardware is both a battery and a trust problem.

### R5.2 — Speaker filtering

Frames tagged `Other` are discarded before anything else. Frames tagged
`Unknown` are kept — losing the wearer's speech is worse than transcribing a
little noise — but the ratio is logged, because if `Unknown` dominates the
filter is useless and the design needs revisiting.

This is what should make always-on viable in a kitchen with other people in it.

### R5.3 — Segmentation

Energy-based voice activity detection over the kept frames, with a hangover so
normal pauses do not split a sentence. A segment ends on silence or at a maximum
length. Segments, not a continuous stream, go to the server: whisper is far
better given a whole utterance.

### R5.4 — Wake word

`speakerRole` filtering solves *other people*. It does not solve *the wearer
talking to someone else*, which in a kitchen is most of what he says.

So: an addressing rule is still required. Default is the same prefix the router
already uses — an utterance must begin with "Jarvis" or the active worker's
name, checked after transcription on the server, where the full text is
available and no keyword spotter is needed on the phone.

Cheap, no extra model, and consistent with how routing already works.

A **conversation mode** may follow a reply for a few seconds, during which the
prefix is not required, so a back-and-forth does not need his name every turn.

### R5.5 — Transcription service

- whisper (large-v3 or distil-large) on the GPU, loaded once and kept warm
- Swedish and English, auto-detected
- Exposed only on loopback; the WebSocket carries audio to the server
- The same voice normalisation as typed input is **not** applied: whisper
  produces real punctuation and paths, unlike phone dictation. Normalisation
  stays for the typed path.

### R5.6 — Latency budget

End to end, from end of speech to first text on the lens:

| stage | target |
|---|---|
| segment flush | < 200 ms |
| transcription | < 800 ms |
| routing + first token | model dependent |
| lens update | ~160 ms |

Under two seconds to "it heard me" is the bar. Slower than that and the user
starts repeating themselves.

### R5.7 — Feedback

The user must always know the state: idle, listening, heard, thinking. On ten
rows this is one short status line, not an animation.

## Risks, to be measured before building the rest

These are the reason this phase is last. Each is a small test, not a guess.

| risk | test | kills |
|---|---|---|
| **Battery** | mic on, stream bytes, watch battery over 30 min | always-on entirely |
| **Bandwidth** | measure actual PCM rate against the ~100 KB/s BLE budget | continuous capture |
| **speakerRole accuracy** | log Self/Other/Unknown while two people talk | R5.2, the whole premise |
| **Kitchen noise** | record segments with a fan and a pan going, transcribe | usability |
| **Whisper latency** | time a 5-second Swedish utterance on the 5060 Ti | R5.6 |

The battery and bandwidth tests come first: if continuous capture is not
practical, the design becomes press-once-to-start-listening rather than
always-on, and everything downstream is unchanged.

## Acceptance criteria

1. Speaking "Jarvis, what time is it" with hands busy produces an answer on the
   lens without touching anything
2. Another person talking nearby does not produce a turn
3. The wearer talking to that person does not produce a turn
4. What was heard is shown before the answer
5. Mic stops on exit and on backgrounding, verified by battery behaviour
6. A 30-minute session does not flatten the glasses

## Non-goals

- Speaker identification as a security boundary. The SDK says it is not one.
- Text-to-speech. The G2 has no speaker; answers are read.
- Offline transcription on the phone.
