# PRD 8.1 — The watch: status and remote control

One job: look at the wrist and know who is working, who is waiting for you, and
be able to switch to them or stop them — on a battery that lasts a day.

## Goal

Mannie raises the wrist, taps the screen, and within a few seconds sees:

- Mike and every worker, with which of them is busy
- which of them is waiting — a question, a moved-over session, a remark
- which one the conversation is with

and can tap a name to switch to it, or stop the turn that is running. The screen
goes dark by itself and the watch lasts a working day.

## Scope

No audio, in either direction. No typing — the keyboard (`firmware/keyboard/`)
does that, and keeps doing it while the watch is in use. What is new is a
client in C that is sent the conversation rather than only sending to it, a
server that places two kinds of device without either one pulling the other
along, and a battery that cannot afford a radio that is always awake. The
protocol gains one role and one event, both usable by every client (R8.1.2,
R8.1.3).

## Why this phase decides the rest

Everything later on the watch — a spoken reply arriving, a notice while the
screen is dark — depends on whether the watch can keep a socket open while it
sleeps. That is a property of this board's Wi-Fi power save, the server's ping
interval and a 400 mAh cell, and none of it is documented (PRD 8.0, *The
hardware*) — Waveshare's own figure of about six hours "in low power" is the
only number there is, and it is not a day. So the sleep strategy is measured and
chosen here, with nothing else in the way, before a phase that needs it is built
on top.

## Requirements

### R8.1.0 — Shared firmware first, with the keyboard as the test

Before any watch screen exists, the parts of `firmware/keyboard/main/` that
PRD 8.0 marks as reused move to `firmware/components/`, one ESP-IDF component
each, and both projects list that directory in `EXTRA_COMPONENT_DIRS`:

```
firmware/components/mike_protocol/   generated header (PRD 8.0)
firmware/components/mike_link/       the WebSocket link
firmware/components/mike_settings/   URL, token, admin password
firmware/components/mike_wifi/       networks, scan, reconnect
firmware/components/mike_ota/        web page, update, rollback — a page section per device
firmware/components/mike_power/      AXP2101
firmware/components/mike_reset/      hold BOOT to erase
```

Board-specific code stays in each project: the display bring-up (the 1.8's
TCA9554 touch-reset pulse has no counterpart on the 2.06), USB HID on the
keyboard, the IMU, motor and audio on the watch.

The move is done in its own commits, the keyboard is rebuilt from them and
flashed over WiFi, and it must still do what its README says — type into the
lens, `Ctrl+C` a turn, update over WiFi, reset with BOOT — before a line of the
watch is written. Every later change to a shared component is checked against
the keyboard the same way.

### R8.1.1 — Setting the watch up

As on the keyboard, and with the same pages, so there is one way to set up a
Mike device:

1. **On the watch.** The settings screen opens by itself when no network is
   stored. A network is chosen from a scan or typed, its password typed on an
   on-screen keyboard, and an **admin password** of at least six characters is
   set. The watch keeps **several** networks, tried last-successful first —
   home, office, the phone's hotspot — where the keyboard, which never leaves the
   desk, keeps one. The screen is reachable later from a *Settings* row at
   the end of the list, not from a button: BOOT is reserved for recovery.
2. **On the web page** — `http://mike-watch.local/`, with the admin password:
   Mike's URL (`https://kontoret.onvo.se:3456`, what the phone uses) and the
   token. Saving restarts the watch.

`npm run device -- pair <host>` does step 2 from the machine: it reads
`MIKE_PUBLIC_URL` and `MIKE_TOKEN` from `~/.config/mike/env`, asks for the
device's admin password, and posts them to `/api/mike` — the same endpoint on
the keyboard and the watch, so a rotated token is two commands and no typing.

The web page and firmware updates run **only while the watch is on USB power**.
A web server on a wrist on battery is a radio and a listening port for nothing;
on the charger, it is where the watch is updated. The keyboard, which is always
powered, is unchanged.

Updates and recovery are the keyboard's: two app partitions (larger on the
watch's 32 MB flash), a new image on probation until it reaches WiFi and then
the server, rollback otherwise; BOOT held 10 s and a 5 s countdown erase every
setting.

