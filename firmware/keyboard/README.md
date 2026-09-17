# Keyboard and usage display

A stand-alone desk display for your claude.ai plan usage (Settings → Usage). The board
connects to WiFi, fetches the usage itself over HTTPS and shows the current session
limit, the weekly limits and extra usage with progress bars and reset countdowns.
No computer is needed once it is flashed.

Firmware for the Waveshare ESP32-S3-Touch-AMOLED-1.8, ESP-IDF 5.5, built on the
`14_lvgl_demo_v9` example from Waveshare's board repository (managed BSP + LVGL 9).

## Setting it up

Nothing secret is compiled in. Everything is set on the board and kept in its
NVS, so a firmware update keeps it:

1. **On the board** — connect the keyboard and press **F2** (the settings
   screen also opens by itself when no WiFi is set). Choose the WiFi network
   from the list (or type one under *Other network*), type its password, and
   set an **admin password** of at least six characters. Up/Down chooses,
   Enter opens and saves, Esc goes back, Tab shows a password while typing it.
2. **On the web page** — open `http://claude-usage.local/` (the settings
   screen also shows the board's address) and enter the admin password.
   - **Mike**: the server's URL, e.g. `https://mike.example.com:3456` (what
     the phone uses; `http://` for a server without TLS), and its token
     (`MIKE_TOKEN` in `~/.config/mike/env`). Saving restarts the board. The
     certificate is checked against the name in the URL, so on the same LAN as
     the server the router has to route its public address back in (hairpin
     NAT); most do.
   - **Claude login**: *Start login* opens claude.ai; authorize, paste the code
     it shows and press *Finish login*. The board then renews the 8-hour access
     token by itself and keeps the rotated tokens.

**Forgotten admin password, or a keyboard that does not work?** Hold the
**BOOT** button for 10 seconds. The screen then counts down 5 more
("Resetting settings in 5s"); keep holding and every setting is erased — WiFi,
admin password, Mike, the Claude login and the typing history — and the board
restarts as new. Let go during the countdown to cancel. With no admin password
set, the first one can also be set on the web page, so the board never needs
the keyboard to be reached again.

`main/app_config.h` holds the few build-time settings: poll interval and
back-off, time zone, brightness, host name, and the keyboard test and debug
switches.

## Keyboard for Mike (optional)

With Mike's address and token set on the web page, the board is also a keyboard for
Mike on Even Realities G2 glasses (see "A keyboard" in the repository README): a USB keyboard on the
board's USB-C port types into the conversation on the glasses, and the line
being typed is shown on the lens as a text box (`╰─ > line| ───╯`) while it is
typed. The display keeps showing plan usage; its footer says whether the
keyboard and Mike are connected.

| Key | Does |
| --- | --- |
| Left / Right, Home / End | move the cursor (Ctrl+Left/Right: by word; Ctrl+A / Ctrl+E) |
| Backspace / Delete | delete (Ctrl+Backspace, Ctrl+W: a word; Ctrl+U / Ctrl+K: to start / end) |
| Up / Down | earlier lines, like a shell history (kept across reboots) |
| Enter | send the line to Mike |
| F2 | settings screen |
| Esc | clear the line |
| Ctrl+C | interrupt the running turn |

The layout is Swedish, with dead keys for accents (´ ` ¨ ^ ~).

`KEYBOARD_SERIAL_TEST` in `main/app_config.h` takes keystrokes from a terminal
on the USB serial port instead, and `KEYBOARD_DEBUG` sends USB interfaces, raw
key reports and transfer errors to the Mike server's log.

The link is a minimal WebSocket client on esp-tls with Nagle turned off, so a
keystroke leaves as one TLS record at once; drafts that pile up behind a slow
link are coalesced to the newest line. Measured on a LAN: 2–7 ms from the
board to a client of the server.

**Hardware.** With a keyboard the USB-C port runs as a USB host, so:

- The board does not power the keyboard from its USB-C port. Use a USB-C hub
  with power delivery pass-through: the charger in the hub powers the board and
  the keyboard, the board plugs into the hub's host side.
- The port is no longer a serial port. To flash again, hold **BOOT** while
  pressing **RESET** (or plugging in), then flash as usual.
- A wireless receiver can instead be wired to the `USB_P` (GPIO20) and `USB_N`
  (GPIO19) pads, which are the same lines as the USB-C port. Power it with 5 V
  and GND only, share GND with the board, and connect nothing else to its
  D+/D−: a USB cable's data wires left on a hub, or the board's USB-C port on a
  computer, put a second host on the bus and the receiver reconnects every
  half second. Power the board from its battery or a charger.
- Try the editor without a keyboard first with `KEYBOARD_SERIAL_TEST 1` and a
  terminal: `python3 -m serial.tools.miniterm PORT 115200`.

## Board version

V1 (SH8601 / FT3168) and V2 (CO5300 / CST820) need different BSP versions. Set it in
`main/idf_component.yml`:

- V1: `waveshare/esp32_s3_touch_amoled_1_8: "1.1.4"` (default)
- V2: `waveshare/esp32_s3_touch_amoled_1_8: "^2.0.3"`

After changing, delete `dependencies.lock`, `managed_components/` and `build/`.

## Build and Flash

```bash
idf.py set-target esp32s3
idf.py build
idf.py -p PORT flash monitor
```

### Over WiFi

Once flashed by USB, the board updates over WiFi with its admin password:

- on the web page, under *Firmware*, upload `build/claude_usage_monitor.bin`, or
- run `idf.py build && tools/ota.sh` (it asks for the password, or reads
  `$KEYBOARD_ADMIN_PASSWORD`; an address instead of `claude-usage.local` can be
  given as the argument).

The flash holds two app partitions. The upload goes to the one not running and
is validated before it is marked bootable; a failed upload leaves the running
firmware as it was. A new image boots on probation and must reach WiFi within
`OTA_CONFIRM_S` seconds (90), or the board restarts into the previous image —
so an update cannot take away the ability to update. `GET /info` says which
version and partition are running.

## Usage

- The header shows the battery: level and percent from the AXP2101's fuel
  gauge, a bolt while charging, red at 15 % and below on battery, and a USB
  symbol when running from USB with no battery. The gauge estimates the charge
  from the battery voltage and the current in and out; it needs a few full
  cycles to become accurate and starts over whenever the battery has been
  disconnected. `/info` has percent, voltage and charging state too.
- The status dot is green when data is current, orange when the last fetch failed
  and red without WiFi or data. Errors are shown at the bottom.
- Usage is fetched every 5 minutes. A tap fetches right away, at most once a
  minute. When the usage endpoint answers 429 the board waits for its
  Retry-After, and at least 5 minutes, doubling up to 30 while it repeats.
- The layout moves a few pixels every five minutes to limit AMOLED burn-in.

## Notes

- The usage endpoint and OAuth client are what Claude Code uses; they are not a
  documented public API and may change.
- The BSP does not release the touch reset line on the TCA9554 expander, so the app
  pulses expander pins 0–2 before starting the display (as Waveshare's Arduino
  examples do). Without it the V1 touch controller is not found and the BSP aborts.
- WiFi is started before LVGL, and `CONFIG_BSP_DISPLAY_LVGL_BUF_HEIGHT=10` keeps the
  flush bounce buffer small; see the Brookesia firmware notes for why.
