#pragma once

/*
 * Settings that used to be compiled in, now kept in NVS and set on the board.
 *
 * WiFi itself is not here: the WiFi driver keeps the network and its password
 * in its own NVS storage (esp_wifi_set_config), which also means a board that
 * was flashed with them compiled in keeps its network across the update.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

typedef struct {
    char host[64];      /* LAN address of the Mike server */
    uint16_t port;
    char tls_name[96];  /* name on its certificate; empty for plain ws:// */
    char token[96];
} mike_settings_t;

void settings_init(void);

/* True when a host and a token are set. */
bool settings_get_mike(mike_settings_t *out);

/* An empty token keeps the stored one. */
esp_err_t settings_set_mike(const mike_settings_t *in);

/* The password for the web page and firmware updates. */
bool settings_admin_password_set(void);
bool settings_check_admin_password(const char *given);
esp_err_t settings_set_admin_password(const char *password);