### R8.1.2 — Connection, and following the phone

**On the watch**, `mike_link` from R8.1.0, extended:

- `hello` with the token, `role: "watch"`, and — when it has them — the session
  id and cursor it last had, kept in RTC memory (`RTC_DATA_ATTR`) so they
  survive deep sleep. **No session is chosen by the watch.**
- It is sent the conversation, so it parses what it receives (cJSON, into
  PSRAM) instead of looking for two strings, and its receive buffer grows to the
  largest frame it accepts — 256 KB, which is a long answer; anything larger is
  logged and skipped, not a reason to drop the socket.
- It waits on the socket with `select` and a timeout rather than the keyboard's
  20 ms polling loop, so light sleep can happen between messages. The keyboard
  may keep its loop; a keystroke's latency is its whole point.
- TLS session resumption, so a wake does not pay a full handshake.
- The certificate is verified with the ESP-IDF bundle against the URL's host,
  as on the keyboard. A close with `CLOSE.UNAUTHORIZED` stops retrying and shows
  *pair again*: retrying a refused token only drains the battery.

**On the server**, `src/keyboard.js` becomes `src/devices.js`: one hub that
places every connection with a role.

- A **conversation client** is a connection without a role: the glasses, the
  phone, a browser. Only these decide where a conversation is.
- A **device** is a connection with a role — `keyboard` or `watch`. It follows
  the conversation clients by the keyboard's rule (stay while your conversation
  still has a conversation client attached; otherwise move to the most recently
  active one that has), and that rule counts **conversation clients only**. Today
  it counts every socket, which with two devices means the watch holds the
  keyboard on an old session and the keyboard holds the watch.
- A **keyboard** is sent nothing but `ready` and errors, as today.
- A **watch** is attached to the session it is placed in, like a conversation
  client, and receives everything that session emits. Its `hello` session id and
  cursor are used for replay only when the hub places it in that same session;
  otherwise it gets a fresh `ready` for the new one. When the phone moves, the
  hub detaches the watch, attaches it to the new session and sends it a new
  `ready` with `moved: true` — the watch redraws from it rather than from its
  reducers, because nothing it knew belongs to the new conversation.
- A watch may send `say`, `audio`, `speaking`, `interrupt` and the controls
  `switchWorker`, `history` and `clientLog`. It may not `deleteSession` or ask for
  an `mcpGrant`: nothing on a wrist needs either.
- `ROLE` in `src/protocol.js` gains `WATCH`, and `validateC2S` accepts it.
- Logs name the role: `hello from watch …`, `watch 192.168.1.40: …`.

The keyboard's drafts and presence (`event` `draft`, `event` `keyboard`) reach a
watch like any other transient event on its session. In this phase the watch
ignores them.

### R8.1.3 — A live worker list, for every client

Today a client learns who is busy only from `ready`; `state` carries `busy` for
the session's own active worker, and nothing is sent when a worker the user is
not talking to starts or stops. That is fine on a lens that shows one
conversation and not fine on a screen whose whole purpose is the list.

The server sends a **transient** `event` `workers` to every attached session
whenever the registry changes — a worker spawned, ended, renamed, reset, or its
`busy` flipped:

```js
{ type: "event", kind: "workers", data: { workers: [{ name, model, busy }] } }
```

Transient (`session.transient`), because it is a fact about this moment and
`ready` already carries it to anyone who connects later. The full list every
time, not a diff, for the same reason `turn` sends all its parts: a client that
missed one still draws the right thing.

`cwd` is left out: a watch has no use for a path, and the phone already gets it
from `ready`.

### R8.1.4 — Waiting marks

The watch reduces `workerNotice`, `workerMoved`, `workerSwitched` and
`noticesDismissed` exactly as `client/src/state.ts` does: a question stays until
the user is in front of that worker, a moved session stays until switched to, a
remark fades after `NOTICE_MS`. The rules are the client's; the watch copies
them rather than inventing its own, and the test in R8.1.11 holds the two to the
same fixtures.

### R8.1.5 — The screen

Black background; nothing lit that is not information.

**Face** — what a wake shows first:

- the time, large (RTC, corrected by SNTP when online)
- battery percent and charging, read from the AXP2101 over I2C on every wake
  and once a minute while awake — its IRQ is not wired to the ESP32, so nothing
  is pushed
