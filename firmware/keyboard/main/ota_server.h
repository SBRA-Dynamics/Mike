#pragma once

/*
 * The board's web page: http://<OTA_HOSTNAME>.local/
 *
 *   GET  /                    the page
 *   GET  /info                status as JSON (no password)
 *   POST /api/mike            { host, port, tls_name, token }   saves and restarts
 *   POST /api/claude/start    -> { url }                        Claude login, step 1
 *   POST /api/claude/finish   { code }                          step 2
 *   POST /update              the raw firmware .bin
 *
 * Everything but the page and /info needs header X-Admin-Password: the admin
 * password set on the board (F2). Without one set, all of it is refused.
 *
 * A new firmware image boots on probation: it has to reach WiFi within
 * OTA_CONFIRM_S, or the board restarts and the bootloader goes back to the
 * previous image. So an update can never take updating away.
 */

/* Starts the web server and mDNS. Call once the network stack is up. */
void ota_server_start(void);

/* The network is up: a new image is good enough to keep. */
void ota_confirm(void);

/* Arms the rollback timer for an image that is still on probation. Call early in app_main. */
void ota_watchdog_start(void);
