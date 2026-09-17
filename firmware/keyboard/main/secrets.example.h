#pragma once

/*
 * Copy of this file is created as main/secrets.h on the first build.
 * Edit main/secrets.h (it is git-ignored) - not this template.
 */

/* 2.4 GHz WiFi network the board joins. */
#define WIFI_SSID "your-ssid"
#define WIFI_PASSWORD "your-password"

/*
 * Claude OAuth refresh token (starts with "sk-ant-ort01-").
 * Get one with: python3 tools/claude_login.py
 * The board refreshes access tokens by itself and stores rotated tokens in NVS.
 * Changing this value makes the board discard the stored tokens and start over.
 */
#define CLAUDE_REFRESH_TOKEN ""

/*
 * Optional: a short-lived access token ("sk-ant-oat01-") used only when
 * CLAUDE_REFRESH_TOKEN is empty. Handy for a quick test, expires after a few hours.
 */
#define CLAUDE_ACCESS_TOKEN ""

/* How often the usage endpoint is polled. */
#define USAGE_POLL_INTERVAL_S 120

/* POSIX TZ string used for "Resets ..." times. */
#define LOCAL_TIMEZONE "CET-1CEST,M3.5.0,M10.5.0/3"

/* Display brightness in percent. */
#define DISPLAY_BRIGHTNESS 60

/*
 * Keyboard for Mike (optional). A USB keyboard on the board's USB-C port types
 * into the conversation on the glasses. Leave MIKE_HOST empty to turn it off.
 *
 * MIKE_HOST      the Mike server's LAN address, e.g. "192.168.1.10"
 * MIKE_PORT      its port (MIKE_PORT in ~/.config/mike/env)
 * MIKE_TLS_NAME  the name on its certificate, e.g. "mike.example.com"; the
 *                connection is made to MIKE_HOST and verified against this name.
 *                Empty for a server without TLS.
 * MIKE_TOKEN     MIKE_TOKEN from ~/.config/mike/env
 */
#define MIKE_HOST ""
#define MIKE_PORT 3456
#define MIKE_TLS_NAME ""
#define MIKE_TOKEN ""

/*
 * 1: read keystrokes from a terminal on the USB serial console instead of a USB
 * keyboard, to try the keyboard without one. 0 for a real keyboard; the USB-C
 * port is then a USB host and no longer a serial port (hold BOOT and reset to flash).
 */
#define KEYBOARD_SERIAL_TEST 0

/*
 * 1: write USB diagnostics - interfaces found, every raw key report, transfer
 * errors - to the Mike server's log (~/mike-server.log), since the USB port is
 * a host and there is no serial console to read.
 */
#define KEYBOARD_DEBUG 0

/*
 * Firmware updates over WiFi: http://OTA_HOSTNAME.local/ (or tools/ota.sh).
 * The password is MIKE_KEYBOARD_OTA_PASSWORD in Mike's env file
 * (~/.config/mike/env, or $MIKE_ENV), read at build time; without it updates
 * over WiFi are off. A new image that does not reach WiFi within OTA_CONFIRM_S
 * seconds is rolled back.
 */
#define OTA_HOSTNAME "claude-usage"
#define OTA_CONFIRM_S 90