- connection: a dot, or the word *offline* / *pair again*
- one line under the time: the same notice text the lens header shows
  (`Bosse asks`, `2 spoke`), or nothing

The panel is 410 × 502 with rounded corners behind the case; nothing is placed
in the corners.

**List** — a swipe from the face:

- *Mike* first, then workers newest activity first, as `registry.list()` orders
  them
- each row: name, a busy mark, a waiting mark by kind
- the active one is marked; there is always exactly one active, Mike included

**Last answer** — a swipe from the list: the most recent non-background `text`
in the session, scrollable, with who said it. Read-only. It is there because
switching to a worker without being able to see what it said is a remote
control with no screen.

Text is Swedish and English, so the font must cover Latin-1: LVGL's built-in
Montserrat fonts stop at ASCII. A Montserrat subset with `å ä ö é ü` and the
typographic dash and quotes is generated with `lv_font_conv` and checked in.

### R8.1.6 — Control

| gesture | where | action |
|---|---|---|
| tap a row | list | `control` `switchWorker` `{ name }`, or `{ name: null }` for Mike |
| long press | anywhere, while busy | `interrupt` |
| PWR, short press | anywhere | wake; while awake, back to the face — the watch's crown |
| tap | dark screen | wake, when the strategy allows it (R8.1.8) |
| swipe | face ↔ list ↔ last answer | move between screens |

The PWR button is read on GPIO 10, so a short press is the firmware's. The long
hold stays the AXP2101's: it powers the watch off, and nothing in the firmware
may change that, because it is the one way out of a firmware that has hung.
BOOT is not used while running: it is the download-mode button, and a firmware
that gives it a meaning teaches the hand to press it during a flash.

The stop is a long press, not a tap, because a stop that happens by brushing a
sleeve against the screen loses work. The screen confirms with the server's own
*Stopped.* or *Nothing running.*, not with an optimistic local message.

A tap on the active worker's row does nothing and says nothing.

### R8.1.6a — The motor

