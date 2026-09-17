#pragma once

/*
 * A one-line editor in the style of a shell prompt, whose line is shown on the
 * glasses (mike_link.h). Cursor movement, word jumps, and an Up/Down history of
 * sent lines that survives a reboot.
 */

#include "keyboard_input.h"

/* Loads the history from NVS. Call after nvs_flash_init(). */
void line_editor_init(void);

/* Applies one keystroke. Suitable as the keyboard_input handler. */
void line_editor_key(const key_event_t *event);
