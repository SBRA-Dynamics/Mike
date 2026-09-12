# PRD 5b — Voice, from the glasses

One job: make the G2's microphones a source for the pipeline PRD 5a already
built.

## Goal

Hold a conversation while your hands are busy — speak without touching anything,
have it understood, and read the answer on the lens.

## Scope, stated narrowly on purpose

Everything downstream of a segment is PRD 5a's and must not be rebuilt here:
segmentation, transcription, the addressing modes, the mode commands, `heard`,
the latency budget, the feedback states. If this phase ends with glasses audio
turning into the same segments PRD 5a already handles, it is done.

What is genuinely new here is the four things the glasses have that a browser
does not: a microphone on someone's face, a beamforming array that tags who is
speaking, a touchpad that can be held, and a battery.

## What the SDK gives us, and what it does not

Checked against `@evenrealities/even_hub_sdk` 0.0.15.

**No speech-to-text.** Nothing in the SDK matches asr, speech, transcribe,
recognise or stt. Even's own Conversate feature is a native app function on a
separate BLE service; it is not reachable from a plugin. The official `asr`
template ships an empty STT stub and says to bring your own. This is why PRD 5a
exists at all.

**But the hard half is exposed.** Every audio frame arrives as:

```ts
class AudioEvent {
  audioPcm: Uint8Array;                 // 16 kHz, signed 16-bit LE, mono
  source: AudioInputSource;             // Glasses | Phone
  direction: number | null;             // beamforming tag from the 4-mic array
  speakerRole: AudioSpeakerRole;        // Self | Other | Unknown
}
```

The format is already what PRD 5a's segmenter wants — 16 kHz, s16le, mono — and
that is not a coincidence: PRD 5a chose it so this phase would need no
conversion.

`speakerRole` is the Even app's own algorithm deciding whether the wearer is
speaking or someone else is. That is precisely what makes Conversate good at
picking one voice out of a room, and it is handed to plugins per frame.

The SDK is explicit that it is *"an app algorithm result; this is not a firmware
identity assertion"* — a heuristic, not identity. Good enough to decide what to
transcribe. Not something to trust for anything that matters.

## Requirements

### R5b.1 — Capture

Continuous capture from the glasses' mic array via `audioControl(true,
AudioInputSource.Glasses)`. Requires `g2-microphone` in `app.json` and a created
startup page — the glasses-side page must exist before the microphone can be
opened, which is a sequencing constraint on the client, not a detail.

Phone mic via `AudioInputSource.Phone` as the fallback where the glasses are
unavailable; it needs `phone-microphone` and no startup page.

`PushToTalk` is the exception to "continuous": there capture opens on a held
touchpad and closes on release, so the microphone is off the rest of the time.

Audio must stop on exit, on backgrounding and on error. Leaving the microphone
running on the hardware is both a battery problem and a trust problem, and the
second one is worse.

### R5b.2 — Speaker filtering

Frames tagged `Other` are discarded before anything else. Frames tagged
`Unknown` are kept — losing the wearer's speech is worse than transcribing a
little noise — but the ratio is logged, because if `Unknown` dominates the
filter is useless and the design needs revisiting.

This is what should make always-on viable in a kitchen with other people in it,
and it is the one capability that has no equivalent in PRD 5a. If it works, the
glasses can run `Always` where a laptop cannot. If it does not, the honest
fallback is `PushToTalk` (R5a.4), which is why that mode exists.

### R5b.3 — Push to talk on the touchpad

Capture spans the hold: audio flows from `LONG_PRESS_EVENT` (9) to
`LONG_PRESS_RELEASE_EVENT` (10). The SDK reports press and release separately,
which is exactly what this needs — verified in the 0.0.15 typings, not in the
documentation, which lists only events 0–8.

The hold must never be conditional on page state, active worker or connection
status: in `PushToTalk` it is the only way to speak a mode command back out
(R5a.4).

**Cost to measure before promising.** `audioControl(true)` is a BLE round trip,
and the fixed per-call cost measured on this hardware is ~160 ms. A user who
starts speaking as they press will lose the first syllable. Two mitigations, to
be chosen after measuring the real lead-in: keep the microphone open for a short
tail after release so trailing words survive, and show capture state on the lens
the moment it is live. Do not ship a hold-to-talk whose start the user cannot
see — there is no speaker on the glasses, so the screen is the only feedback
there is.

### R5b.4 — Bandwidth

16 kHz × 16 bit mono is 32 KB/s of PCM against a measured BLE budget of roughly
100 KB/s, on a link that is also carrying every lens update. Measure the real
rate rather than trusting the arithmetic, and if continuous capture does not fit,
the design becomes press-to-listen rather than always-on — and nothing
downstream changes, which is the point of the split.

## Risks, to be measured before building the rest

These are the reason this phase is last, and the reason PRD 5a is not blocked by
it. Each is a small test, not a guess.

| risk | test | kills |
|---|---|---|
| **Battery** | mic on, stream bytes, watch battery over 30 min | always-on entirely |
| **Bandwidth** | measure actual PCM rate against the ~100 KB/s BLE budget | continuous capture |
| **speakerRole accuracy** | log Self/Other/Unknown while two people talk | R5b.2, the premise of always-on |
| **Kitchen noise** | record segments with a fan and a pan going, transcribe | usability |

The battery and bandwidth tests come first. If continuous capture is not
practical, this phase becomes the touchpad and the filter, and PRD 5a's
`PushToTalk` carries the product.

## Acceptance criteria

1. Speaking "Mike, what time is it" with hands busy produces an answer on the
   lens without touching anything
2. Another person talking nearby does not produce a turn
3. The wearer talking to that person does not produce a turn
4. Holding the touchpad captures only while held, and the first word survives
5. Mic stops on exit and on backgrounding, verified by battery behaviour
6. A 30-minute session does not flatten the glasses
7. A recorded glasses segment and a recorded browser segment take the identical
   path through the server — no branch anywhere downstream of capture

## Non-goals

- Speaker identification as a security boundary. The SDK says it is not one.
- Text-to-speech. The G2 has no speaker; answers are read.
- Offline transcription on the phone.
- Rebuilding anything PRD 5a already owns.
