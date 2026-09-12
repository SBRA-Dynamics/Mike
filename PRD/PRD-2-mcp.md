# PRD 2 — MCP tool surface

The tools Mike acts through, served by the same process that owns the sessions.

## Goal

Mike must be able to create a worker, switch the conversation to it, list what
exists and read what another worker said — by being asked in plain language, not
by emitting a magic string the server parses.

## Why MCP rather than parsing his answers

The alternative is having Mike reply with something like
`ACTION: spawn_worker(name=Bosse)` and regex it out of his text. That fails in
the ways such schemes always fail: he explains what he is about to do and the
parser fires twice, or he phrases it slightly differently and it fires never,
or he mentions the format while discussing it and it fires when it should not.

Claude Code supports `--mcp-config`, so tool calls are first class: structured,
typed, acknowledged, and never confused with prose. This also means Mike can
decide *not* to act and simply answer — which a parser cannot represent.

## The plumbing problem

MCP servers are normally spawned as child processes by the client. Here the
tools must manipulate **the already-running Mike server** — its session
registry, its worker map. A freshly spawned child process knows nothing about it.

Design: the MCP server is a thin stdio adapter that forwards every tool call to
the running server over **loopback HTTP**, authenticated with the same token.
The adapter is stateless; the running server is the single source of truth.

```
claude (Mike) ──stdio──► mcp-adapter ──HTTP 127.0.0.1──► Mike server
```

The adapter is generated or configured per Mike invocation with
`--mcp-config`, pointing at the loopback port and carrying the token.

Alternative to evaluate first: Claude Code also accepts HTTP/SSE MCP servers. If
that path works, the server can expose MCP directly and the adapter disappears.
**Try that first** — one less moving part.

## Tools

| tool | arguments | returns |
|---|---|---|
| `list_workers` | — | name, id, model, cwd, busy, last activity |
| `spawn_worker` | `name`, `systemPrompt`, `model?`, `cwd?`, `prompt?` | the new worker, and switches to it |
| `switch_worker` | `name` | the now-active worker |
| `leave_worker` | — | confirmation; back with Mike, worker left running |
| `end_worker` | `name` | confirmation |
| `read_worker` | `name`, `turns?` | recent transcript of another worker |
| `rename_worker` | `name`, `newName` | confirmation |

Deliberately **not** a tool: running shell commands. Mike is a Claude Code
session and already has `Bash`. Adding a second path to the same capability
would only create ambiguity about which one he should reach for.

### Naming

Workers are addressed by **name**, not id, because the names come out of a
voice: "Bosse", "byggaren", "the one doing the tests". The server maps a spoken
name to a session id, case-insensitively and tolerant of dictation noise — the
same normalisation the rest of the system uses.

A name collision must fail loudly rather than silently reuse an existing worker.

### Model selection

`spawn_worker(systemPrompt)` is required, not optional: measured, Mike otherwise
wrote the worker's standing instructions into `prompt`, where they are said once
and scroll away. `spawn_worker(model)` accepts what the user says — "opus", "sonnet", "haiku",
"opus 5" — and maps it to a model id. An unknown model is an error with the
list of valid ones, not a silent fallback to the default: being given a
different model than you asked for is worse than being told no.

## Requirements

### R2.1
Tool calls mutate the live server state and are visible to every connected
client within one message round trip.

### R2.2
`spawn_worker` switching the active conversation is **part of the tool**, not a
separate call. The user's phrasing — *"start a new worker called Bosse"* — is one
intent, and splitting it into two tool calls invites Mike to do only half.

### R2.3
Every tool call is logged with arguments and result, and surfaced to the client
as an `event` message so the user sees what Mike did, not just what he said.

### R2.4
Tools are only exposed to Mike. Workers must not be able to spawn workers;
that is an orchestration privilege and a recursion hazard.

### R2.5
A tool call that fails returns a message written to be **read aloud on a lens** —
short, specific, no stack traces.

## Acceptance criteria

1. Asking Mike in Swedish to start a worker called Bosse creates it, switches
   to it, and the client shows both the event and the new active worker
2. Asking him to list workers returns what actually exists in the server
3. A worker cannot call the tools
4. Restarting the server does not orphan workers — they are re-attachable by
   name from the session store
5. An unknown model name produces a useful error, not a silent substitution

## Open questions

- HTTP/SSE MCP directly from the server, or stdio adapter? Resolve by
  experiment before writing either.
- Should `read_worker` return raw transcript or a summary? Raw is honest but
  expensive in Mike's context. Possibly `turns` defaulting small.
