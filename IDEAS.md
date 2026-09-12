# Ideas

Things worth building that nothing is specified for yet. Not a backlog and not a
promise — a place to put an idea with its reasoning, so the thinking does not
have to happen twice.

Each entry says what it is, why it is worth doing, and where the difficulty
actually sits. When one graduates it becomes a PRD or a requirement in an
existing one, and the entry is deleted rather than left to drift.

---

## A room, rather than one active worker

Several workers present at once, with Mannie and Mike, all hearing each other.

**The plumbing is nearly there.** Replies already land in one shared session, and
the background-notice work is half of showing several voices at once.

**The hard part is addressing.** With one listener the prefix rule is
unambiguous, but in a room "can you look at that" has to be given to somebody,
and deciding that per utterance is exactly the classifier in the hot path that
PRD 3 rejected for being slow and occasionally wrong. The likely answer is a
chair who hands out the floor — which is what Mike already is.

Raised 2026-09-11; a weekend project at most.

---

## Full-duplex voice — listening and talking at once

Answer while the user is still speaking, and be interruptible mid-sentence,
the way the newer speech-to-speech demos are.

**Why it is not a bolt-on.** Everything here is turn-based: wait for silence,
transcribe the whole segment (services/whisper/serve.py), send it as one
prompt to a Claude Code session, get one reply back, read it aloud. A
full-duplex model holds listening and speaking open in the same stream the
whole time, which is a different engine, not an addition to this one — Claude
Code is not that, and neither is faster-whisper, which only ever answers a
finished segment.

**What real streaming ASR would need on the way there.** Whisper is a batch
model: re-running it on a growing buffer to fake word-by-word output makes
already-shown words shift and get rewritten as more context arrives, and
multiplies GPU calls per utterance for a service that today does one. An
actual streaming recognizer (RNN-T-style, e.g. Parakeet/Conformer-RNNT) is a
different architecture, not a setting on this one.

Raised 2026-09-12, talking through a demo video where the model answered
mid-sentence. Parked rather than started — worth remembering why it is hard
before someone proposes it again.
