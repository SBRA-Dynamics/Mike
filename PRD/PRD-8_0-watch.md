# PRD 8.0 — The watch

Mike on a wrist: a Waveshare **ESP32-S3-Touch-AMOLED-2.06**, which comes as a
watch with a case and a detachable strap. This document is the idea, the
hardware as it actually is, and the order the work is done in. The three phases
are their own PRDs:

| PRD | Scope | Main risk |
|---|---|---|
| **8.1** | Status and remote control: who exists, who is busy, who is waiting; switch, stop; sleep and wake | Battery — Waveshare's own figures are an hour at full brightness and about six hours in low power |
| **8.2** | Talk: hold to talk, see what was heard and what came back | Transcription quality from a wrist, and whether the second microphone helps |
| **8.3** | The voder: speech synthesis on the server, played on the watch (and any client with a speaker) | Latency from the first sentence to the first sound |

Everything after 8.3 — a wake word, Opus on the wire, shortcut tiles — is listed
under *Later* and specified only when it is started.

## Why a watch

The glasses are the main way in, and they have three gaps a watch fills:

- **When they are not on a face.** Charging, in the case, in a meeting, in the
  car. The conversation keeps running on the server; nothing today shows it
  without a phone in the hand.
- **A control surface.** The lens is 50 × 10 characters and four gestures.
  Switching worker or stopping a turn by voice works, but a tap on a name is
  faster and cannot be misheard.
- **A microphone that is not always on.** PRD 5b's battery and bandwidth
  numbers for continuous capture from the glasses are still unmeasured. A watch
  held to the mouth is a push-to-talk microphone that costs the glasses nothing.

And it keeps PRD 0's rule: the watch talks to the server on this machine and to
nothing else. No phone app in between, no vendor cloud.

## Why this board, and not the 1.8

The first draft of this PRD was written for the ESP32-S3-Touch-AMOLED-1.8.
Mannie replaced it with the 2.06 before anything was built, and the reasons are
worth keeping, because each one removes a problem the 1.8 version had to design
around:

| | 1.8 | 2.06 |
|---|---|---|
| form | bare board in a box case | a watch: case and strap |
| microphones | one, straight into the ES8311 | **two**, through an ES7210 ADC |
| echo reference | none — could not listen while playing | **the codec's output is fed back into the ES7210** (the schematic labels it *AEC*) |
| vibration | none | **motor pads driven from GPIO 18** |
| IMU interrupt | not wired | **QMI8658 INT1 on GPIO 21**, an RTC pin |
| PWR button | through the PMU only | **also on GPIO 10**, an RTC pin: it can wake the chip |
| schematic | not published | **published**, with a pin table |
| flash | 16 MB | 32 MB |
| display | 368 × 448 | 410 × 502 |

## What already exists: the keyboard

Mike already has an ESP32 device, built and running before this PRD:
[`firmware/keyboard/`](../firmware/keyboard/), an ESP32-S3-Touch-AMOLED-1.8
(the original SH8601/FT3168 revision, BSP 1.1.4) with a USB keyboard on it. It
types into the conversation on the glasses (`role: "keyboard"`,
`src/keyboard.js`), shows the claude.ai plan usage, and updates over WiFi. It
stays what it is: the 1.8 is the keyboard, the 2.06 is the watch, and **both are
used at the same time**.

It is the first template for the watch, ahead of anything from a vendor,
because it is ours, it speaks this server's protocol, and every part of it has
run on real hardware:

| in `firmware/keyboard/main/` | what it does | for the watch |
|---|---|---|
| `mike_link.c` | WebSocket client on esp-tls, hand-framed; hello, outbox, reconnect with back-off, 65 s silence timeout, Nagle off, `clientLog` forwarding. Measured 2–7 ms board to client on the LAN | **reused**, extended: receive and parse the conversation, `resumeFrom`, frames larger than its 8 KB receive buffer, and a wait on the socket instead of its 20 ms poll loop, which would keep a sleeping watch awake |
| `settings.c` | Mike as one URL (`https://kontoret.onvo.se:3456`) plus token, and an admin password, in NVS; the certificate checked against the URL's host | **reused as it is** |
| `wifi.c` | one stored network, scan, reconnect | **reused**, extended to several networks (home, office, the phone's hotspot) |
| `ota_server.c` | `http://<name>.local/`: `/info`, `POST /api/mike`, `POST /update`, admin password; two app partitions, a new image on probation until it reaches WiFi, rollback otherwise | **reused**, with the keyboard-only parts (Claude login) left in the keyboard |
| `factory_reset.c` | hold BOOT 10 s, then a 5 s countdown, erases every setting | **reused as it is** — BOOT is GPIO 0 on both boards |
| `power.c` | AXP2101 fuel gauge (register 0xA4), charging, USB power | **reused as it is** — the same PMU at the same address |
| `settings_ui.c` | WiFi and admin password on the board, driven by the keyboard | **rebuilt for touch**: the same screens with an on-screen keyboard |
| `keyboard_input.c`, `line_editor.c`, `usage_client.c` | USB HID host, the line editor, the plan usage | keyboard only |

What the keyboard also established, and the watch inherits as fact rather than
as a setting to try: WiFi before LVGL and `CONFIG_BSP_DISPLAY_LVGL_BUF_HEIGHT=10`
hold on a real board with this server; a URL with the public name works from the
LAN through the router (16 ms); settings on the board and a web page beat
anything compiled in; and a board whose firmware can break needs an OTA that
cannot take updating away.

### Both at once

The server was built for one kind of extra device, and two change what it has
to get right. PRD 8.1 carries the requirements; the reasons are here:

- **Following the phone.** A keyboard never names a session: `src/keyboard.js`
  types into the conversation that has a client attached, and moves when the
  phone comes back under another session. The watch needs exactly that rather
  than a session id pinned at pairing. But the rule counts *every* socket on a
  session, so a watch sitting on the old session would hold the keyboard there,
  and the keyboard's own rule would then hold the watch. Devices must follow
  the conversation clients — the glasses, the phone, a browser — and never each
  other.
- **Roles.** `hello.role` knows only `keyboard`, and a keyboard is sent nothing.
  A watch is a second role that *is* sent the conversation. The hub in
  `src/keyboard.js` becomes the place that places every device, whatever it is
  sent.
- **One protocol file.** Both firmwares speak the protocol from C. The keyboard
  writes its JSON by hand with the version as a literal; the watch would be a
  second copy. A header generated from `src/protocol.js` serves both.
- **Shared firmware.** The reused parts move to `firmware/components/`, both
  projects build against them, and the keyboard is the regression test for
  every change made there for the watch.

## The hardware, as read from the vendor's material

Checked against the vendor repository
([`waveshareteam/ESP32-S3-Touch-AMOLED-2.06`](https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-2.06),
cloned in `/media/Robin/GitHub/ESP32-S3-Touch-AMOLED-2.06`), its schematic V1.0
and the case drawing (both also in `resources/` in this repository), the
managed BSP `waveshare/esp32_s3_touch_amoled_2_06` 2.0.0, Waveshare's
documentation and FAQ at `docs.waveshare.com`, and the board definition in
`78/xiaozhi-esp32` (`main/boards/waveshare/esp32-s3-touch-amoled-2.06`).

| part | what it is | what it means here |
|---|---|---|
| SoC | ESP32-S3R8, 32 MB flash, 8 MB PSRAM | a 15 s PCM segment (480 KB) fits in PSRAM many times over |
| radio | 2.4 GHz Wi-Fi, BLE 5 | Wi-Fi straight to the server; BLE is not used |
| display | 2.06" AMOLED 410 × 502, CO5300 over QSPI (the BSP drives it with the SH8601 driver), reset GPIO 8 | black pixels are off: a dark UI is a battery decision, not a style |
| display TE | GPIO 13 | tear-free flushes, if LVGL needs them |
| touch | FT3168 at I2C 0x38, INT GPIO 38, reset GPIO 9 | GPIO 38 is **not** an RTC pin: a tap cannot wake the chip from deep sleep, only from light sleep |
| microphones | two, into an ES7210 four-channel ADC | a second microphone for noise suppression; the BSP's `bsp_audio_codec_microphone_init()` opens the ES7210 |
| echo reference | the ES8311's differential output (before the NS4150B amplifier), through an RC attenuator into ES7210 MIC3 | esp-sr's AEC gets a real reference: the watch can listen while it plays. The reference does not include the amplifier or the speaker itself, so how much echo is left is measured, not assumed |
| speaker | ES8311 codec → NS4150B amplifier, enable GPIO 46 | |
| I2S | MCLK 16, BCLK 41, WS 45, DOUT 40, DIN 42 — shared by ES8311 and ES7210 | capture and playback run at the same time on one bus |
| IMU | QMI8658 on I2C 0x6B; INT1 to GPIO 21, INT2 to a test pad only | GPIO 21 is an RTC pin: motion can wake the chip from deep sleep |
| vibration motor | pads P1/P2, switched by an MMBT3904 from GPIO 18, powered from ALDO3 | a notice you feel — if a motor is fitted to the pads in the delivered watch, which is checked on arrival |
| PMU | AXP2101 at I2C 0x34; its IRQ pin is **not connected to the ESP32** (the net goes to an `EXIO5` of an IO expander this board does not have, and is absent from the pin table) | battery and charging state are polled over I2C; nothing from the PMU can wake the chip |
| RTC | PCF85063 at I2C; INT on GPIO 39 | time without a network; GPIO 39 is not an RTC pin, so its alarm cannot wake deep sleep (the ESP32's own timer can) |
| storage | microSD over SPI (MOSI 1, SCK 2, MISO 3, CS 17) | unused so far |
| BOOT button | GPIO 0, pulled up, low when pressed | can wake the chip |
| PWR button | AXP2101 PWRON, **and** through an inverting transistor to GPIO 10 (`SYS_OUT`, high while pressed) | a short press can wake the chip from deep sleep and can be read while awake; the AXP2101 still powers on from off with a press and off with a 6 s hold |
| I2C | SDA 15, SCL 14 | everything above that is not QSPI or I2S |
| battery | 3.7 V on MX1.25; recommended 400 mAh | Waveshare's FAQ: **~1 h at full brightness, 3–4 h with the screen off, ~6 h in low power** |
| case | 50.8 × 42.0 × 13.6 mm (drawing in `resources/`) | a 2.06" panel in a watch that size: text sized for arm's length, not for a phone |

Things the vendor material does **not** settle, which PRD 8.1 measures before it
decides anything about sleep:

- Whether a motor is actually fitted to the P1/P2 pads in the watch as
  delivered. The schematic only has the pads and the driver.
- How the QMI8658's wake-on-motion behaves as a wrist-raise detector: the
  hardware allows it, nothing in the vendor material uses it.
- No example in the vendor repository uses deep sleep, light sleep, motion
  wake-up or the motor. Xiaozhi's board powers the watch **off** through the
  AXP2101 after five idle minutes on battery, which says something about how
  far its authors got with sleep.
- Waveshare's six hours "in low power" is not a working day, and it is not said
  what "low power" means.

## The templates

The keyboard above comes first. Beyond it, two more, both read as references
and borrowed from where they fit; neither is linked in.

**`78/xiaozhi-esp32`, board `waveshare/esp32-s3-touch-amoled-2.06`** (MIT). The
factory firmware of this watch is a Xiaozhi build. Its service is of no interest
— it sends speech to a vendor cloud, which is exactly what PRD 0 rules out — but
its board file is the one piece of code that drives every part of *this* watch
at once, and it is the source of truth for pins where it and the BSP agree:

- `BoxAudioCodec` with ES8311 out, ES7210 in, and `AUDIO_INPUT_REFERENCE true`:
  the reference channel is captured and handed to the AFE
- the AXP2101 set up so that the PWR key powers off after a 4 s hold
- a power-save timer: screen to power-save mode after 60 s idle, power-off
  after 300 s — on battery only
- the FT3168 on GPIO 38/9, the panel reset on GPIO 8

**The Brookesia firmware of the ESP32-S3-Touch-AMOLED-1.8**, specifically its
`XiaozhiApp` and `bsp_extra`, cloned in
`/media/Robin/GitHub/ESP32-S3-Touch-AMOLED-1.8`. Its `docs/FIRMWARE.md` is where
the keyboard's small draw buffer and WiFi-first order came from; it adds a
20 KB LVGL task stack for a deeper UI than the keyboard's, which the watch's
list and answer screens may need. Its voice client is the reference for a wake
word, later.

The vendor repository's `03_esp-brookesia` example also carries esp-sr's AFE
through `esp_gmf_afe`, which is where the two-microphone and AEC configuration
for this board is read from in PRD 8.2.

## Fixed decisions

| | |
|---|---|
| Board | ESP32-S3-Touch-AMOLED-2.06, in its watch case. The 1.8 remains the keyboard |
| Firmware | ESP-IDF 5.5.5 (the vendor's supported line; v5.5.2 is installed at `/media/Robin/GitHub/esp-idf` and is updated first), C, LVGL 9 through the managed BSP |
| Transport | The existing protocol, v1: JSON over WSS to the same server and port as every other client |
| Credential | **The same bearer token** as the app and the browser. No device tokens, no scopes |
| Session | Chosen by the server, as for the keyboard: the watch follows the conversation the phone is in |
| Settings | As on the keyboard: WiFi and an admin password on the device, Mike's URL and token on its web page, all in NVS; nothing compiled in |
| Updates | Over WiFi with rollback, as on the keyboard |
| Audio on the wire | 16 kHz s16le mono PCM, as PRD 5a fixed it. Opus is a later optimization |
| Location | `firmware/watch/`, next to `firmware/keyboard/`; shared code in `firmware/components/` |

### Why the same token

Decided by Mannie. The consequence is stated once so it is not rediscovered: the
token lets its holder drive workers that run with `--worker-perms full`, so a
lost watch is a lost phone — rotate `MIKE_TOKEN` in `~/.config/mike/env` and
pair every client again. The watch does nothing to make extraction harder than
the phone does; flash encryption is available on the S3 and is an open question,
not a requirement.

### Why WSS straight to the server

A BLE link through the phone was the alternative. It would save the watch its
Wi-Fi radio, and it needs a native phone app, because an Even Hub plugin cannot
act as a BLE central for a second device. It would also make the watch useless
exactly when the phone is the thing that is not there. Away from known networks
the watch joins the phone's hotspot like any other network.

### Why the protocol is not changed for the watch

R1.6 says one protocol file, shared by server and client. The firmware is C and
cannot import `src/protocol.js`, so the rule is kept by generation instead:
`npm run firmware:protocol` writes
`firmware/components/mike_protocol/include/mike_protocol.h` — message types,
roles, control actions, close codes, the protocol version and the limits —
from `src/protocol.js`, both firmwares include it, and a test fails if the
header is not what the generator would write. A watch built against a different protocol version is refused at
`hello` like any other client (R1.6).

What 8.1–8.3 add to the protocol is added for every client, not as a watch
dialect.

## Order, and why

**8.1 first, with no audio at all.** It starts by moving the keyboard's reusable
parts into `firmware/components/` with the keyboard still working, and by
teaching the server that devices follow conversation clients and not each
other. Then it exercises everything that is hard and has nothing to do with
sound: TLS to `kontoret.onvo.se`, the token, the
protocol in C, LVGL on this panel, reconnect and replay, and above all how the
watch sleeps. The sleep strategy constrains every later phase — a watch that
cannot keep a socket open cannot receive a spoken reply either — so it is
measured and decided here rather than deferred.

**8.2 needs no server change beyond one field.** A held segment is an `audio`
message like the browser's. The one addition is that a hold on the watch is an
address in itself (PRD 8.2 R8.2.3), without changing the session's mode under
the glasses.

**8.3 is the largest new work on the server**, and it is not a watch feature.
Mike has no speech output today. The voder is a service next to `mike-whisper`,
and the phone and browser can use it as well as the watch; the glasses cannot,
having no speaker.

## Later

Not specified. Each gets a PRD when it is started.

- **Wake word.** esp-sr runs on this board, and with two microphones and an
  echo reference it has what it needs. It keeps the CPU awake, which is at odds
  with sleep on 400 mAh, so it is a mode for when the watch is on a charger or a
  desk. Whether an English model exists that fits, or "Mike" needs a
  custom-trained WakeNet, is unchecked.
- **Raise to talk.** The IMU interrupt is wired to an RTC pin, so the hardware
  allows it; whether the QMI8658's motion detection tells a raised wrist from a
  swinging arm is the open part. PRD 8.1 measures it as a wake source first.
- **Opus uplink and downlink.** About a tenth of PCM. Worth it if hotspot
  bandwidth turns out to matter; needs Opus decoding on the server.
- **Shortcut tiles.** Fixed sentences sent as `say`, e.g. "Mike, how are the
  workers doing?"
- **Plan usage on the face.** The keyboard's `usage_client.c` already fetches
  it; on a wrist it would be one more line under the time.
- **Talking over an answer.** With the echo reference, the watch can hear the
  user while the voder is speaking (to the extent the measured residual echo
  allows). Interrupting an answer by voice becomes
  possible here and nowhere else.

## Non-goals

- A smartwatch. No steps, no heart rate, no notifications from the phone.
- Running any model on the watch beyond esp-sr's own.
- A second protocol, a BLE path, or a watch-specific server endpoint.
- The watch firmware on the ESP32-S3-Touch-AMOLED-1.8 (that board is the
  keyboard), and the ESP32-C6 variant of the 2.06. The watch is the S3 2.06.
- A watch that types. A keyboard on the watch's USB port is possible on this
  S3 too, and is the keyboard's job.
