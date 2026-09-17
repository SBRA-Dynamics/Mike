#pragma once

/*
 * The settings screen on the board, driven by the keyboard (F2 opens and
 * closes it): the WiFi network, chosen from a scan or typed, its password, and
 * the admin password that protects the web page and firmware updates.
 */

#include <stdbool.h>

#include "keyboard_input.h"

/* Creates the screen. Call with the LVGL lock held, after the main screen exists. */
void settings_ui_create(void);

bool settings_ui_active(void);

/* Shows the screen, with an optional line of explanation at the top. */
void settings_ui_open(const char *note);

/* One keystroke while the screen is showing. Called from the keyboard task. */
void settings_ui_key(const key_event_t *event);
