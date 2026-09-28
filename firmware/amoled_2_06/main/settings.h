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
    char url[128];      /* as entered: https://mike.example.com:3456 */
    char token[96];
    /* Parsed from url. */
    char host[96];
    uint16_t port;
    bool tls;           /* https:// or wss://; the certificate is checked against host */
} mike_settings_t;

void settings_init(void);

/* True when a valid URL and a token are set. */
bool settings_get_mike(mike_settings_t *out);

/* An empty token keeps the stored one. ESP_ERR_INVALID_ARG for a URL that does not parse. */
esp_err_t settings_set_mike(const char *url, const char *token);

/* Splits http(s)://host[:port][/...] (ws:// and wss:// too; no scheme means https). */
bool settings_parse_url(const char *url, char *host, size_t host_len, uint16_t *port, bool *tls);

/* The password for the web page and firmware updates. */
bool settings_admin_password_set(void);
bool settings_check_admin_password(const char *given);
esp_err_t settings_set_admin_password(const char *password);
