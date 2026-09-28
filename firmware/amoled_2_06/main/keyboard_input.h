#pragma once

/*
 * Keystrokes, as editing actions.
 *
 * Two sources produce the same events: a USB keyboard on the board's USB-C port
 * (USB host, Swedish layout), or - with KEYBOARD_SERIAL_TEST - a terminal on the
 * USB serial console, which is how the editor is exercised without a keyboard.
 */

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    KEY_CHAR,        /* codepoint holds the character */
    KEY_ENTER,
    KEY_BACKSPACE,
    KEY_DELETE,
    KEY_LEFT,
    KEY_RIGHT,
    KEY_WORD_LEFT,
    KEY_WORD_RIGHT,
    KEY_HOME,
    KEY_END,
    KEY_UP,
    KEY_DOWN,
    KEY_DELETE_WORD, /* Ctrl+Backspace, Ctrl+W */
    KEY_KILL_START,  /* Ctrl+U */
    KEY_KILL_END,    /* Ctrl+K */
    KEY_ESCAPE,      /* clears the line */
    KEY_INTERRUPT,   /* Ctrl+C */
    KEY_TAB,
    KEY_FUNCTION,    /* F1-F12; codepoint holds the number */
    KEY_SETTINGS,    /* Ctrl+Alt+S: the settings screen (BOOT does it too) */
} key_action_t;

/* Modifiers, for the keys where they are part of the key rather than the letter. */
#define KEY_MOD_CTRL 0x01
#define KEY_MOD_SHIFT 0x02
#define KEY_MOD_ALT 0x04

typedef struct {
    key_action_t action;
    uint32_t codepoint;
    uint8_t modifiers;
} key_event_t;

typedef void (*key_handler_t)(const key_event_t *event);

/* Starts the configured source. The handler runs on the keyboard's own task. */
void keyboard_input_start(key_handler_t handler);

/*
 * Instead of keyboard_input_start(): lets go of the USB pins entirely - no
 * host, no USB-Serial-JTAG device, no pull resistors - so a receiver wired to
 * D+/D- reaches a computer on the USB-C port as if it were plugged in there.
 */
void keyboard_input_release_usb(void);

/* True while a keyboard is attached (always true for the serial source). */
bool keyboard_input_attached(void);

/* What the USB side has seen since boot, for diagnosing wiring from the web page. */
typedef struct {
    bool attached;
    uint32_t interfaces;      /* HID interfaces enumerated, keyboards or not */
    uint32_t reports;         /* input reports received */
    uint32_t transfer_errors;
    uint32_t keys;            /* key presses turned into events */
    uint8_t last_usage;       /* HID usage of the last key pressed */
} keyboard_stats_t;

void keyboard_input_stats(keyboard_stats_t *out);
