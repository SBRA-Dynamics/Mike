#pragma once

#include <stdbool.h>

/*
 * The screen goes dark after SCREEN_OFF_S seconds without a touch, a key or a
 * button, and comes back on the next one. The touch that wakes it only wakes
 * it: it does not also press whatever is under the finger.
 */

/* Starts the timer. Call with the display lock held, once the UI exists. */
void screen_sleep_start(void);

/* Counts as activity, lighting a dark screen. Takes the display lock; call
 * from any task but the LVGL one. Returns true if the screen was dark. */
bool screen_sleep_wake(void);
