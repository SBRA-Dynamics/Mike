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
  "Jarvis": "/home/robin/jarvis" }
```

Resolved in `workers.js` `#checkCwd`, so it applies to every path argument
rather than only to `spawn_worker`, and so an unknown name fails the same way an
unknown model does: an error that names the valid ones, short enough to read on
a lens.

**The part that needs thought.** Jarvis has to *know* the names, or he will keep
guessing at absolute paths. The cheapest way is to list them in the
`spawn_worker` schema description, which is rebuilt per `tools/list` and
therefore always current — the same mechanism that already makes the model list
live. Matching should fold the way spoken names already do in `names.js`
("example o s" and "MyProject" are the same thing), and it should be a suggestion,
not a jail: an absolute path must keep working, because the alias list will
always be missing whatever is needed today.

**Natural extension, not required.** The same map is what would let "the folder
we are talking about" resolve without Jarvis reading it out of context — though
that already works, which is a good argument for keeping this small.

---

## A room, rather than one active worker

Several workers present at once, with Robin and Jarvis, all hearing each other.

**The plumbing is nearly there.** Replies already land in one shared session, and
the background-notice work is half of showing several voices at once.

**The hard part is addressing.** With one listener the prefix rule is
unambiguous, but in a room "can you look at that" has to be given to somebody,
and deciding that per utterance is exactly the classifier in the hot path that
PRD 3 rejected for being slow and occasionally wrong. The likely answer is a
chair who hands out the floor — which is what Jarvis already is.

Raised 2026-09-11; a weekend project at most.
