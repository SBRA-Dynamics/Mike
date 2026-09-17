#pragma once

/*
 * Firmware updates over WiFi.
 *
 *   http://<OTA_HOSTNAME>.local/        a page to pick a .bin and upload it
 *   POST /update                        the raw .bin, header X-OTA-Password
 *   GET  /info                          version and running partition, as JSON
 *
 * A new image boots on probation: it has to reach WiFi within OTA_CONFIRM_S,
 * or the board restarts and the bootloader goes back to the previous image.
 * So an update can never take OTA itself away.
 */

/* Starts the web server and mDNS. Call once the network stack is up. */
void ota_server_start(void);

/* The network is up: a new image is good enough to keep. */
void ota_confirm(void);

/* Arms the rollback timer for an image that is still on probation. Call early in app_main. */
void ota_watchdog_start(void);
