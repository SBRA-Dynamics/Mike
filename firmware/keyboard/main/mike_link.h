#pragma once

/*
 * Link to a Mike server as a keyboard (Mike's src/keyboard.js).
 *
 * The board says hello with role "keyboard" and from then on only sends:
 *   draft     { text, cursor }  the line after every keystroke
 *   say       { text }          Enter
 *   interrupt {}                Ctrl+C
 * The server shows the draft as a text box on the glasses and routes a say
 * into whichever conversation the glasses are in.
 *
 * All calls are non-blocking: messages go into an outbox that the link task
 * drains as soon as it is woken. Consecutive drafts are coalesced, so a burst
 * of keystrokes on a slow link sends the newest line rather than a backlog.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Reads the settings and starts the link task if Mike is configured. Call before any other function here. */
void mike_link_start(void);

/* The line being typed, as code points, and the cursor position in code points. */
void mike_link_draft(const uint32_t *text, size_t len, size_t cursor);

/* Sends the line as a typed utterance. */
void mike_link_say(const uint32_t *text, size_t len);

/* Stops the running turn. */
void mike_link_interrupt(void);

/* A line in the Mike server's log, for diagnosing the board when its USB port
 * is a host and it has no serial console. printf-style, ASCII. */
void mike_link_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

/* True while the socket is open and hello was answered. */
bool mike_link_connected(void);

/* True when a Mike address and token are set (settings.h). */
bool mike_link_enabled(void);
