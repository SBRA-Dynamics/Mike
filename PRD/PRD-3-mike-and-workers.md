# PRD 3 — Mike and workers

The orchestration layer: who you are talking to, how the system knows, and how
work gets delegated.

## Goal

One agent, always the same conversation, who is what you reach when you start or
resume a session — and who can put you in front of a worker, take you back, and
act on what the worker said.

## The model

**Mike** is a single long-lived Claude Code session with a stable id. He is
never replaced, never forked, and survives server restarts. He owns the MCP
tools from PRD 2.

**Workers** are Claude Code sessions doing the actual work. Each has a spoken
name, a model, a working directory, and its own transcript. Workers have no
tools beyond Claude Code's own; they do not know the orchestration exists.

**The active worker** is who your words go to. Exactly one, or none — in which
case you are talking to Mike directly.

## Routing

Every utterance is classified before anything else sees it:

1. **Addressed to Mike** — begins with his name ("Mike, ...", "Hey Mike",
   "Mike: ..."). Goes to Mike with worker context attached.
2. **No active worker** — goes to Mike. Starting a session means talking to him.
3. **Otherwise** — goes to the active worker verbatim.

Name-prefix routing is deliberate and not an LLM decision. It is instant, free,
predictable, and the user controls it by how they speak. A classifier in the
path would add latency to every turn and be wrong occasionally, which is worse
than a rule that is wrong never.

The prefix is stripped before Mike sees the text. Dictation variants
("Mike." / "Mike," / "mike") all count, and the check runs after the same
normalisation used everywhere else.

### The prefix requirement is conditional

Whether a prefix is required at all is set by the **addressing mode** defined in
PRD 5a R5a.4 — `ByName` (the default) requires it, `Always` does not, `Ignore`
drops everything but the mode commands, and `PushToTalk` requires no prefix but
only hears what is said while the touchpad is held. The routing rules above describe
`ByName`; in `Always` every utterance goes to the active worker, or to Mike
when there is none, and a prefix still overrides.

The mode commands are matched before the mode gate, in every mode, so there is
no state the user cannot speak their way out of.

**The gate applies to speech, not to the keyboard (decided 2026-09-11.)** The
addressing mode exists to filter ambient speech — the wearer talking to someone
else in a kitchen. Typing has no ambient problem: a typed line was aimed at the
machine by the act of typing it. So an utterance carries its origin, and only
`voice` is gated. Addressing still *works* when typed ("Mike, ..." routes to
him and the prefix is stripped); what typing skips is the requirement to
address. `Ignore` therefore pauses listening, not the keyboard, and the lens
still reads "paused" because that is the truth about the microphone.

Without this, the mode is one setting per session while the session deliberately
spans the PC and the glasses (requirement 3) — so choosing `ByName` for the
kitchen would have forced every typed line on the desktop to begin with a
worker's name. An utterance with no declared origin counts as speech: a client
that forgets to say what it is gets filtered rather than forwarding a dinner
conversation to a model.

### Escape hatch

If the prefix is ever ambiguous — a worker legitimately discussing someone named
Mike — the rule stays as written. Predictability is worth more than the rare
false positive, and the user can rephrase.

## Mike sees the worker conversation

Requirement 6 says Mike must always see the conversation and act when asked.

He is **not** fed every worker turn as it happens. That would double token spend
on every exchange, fill his context with work he is not doing, and make him
slower at the one thing he is for.

Instead, when addressed, the last N turns of the active worker are injected
ahead of the user's words:

```
[The user is currently talking to worker "Bosse" (opus, /home/user/projects/MyProject).
 Recent exchange:
   user: ...
   Bosse: ...]

The user says: list the files in the folder we are talking about
```

Observably identical to him having watched, at a fraction of the cost. N is
configurable; start at 6 turns, truncated to a token budget.

This is what makes *"list the files in the folder we are talking about"* work:
the folder is in the injected context, and Mike has `Bash`.

## Mike's system prompt

The prompt is a product surface, not an implementation detail. It must establish:

- **Identity**: he is Mike, the orchestrator. Concise, dry, not chatty.
- **Delegation**: his instinct is to route work to a worker, not do it himself.
  Without this he will start editing files, which is exactly what workers are for.
- **Brevity**: replies are read on a 50×10 lens. Two lines is a good answer.
- **Tool use**: create, switch, list and end workers through the tools rather
  than describing what he would do.
- **Context handling**: when given worker context, treat it as the subject; the
  user is asking about that, not about the orchestration.
- **Language**: reply in whichever language he was addressed in.
- **Dictation**: the input is spoken. Read for intent, prefer assuming over
  asking, because a clarifying question costs the user a spoken round trip.

The prompt ships as a file, versioned, editable without a rebuild.

## Worker lifecycle

