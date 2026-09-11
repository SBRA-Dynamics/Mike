# PRD 4 — The Even Hub SDK client

One plugin, two faces: the lens and the companion view.

## Goal

A single Even Hub plugin, served by the Jarvis server, that works on a desktop
browser, on the phone alone, and on the phone with glasses attached — without
separate builds or a development mode that drifts from the real thing.

## How an Even Hub plugin actually works

Worth stating because it shapes everything: the plugin is a web app running in a
WebView **on the phone**. The glasses are an output device it drives over BLE
through the SDK, plus an input device for four gestures. There is no code
running on the glasses.

So the plugin always has two surfaces:

- **Companion view** — ordinary HTML in the WebView. What the phone shows.
  Transcript, input, settings, and later the microphone.
- **Lens view** — SDK containers. 576 × 288, about 50 × 10 characters of a fixed
  firmware font, green on transparent.

Both are driven from the same WebSocket, so they cannot disagree about what was
said.

## Requirements

### R4.1 — Same origin, no configuration

The client is served by the Jarvis server (PRD 1 R1.2), so it knows its own
server address. No URL field, no token to paste in normal use. A settings panel
exists for development and for pointing at another host.

### R4.2 — Lens view

One full-lens text container, updated with `textContainerUpgrade`.

- Content is the **latest thing said**, not an accumulating scroll. Ten rows
  vanish quickly and the last answer is what the user looked up to read.
- Wrapped to 50 columns in the client, so what the user sees on the desktop
  preview is exactly what the firmware will render.
- Overflow is indicated, never silently cut: the user must know there is more.
- A short header line shows **who is speaking** — Jarvis or the worker's name.
  With ten rows, this is one row spent on the most important thing.

Deliberately a single text container: a nicer layout needs
`rebuildPageContainer`, which flickers and costs a measured round trip, and the
lens has no room for chrome anyway.

### R4.3 — Gestures

| gesture | action |
|---|---|
| tap | show more of a truncated reply, else repeat the last |
| swipe up/down | scroll within a long reply |
| double tap | system exit dialog (mode 1 — required, QA rejects mode 0) |
| long press | reserved for push-to-talk fallback (PRD 5) |

### R4.4 — Companion view

- Transcript, both sides, tagged by speaker
- Text input for typing what you would say — the development and fallback path
- A **lens preview**: the real 50 × 10 box, rendered on the phone and the
  desktop. This is how layout problems are found without wearing anything
- Current worker, connection state, and what Jarvis last did (`event` messages)
- Settings behind a control, not in the way

### R4.5 — Connection

- Reconnect automatically with backoff; the user should never press anything
- Resume with the sequence number so a reconnect replays only what was missed
- Connection state is visible but not loud
- The app must survive the phone backgrounding the WebView: on resume,
  reconnect and catch up rather than showing a stale screen

### R4.6 — Degrade honestly

No glasses present is a normal state, not an error. Detect the host properly —
the Flutter channel the Even App injects, not `waitForEvenAppBridge()`, which
resolves with a stub in a plain browser and then fails when asked to create a
page. Without a host, run companion-only and say so once.

### R4.7 — Persistence

Settings go through the SDK's own storage. The WebView's `localStorage` does not
reliably survive an app restart; browser storage is the development fallback only.

## Non-goals

- Rendering images on the lens. Measured at ~1.4 s for a full frame; text is the
  only interactive channel.
- A separate desktop client. The same build runs in a browser tab.
- Offline operation.

## Acceptance criteria

1. Opening the server's URL in a desktop browser gives a working client with no
   configuration
2. The lens preview is exactly 10 rows and never exceeds 50 columns
3. With glasses attached, lens and companion show the same text
4. Killing the network for 30 s and restoring it reconnects and catches up,
   without duplicated messages
5. Double tap exits through the system dialog
6. The active worker's name is visible on the lens
7. A reply longer than ten rows is readable through tap or swipe, never
   silently truncated

## Open questions

- Should the lens show the user's own words back after transcription, or only
  the reply? Showing them confirms recognition but costs rows. Probable answer:
  show briefly, then replace with the reply.
- Worker switching from the glasses alone, without speaking — is a gesture-driven
  worker list worth the rows? Deferred until the voice path exists.
