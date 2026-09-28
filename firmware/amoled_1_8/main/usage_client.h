#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <time.h>

#include "esp_err.h"

#define USAGE_MAX_LIMITS 8

typedef struct {
    char title[48];      /* "Current session", "All models", "Fable only", ... */
    bool weekly;         /* false = session (5 h) window */
    int percent;         /* 0..100 */
    time_t resets_at;    /* UTC epoch, 0 if unknown */
    bool active;         /* the limit that is currently binding */
} usage_limit_t;

typedef struct {
    usage_limit_t limits[USAGE_MAX_LIMITS];
    int limit_count;

    bool spend_present;  /* "Extra usage" block */
    bool spend_enabled;
    double spend_used;
    double spend_limit;
    int spend_percent;
    char spend_currency[8];

    time_t fetched_at;
} usage_data_t;

/* Loads the Claude login from NVS. Call once after nvs_flash_init(). */
void usage_client_init(void);

/* True when a refresh token or access token is configured. */
bool usage_client_has_credentials(void);

/*
 * Fetches the claude.ai plan usage, refreshing the OAuth access token when needed.
 * On failure a short human readable reason is written to err.
 */
esp_err_t usage_client_fetch(usage_data_t *out, char *err, size_t err_len);

/*
 * Claude login, the way `claude login` does it with a pasted code:
 * start gives the URL to open; after authorizing, the page shown there has a
 * code (CODE#STATE) that finish exchanges for tokens and stores in NVS.
 */
esp_err_t usage_client_login_start(char *url, size_t len);
esp_err_t usage_client_login_finish(const char *code, char *err, size_t err_len);

/* The server's Retry-After on the last fetch, in seconds; 0 when it gave none. */
int usage_client_retry_after_s(void);
