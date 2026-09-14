# Mike — overview and phase map

## What this is

A voice-first assistant that runs on Mannie's own machine and is used through
Even Realities G2 smart glasses, a phone, or a desktop browser. You talk to one
persistent agent — **Mike** — who orchestrates a set of **workers**: real
Claude Code sessions doing the actual work.

Everything runs on hardware Mannie owns. No third-party tunnel, no hosted
gateway, no speech sent to an external API.

## Fixed decisions

These are settled and not revisited by the phase PRDs:

| | |
|---|---|
| Client | Even Hub SDK plugin (Vite + TypeScript) |
| Server | Node.js |
| Work engine | Claude Code, driven per worker |
| Speech-to-text | Runs on the server (RTX 5060 Ti, 16 GB) |
| Hosting | The server also serves the built client |

## What the user asked for

1. Start a conversation with Claude Code **on the PC or in the glasses**
2. Continue it **hands-free** in the glasses — no push-to-talk
3. **Switch between PC and glasses inside the same conversation**
4. A main agent, **Mike**, who is always the same conversation and acts as the
   menu: starting or resuming a session means talking to Mike
5. Ask Mike to **switch the current conversation to a new worker with a model
   I name**, or to resume an existing one
6. **Mike always sees the worker conversation** and acts when addressed —
   saying *"Mike, start a new worker called Bosse"* mid-conversation must
   create it and switch the active conversation to it
7. Ask Mike to **run shell commands mid-conversation**, using conversational
   context — *"list the files in the folder we are talking about"*

## Phases

| PRD | Scope | Main risk |
|---|---|---|
| **1** | Server foundation: TLS, HTTP, WebSocket, static hosting, wire protocol, auth, ops | A long-lived stream being cut by the runtime |
| **2** | MCP server in the same process: the tool surface Mike acts through | Getting tool calls back into a running server |
| **3** | Mike + workers: identity, routing, context injection, handoff, end-to-end tests | Routing correctness; Mike doing the work himself |
| **4** | Even Hub SDK client: lens view + companion view | Lens is 50×10; everything must fit |
| **5a** | Voice from the browser: capture, VAD, segments, server-side STT, addressing modes | Whisper latency, VAD splitting sentences |
| **5b** | Voice from the glasses: the G2 mic array as a source for 5a's pipeline | Battery, bandwidth, speakerRole accuracy |
| **6** | Latency: streaming the turn, saying what it is doing | Cold start per turn |
| **7** | Mail, provider-neutral: accounts, tokens, the provider contract, quarantined reading | Mail text reaching a model that has Bash |
| **7a** | Gmail provider | Google's 7-day refresh tokens for unverified apps |
| **7b** | Outlook provider (Microsoft Graph) | `$search` and `$filter` cannot be combined |

Phases 1–3 need no glasses. Phase 4 makes the client real.

Phase 5 is split because every unknown in it is a *glasses* unknown — battery,
BLE bandwidth, whether an always-on microphone on someone's face is practical.
None of those are unknowns about transcription, segmentation or addressing. So
5a builds the whole pipeline against a microphone that is always available and
costs nothing to test, and is useful on its own for dictating from the desktop;
5b then has one job, which is to turn glasses audio into the segments 5a already
handles. If the hardware turns out not to allow always-on capture, 5a is
unaffected and the product still works.

## Architecture

```
   glasses (lens)  ◄── SDK ──┐
                             │
   phone / browser  ────► Even Hub plugin ──WSS──► Mike server ──► Claude Code
        (mic, text)                                    │              (workers)
                                                       ├──► MCP tools
                                                       └──► whisper (STT)
```

One server process owns: TLS, the static client, the WebSocket protocol, the
session registry, the MCP tool surface, worker lifecycle, and transcription.

## Hard-won facts that constrain the design

Carried over from the exploratory work; these are measured, not assumed.

- The lens is **576 × 288 px, 4-bit green**, and about **50 columns × 10 rows**
  of the fixed firmware font. Replies must be short by design, not by politeness.
- Any round trip to the glasses costs **~160 ms minimum**; a full-lens image is
  ~1.4 s. Text is the only interactive-feeling channel.
- Node's own `https.Server` **cut every long-lived SSE stream at exactly 30 s**
  on this network path. A raw TCP TLS bridge in front did not. The cause was
  never identified — PRD 1 must prove the chosen transport survives, early.
- Dictation never produces `/`, capitalises the first word, and appends a full
  stop. Any text arriving from voice needs normalisation before use.
- Claude Code supports `--session-id`, `--resume`, `--model`, `--mcp-config`
  and `--append-system-prompt`, which is what makes workers and Mike possible
  without inventing an agent runtime.

## Non-goals

- Compatibility with Even Realities' own terminal app. It shaped the previous
  attempt and every accommodation cost more than it returned.
- Custom glasses firmware. Interesting, and out of scope.
- Multi-user. One person, one machine.
- Cloud anything.
