#pragma once

/*
 * Build-time settings. Nothing secret lives here: WiFi, the admin password,
 * Mike's address and token and the Claude login are set on the board itself
 * (F2 on the keyboard, and the web page) and kept in NVS - see settings.h.
 */

/* How often the usage endpoint is polled. */
#define USAGE_POLL_INTERVAL_S 300

/* After a 429: wait at least this long, doubling up to the maximum. */
#define USAGE_BACKOFF_MIN_S 300
#define USAGE_BACKOFF_MAX_S 1800

/* A tap on the screen fetches at once, but not more often than this. */
#define USAGE_TAP_MIN_S 60

/* POSIX TZ string used for reset times. */
#define LOCAL_TIMEZONE "CET-1CEST,M3.5.0,M10.5.0/3"

/* Display brightness in percent. */
#define DISPLAY_BRIGHTNESS 60

/* The board's name on the network: http://OTA_HOSTNAME.local/ */
#define OTA_HOSTNAME "claude-usage"

/* Hold BOOT this long, then a countdown of this long, to erase every setting. */
#define FACTORY_RESET_HOLD_S 10
#define FACTORY_RESET_COUNTDOWN_S 5

/* A new firmware image must reach WiFi within this many seconds or it is rolled back. */
#define OTA_CONFIRM_S 90

/*
 * 1: read keystrokes from a terminal on the USB serial console instead of a USB
 * keyboard, to try the editor without one.
 */
#define KEYBOARD_SERIAL_TEST 0

/*
 * 1: write USB diagnostics - interfaces found, every raw key report, transfer
 * errors - to the Mike server's log, since the USB port is a host and there is
 * no serial console to read.
 */
#define KEYBOARD_DEBUG 0
