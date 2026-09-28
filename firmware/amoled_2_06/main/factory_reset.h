#pragma once

/*
 * Resetting every setting with the BOOT button, for a board nobody can log in
 * to any more: hold BOOT for FACTORY_RESET_HOLD_S seconds and the screen counts
 * down FACTORY_RESET_COUNTDOWN_S more. Letting go during the countdown cancels.
 * At zero the WiFi network, the admin password, Mike's settings, the Claude
 * login and the typing history are erased and the board restarts, as new.
 *
 * Holding a button on the board is the proof of ownership: nothing on the
 * network can do this.
 */

/* Starts watching the button. Call once the display is running. */
void factory_reset_start(void);