The watch buzzes once, short, when a waiting mark of kind *question* or *moved*
appears while the watch is connected, and never for a remark. A question is the
thing that cannot be allowed to fade (PRD 4's notice rule); a remark that buzzes
teaches the wrist to ignore the buzz. No buzz while the screen is on and showing
the list: the user is already looking.

The motor is off whenever the watch is not connected — a buzz for something
learned from a replay minutes later is a lie about when it happened.

### R8.1.7 — The display sleeps

Off after 10 s without touch. Brightness defaults low (the BSP's scale, 30) —
this is a watch, read from half a meter. A wake that finds a waiting mark keeps
the screen on 5 s longer.

### R8.1.8 — The watch sleeps

Two strategies, and this PRD does not choose between them: the measurements in
*Risks* do.

**A — Deep sleep.** Screen off, Wi-Fi off, chip in deep sleep. A press on PWR
or a raised wrist wakes it — **not a tap**: the touch interrupt is on GPIO 38,
which cannot wake an ESP32-S3 from deep sleep. The watch connects, resumes with
its cursor, draws, and sleeps again when the screen goes off. Cheapest standby.
Nothing arrives while asleep, and every glance pays a Wi-Fi association and a
TLS resumption.

**B — Light sleep, connected.** Screen off, automatic light sleep, Wi-Fi in
modem sleep on DTIM. The socket stays open; the server's 20 s ping keeps it
alive and wakes the radio. A tap wakes it (GPIO wake-up from light sleep works
on any pin), a glance is instant, a question can buzz the motor, and every later
phase gets a live connection for free. Costs whatever that radio costs, which is
the unknown.

Whichever is chosen, one rule holds for both: **while a turn the user started
from this session is running (`state.busy`), the watch stays connected** with
the screen off, and goes back to its sleep strategy a few seconds after `busy`
turns false. The answer is the thing the user is waiting for; losing it to
sleep would make the watch useless for exactly the case it exists for.

Wake sources, to be confirmed by measurement:

| source | pin | deep sleep (A) | light sleep (B) |
|---|---|---|---|
| PWR button | GPIO 10 (`SYS_OUT`, high while pressed) | yes (ext1, high) | yes |
| wrist raise | GPIO 21 (QMI8658 INT1) | yes, if the IMU's motion detection runs while the chip sleeps | yes |
| touch | GPIO 38 (FT3168 INT) | **no** — not an RTC pin | yes, if the FT3168's own low-power mode still raises INT on a touch |
| RTC alarm | GPIO 39 | no — not an RTC pin; the ESP32's timer is used instead | yes |
| PMU events | not wired | no | no |

A press on PWR is how a watch is woken anyway, so strategy A is usable with a
button alone. The wrist raise is what would make it good; if it cannot be made
reliable, A is a press-to-look watch, and that is a legitimate outcome.

### R8.1.9 — Budget

A working day: 10 hours off the charger with 30 glances, each ~10 s of screen,
and 5 turns followed to the end. That is roughly **40 mA average** from a
400 mAh cell with no margin, so the realistic target for standby is well under
that. Waveshare's FAQ gives 3–4 hours with the screen off and about 6 hours in
low power, which is either a configuration this PRD can do better than or a
sign that the day is not reachable; the measurements say which. The measurements decide whether A or B meets it; if neither does, B is
dropped and A with a shorter day is what ships, and the PRD says so.

### R8.1.10 — Errors reach the server's log

The watch has no console on a wrist. Anything that goes wrong — a TLS failure, a
refused message, a reset reason after a crash — is sent as
`control` `clientLog` once connected (R1.5) — the keyboard's `mike_link_log`,
which the server logs under the device's role — and kept in RTC memory until
then. The reset reason after a watchdog or panic is always sent on
the next boot.

### R8.1.11 — Tests without the watch

- The reducers for the worker list and the waiting marks are plain C with no
  ESP-IDF dependency, built for the host and run against the same event
  fixtures the client state is tested with (`test/prd4.mjs`, `test/prd5b.mjs`),
  extracted into `test/fixtures/events/` so both suites read one copy.
- `test/firmware-protocol.mjs` fails if
  `firmware/components/mike_protocol/include/mike_protocol.h` does not match
  what `npm run firmware:protocol` would generate.
- The server's `workers` event is covered in `test/prd3.mjs`: spawn,
  end, rename and a turn each produce exactly one event with the full list.
- `test/devices.mjs` replaces `test/keyboard.mjs` and keeps every check in it,
  and adds the case this PRD exists for: a phone, a keyboard and a watch
  connected together; the phone reconnects under a new session; the keyboard
  and the watch both move to it, in either order of connecting, and neither
  stays behind because of the other. A watch that says hello with a session
  that is not where the phone is gets `ready` for the phone's, with no replay
  from the other.

## Risks, to be measured before the sleep strategy is built

Each is a small firmware test on the bench, with the AXP2101's battery current
logged every second. None needs the UI.

| risk | test | decides |
|---|---|---|
| **Deep sleep current** | deep sleep with GPIO 10 (ext1) and GPIO 21 wake armed, IMU in motion detection, 10 min | A's standby |
| **Connected light sleep current** | WSS open, server pinging every 20 s, DTIM 1 and 3, 10 min each | whether B is possible at all |
| **Wake to ready** | wake → `ready` received, 20 times, cold and with TLS resumption | A's glance cost, and whether A feels usable |
| **Wrist raise** | QMI8658 wake-on-motion thresholds against 30 raises and 30 minutes of walking | whether A can be woken without a button, and how often it wakes for nothing |
| **Touch in light sleep** | does the FT3168 in its low-power mode raise GPIO 38 on a tap | whether B can be woken by a tap |
| **PWR wake** | deep sleep with ext1 on GPIO 10, 20 short presses; check the AXP2101 does nothing on a short press while on | that PWR is the wake button |
| **Screen on** | AMOLED at brightness 30 with the face drawn, Wi-Fi off | the per-glance cost |
| **Motor** | first, whether a motor is fitted to P1/P2 at all; then one 80 ms buzz, current, and whether it is felt through the strap | R8.1.6a — without a motor, the notices are visual only and R8.1.6a is dropped |

## Acceptance criteria

1. A freshly flashed watch is set up with WiFi and an admin password on the
   watch and `npm run device -- pair mike-watch.local`, with no other step; the
   same command re-pairs the keyboard
2. The keyboard, rebuilt on `firmware/components/`, still types into the lens,
   stops a turn with `Ctrl+C`, updates over WiFi and resets with BOOT
3. With the glasses, the keyboard and the watch all connected, a line typed on
   the keyboard becomes a turn whose answer appears on the watch's last-answer
   screen; after the phone reconnects under a new session, both devices are in
   it within a second
4. A worker spawned by voice from the glasses appears on the watch's list
   without touching the watch, if the watch is awake
5. A worker that finishes while the user talks to someone else shows its waiting
   mark on the watch face at the next wake, and the mark matches the lens
6. Tapping a worker on the watch switches the glasses' conversation to it
7. A long press while a turn runs stops it; the watch shows the server's answer
8. A rotated `MIKE_TOKEN` makes the watch stop retrying and say *pair again*
9. A turn started from the glasses while the watch sleeps is visible as finished
   on the next wake; a turn followed on the watch delivers its answer without a
   second tap
10. `å ä ö` render correctly in a worker name and in the last answer
11. A worker asking a question buzzes the connected watch once; a remark does not
12. A crash is visible in `~/mike-server.log` after the next boot, logged as the
    watch's
13. On battery, `mike-watch.local` does not answer; on the charger it does
14. The measured day (R8.1.9) is written into this PRD, with the strategy it
    chose

## Files

```
firmware/components/                 R8.1.0 — moved from firmware/keyboard/main, shared
firmware/keyboard/                   rebuilt on the shared components, behavior unchanged
firmware/watch/                      ESP-IDF project (idf.py -C firmware/watch build)
firmware/watch/main/app.c            startup order: WiFi, then display, then UI
firmware/watch/main/model.c          worker list and waiting marks — host-buildable
firmware/watch/main/ui.c             face, list, last answer
firmware/watch/main/settings_ui.c    WiFi networks and admin password, by touch
firmware/watch/main/sleep.c          sleep strategy, wake sources, motor
firmware/watch/main/fonts/           Latin-1 Montserrat subsets
firmware/watch/partitions.csv        two app partitions sized for 32 MB
firmware/watch/sdkconfig.defaults    the keyboard's load-bearing settings, confirmed on the 2.06
firmware/watch/test/                 host build of model.c against fixtures
scripts/device.mjs                   pair (either device); firmware:protocol
test/devices.mjs                     replaces test/keyboard.mjs
test/firmware-protocol.mjs
```

Server: `src/keyboard.js` becomes `src/devices.js` (R8.1.2), `src/connection.js`
places watches as well as keyboards, `src/protocol.js` gains `ROLE.WATCH` and
documents the `workers` event, and `src/handler.js` or `src/workers.js` emits it
(R8.1.3).

## Non-goals

- Audio. PRD 8.2 and 8.3.
- Typing, or reading the full transcript. The phone does that.
- Changing the mode, ending or spawning workers from the watch. Mike does that
  when asked, and 8.2 lets the watch ask.
- Typing on the watch. The keyboard is the keyboard.
- Setting up WiFi from the phone (SoftAP or BLE provisioning). The on-watch
  screen is enough for a device that is set up once.

## Open questions

- **Which conversation client leads.** The hub's rule prefers the conversation
  a device is already in while it has a client, else the most recently active.
  With the glasses and a desktop browser in two different sessions, the devices
  go where they were first and stay. If that turns out wrong in use, a device
  could follow the glasses specifically — which needs the glasses to say they
  are the glasses.
- **The keyboard's drafts on the watch.** The line being typed reaches the
  watch already. Showing it under the time costs nothing on the server; whether
  it is useful on a wrist next to a keyboard is not obvious.
- **Notices after a gap.** Waiting marks are client state rebuilt from events
  (R8.1.4). After a long deep sleep beyond the 500-message replay buffer they
  are lost. If that happens in practice, `ready` can carry the session's
  current marks — which moves notice state onto the server, a change to PRD 4's
  division of labor that should be made for every client or not at all.
- **Flash encryption.** Makes pulling the token out of a lost watch harder, and
  makes every reflash slower and a mistake permanent. Not now.
