# Keyboard and usage display

A stand-alone desk display for your claude.ai plan usage (Settings → Usage). The board
connects to WiFi, fetches the usage itself over HTTPS and shows the current session
limit, the weekly limits and extra usage with progress bars and reset countdowns.
No computer is needed once it is flashed.

Firmware for the Waveshare ESP32-S3-Touch-AMOLED-1.8, ESP-IDF 5.5, built on the
`14_lvgl_demo_v9` example from Waveshare's board repository (managed BSP + LVGL 9).

## Configuration

All settings live in `main/secrets.h`, created from `main/secrets.example.h` on the
first build and ignored by git:

| Define | Meaning |
| --- | --- |
| `WIFI_SSID`, `WIFI_PASSWORD` | 2.4 GHz network to join |
| `CLAUDE_REFRESH_TOKEN` | OAuth refresh token, see below |
| `CLAUDE_ACCESS_TOKEN` | Optional short-lived token, used only without a refresh token |
| `USAGE_POLL_INTERVAL_S` | Poll interval (default 120 s) |
| `LOCAL_TIMEZONE` | POSIX TZ string |
| `DISPLAY_BRIGHTNESS` | Brightness in percent |

### Getting a token

The usage endpoint (`api.anthropic.com/api/oauth/usage`) accepts the OAuth tokens
Claude Code uses. `tools/claude_login.py` runs that login for the board, so it gets
its own token and does not interfere with Claude Code on your computer:

```bash
python3 tools/claude_login.py --write
```

It opens the login page. Authorize, paste the code shown, and the script prints the
current usage and writes `CLAUDE_REFRESH_TOKEN` into `main/secrets.h`. Without a
terminal, use `--start` followed by `--code 'CODE#STATE' --write`.

The board refreshes the 8-hour access token by itself and stores rotated tokens in
NVS. Changing the tokens in `secrets.h` makes it drop what it stored and start over.

## Keyboard for Mike (optional)

With `MIKE_HOST` and `MIKE_TOKEN` set, the board is also a keyboard for
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
| Esc | clear the line |
| Ctrl+C | interrupt the running turn |

The layout is Swedish, with dead keys for accents (´ ` ¨ ^ ~).

| Define | Meaning |
| --- | --- |
| `MIKE_HOST` | the Mike server's LAN address |
| `MIKE_PORT` | `MIKE_PORT` from `~/.config/mike/env` |
| `MIKE_TLS_NAME` | the name on the server's certificate; empty for plain `ws://` |
| `MIKE_TOKEN` | `MIKE_TOKEN` from `~/.config/mike/env` |
| `KEYBOARD_SERIAL_TEST` | `1`: take keystrokes from a terminal on the USB serial port instead |
| `KEYBOARD_DEBUG` | `1`: USB interfaces, raw key reports and transfer errors go to the Mike server's log |

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

Once flashed by USB, the board updates over WiFi. The password is
`MIKE_KEYBOARD_OTA_PASSWORD` in Mike's env file (`~/.config/mike/env`, or the
file `$MIKE_ENV` names), read when the firmware is built and by
`tools/ota.sh`. Then either:

- open `http://claude-usage.local/` (`OTA_HOSTNAME`), choose
  `build/claude_usage_monitor.bin` and upload it, or
- run `idf.py build && tools/ota.sh` (an address instead of the `.local` name
  can be given as the argument).

The flash holds two app partitions. The upload goes to the one not running and
is validated before it is marked bootable; a failed upload leaves the running
firmware as it was. A new image boots on probation and must reach WiFi within
`OTA_CONFIRM_S` seconds (90), or the board restarts into the previous image —
so an update cannot take away the ability to update. `GET /info` says which
version and partition are running.

Moving an older USB-flashed board to this layout needs one more USB flash,
because the partition table and bootloader change; NVS keeps its place, so
tokens and history survive it.

## Usage

- The status dot is green when data is current, orange when the last fetch failed
  and red without WiFi or data. Errors are shown at the bottom.
- Tap the screen to fetch right away.
- The layout moves a few pixels every five minutes to limit AMOLED burn-in.

## Notes

- The usage endpoint and OAuth client are what Claude Code uses; they are not a
  documented public API and may change.
- The BSP does not release the touch reset line on the TCA9554 expander, so the app
  pulses expander pins 0–2 before starting the display (as Waveshare's Arduino
  examples do). Without it the V1 touch controller is not found and the BSP aborts.
- WiFi is started before LVGL, and `CONFIG_BSP_DISPLAY_LVGL_BUF_HEIGHT=10` keeps the
  flush bounce buffer small; see the Brookesia firmware notes for why.
