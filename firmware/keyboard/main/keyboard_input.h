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
} key_action_t;

typedef struct {
    key_action_t action;
    uint32_t codepoint;
} key_event_t;

typedef void (*key_handler_t)(const key_event_t *event);

/* Starts the configured source. The handler runs on the keyboard's own task. */
void keyboard_input_start(key_handler_t handler);

/* True while a keyboard is attached (always true for the serial source). */
bool keyboard_input_attached(void);