| | |
|---|---|
| create | `spawn_worker`, or implicitly when Mike is asked to start work |
| name | spoken, unique, case- and dictation-insensitive |
| model | per worker, named by the user, validated |
| cwd | inherited from Mike's default, overridable per worker |
| resume | a worker is a Claude Code session; `--resume <id>` reattaches |
| end | explicit; transcript is kept |

A worker that has not been addressed for a long time is not killed. Claude Code
sessions are cheap at rest, and losing one you were going to come back to is
worse than an idle process.

## PC ↔ glasses handoff

Requirement 3: switch between PC and G2 inside the same conversation.

Workers are Claude Code sessions with ids the server owns, and their transcripts
live where Claude Code puts them. So:

- **Server → PC**: `claude --resume <worker id>` in a terminal continues the
  same conversation. Mike can be asked for the id.
- **PC → server**: a session started in a terminal can be adopted as a worker by
  id, taking a spoken name.

**Constraint to verify first**: two drivers of one session at the same time. A
terminal and the server both resuming the same id concurrently is likely to
interleave writes to one transcript. Handoff is the supported model; simultaneous
use probably is not. Test before promising it — this is test T1 and it shapes
what requirement 3 can honestly mean.

**Measured (T1, claude 2.1.268, 2026-09-11)**: nothing corrupts, and nothing
errors — turns are silently lost instead.

- *Sequential handoff works.* `claude -p --resume <id>` keeps the same session
  id, appends to the same `~/.claude/projects/<cwd>/<id>.jsonl`, and the next
  driver sees everything the previous one did. A terminal opened after a
  server turn read that turn back correctly. **Server → PC handoff is real.**
- *Two drivers at once fork the conversation.* Two `-p --resume <id>` started
  together both answered, both reported the same session id, and both appended
  to the one file — attaching their user message to the *same* parent. The
  JSONL is well formed; it is now a tree with two leaves. The next resume walks
  back from the last leaf, so exactly one branch survives: of CHARLIE and DELTA
  sent concurrently, the following turn listed "ALPHA, BRAVO, DELTA". CHARLIE
  was acknowledged with "OK" and then ceased to have been said.
- *A terminal and the server diverge the same way.* With an interactive
  `claude --resume <id>` open, the terminal's own view ended
  "…FOXTROT, GOLF" (its turn, not the server's) while a fresh resume after it
  read "…FOXTROT, HOTEL" (the server's turn, not the terminal's).
- *PC → server: not implemented, but not blocked.* The T1 run saw an
  interactive session write nothing to its transcript file, which would have
  made adoption impossible. That was the test setup, not the machine: on this
  box a live interactive session appends continuously (a running session's
  `~/.claude/projects/<cwd>/<id>.jsonl` was 9.5 MB and still growing while this
  was written). So a terminal-started session's turns *are* on disk and
  adoptable by id. It is simply not built — it falls outside R3.1–R3.7 — and
  whoever builds it measures the read path first.
- Turn cost, one-shot per turn: ~8.7 s cold, ~5 s warm (haiku, trivial prompt).

**What requirement 3 can honestly promise**: handoff, not sharing. The server
serialises its own turns per worker (one in flight at a time), and a worker id
handed to a terminal is a baton, not a second seat. Simultaneous use is not
supported and cannot be made safe from this side — the loss is invisible to
both drivers.

## Requirements

### R3.1
Starting or resuming a session with no active worker puts the user in front of
Mike.

### R3.2
A prefixed utterance reaches Mike with worker context attached, whatever
worker is active.

### R3.3
*"Mike, start a new worker called Bosse"* mid-conversation creates it, switches
the active conversation to it, and tells the user in one short line.

### R3.4
*"Mike, list the files in the folder we are talking about"* answers about the
active worker's directory, without the user naming it.

### R3.5
The active worker is visible to the client at all times and carried in the
`state` message, so both the lens and the phone can show who is listening.

### R3.6
Switching workers never loses a transcript. Coming back resumes where it left off.

### R3.7
Mike survives a server restart with his conversation intact.

## End-to-end test

A scripted run, no glasses, driving the WebSocket directly:

1. Connect; assert Mike greets
2. "Mike, start a worker called Bosse with sonnet" → worker exists, is active,
   model is correct
3. Ask Bosse something; assert the answer comes tagged as Bosse
4. "Mike, what is Bosse working on?" → answer references the exchange
5. "Mike, list the files in the folder we are talking about" → real listing
6. "Mike, start a worker called Kalle" → switches; Bosse still exists
7. "Mike, switch back to Bosse" → transcript continues, not restarts
8. Restart the server; reconnect; Mike and both workers are still there
9. `claude --resume <Bosse id>` in a terminal shows the same conversation

## Open questions

- When Mike is addressed mid-worker, should the **answer** come from Mike
  and then control return to the worker automatically? Assumed yes: a Mike
  aside does not change the active worker unless he switched it.
- Should workers be told they are workers? Probably not — it invites them to
  discuss the orchestration instead of working.
- What happens to a worker's in-flight turn when the user switches away? Assumed:
  it completes and its output is kept, just not shown live.
