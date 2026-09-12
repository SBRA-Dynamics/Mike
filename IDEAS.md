# Ideas

Things worth building that nothing is specified for yet. Not a backlog and not a
promise — a place to put an idea with its reasoning, so the thinking does not
have to happen twice.

Each entry says what it is, why it is worth doing, and where the difficulty
actually sits. When one graduates it becomes a PRD or a requirement in an
existing one, and the entry is deleted rather than left to drift.

---

## Spoken names for directories

Say **"start a worker called Bosse in MyProject"** and have it land in
`/home/user/projects/MyProject`.

**Why this is more than sugar.** A path is the one thing dictation cannot carry.
"Slash media slash Robin slash GitHub slash MyProject" is not a sentence anybody
says out loud, and whisper will not produce the slashes anyway — PRD 3's own
worker prompt warns the worker to expect "no slashes in paths". So today, with
hands busy, a worker can only be started in the default directory. Everything
else needs a keyboard. A short list of names turns the most common case into one
spoken word, and the list is small: a handful of repositories covers almost
everything.

**Where it should live.** A file, like the prompts, re-read when it changes so a
new project can be added without a restart:

```json
{ "MyProject": "/home/user/projects/MyProject",
  "MyLibrary": "/home/user/projects/MyLibrary",
  "Mike": "/home/robin/jarvis" }
```

Resolved in `workers.js` `#checkCwd`, so it applies to every path argument
rather than only to `spawn_worker`, and so an unknown name fails the same way an
unknown model does: an error that names the valid ones, short enough to read on
a lens.

**The part that needs thought.** Mike has to *know* the names, or he will keep
guessing at absolute paths. The cheapest way is to list them in the
`spawn_worker` schema description, which is rebuilt per `tools/list` and
therefore always current — the same mechanism that already makes the model list
live. Matching should fold the way spoken names already do in `names.js`
("example o s" and "MyProject" are the same thing), and it should be a suggestion,
not a jail: an absolute path must keep working, because the alias list will
always be missing whatever is needed today.

**Let the list learn.** Every list of "the common cases" is incomplete the
moment it is written, which is why the absolute path has to keep working — but
it also means a list that can only be edited by hand will always be one project
behind. So when a worker is started with an absolute path that has no name,
Mike can ask: *"should I call that one MyFilesystem?"* A yes writes the
entry. The list then grows by being used instead of by being maintained, and the
question costs nothing when the answer is no.

Two things to get right if this is built. He must ask only when the path is
genuinely unnamed, or it becomes a tic — and the name he proposes should come
from the directory itself, because the user has just said what they want it
called by choosing where to work. Writing a config file from a model's decision
is the one part that deserves a guard: a suggested name goes through the same
folding and validation as a worker's, and nothing outside the map is touched.

**Natural extension, not required.** The same map is what would let "the folder
we are talking about" resolve without Mike reading it out of context — though
that already works, which is a good argument for keeping this small.

---

## A room, rather than one active worker

Several workers present at once, with Robin and Mike, all hearing each other.

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
