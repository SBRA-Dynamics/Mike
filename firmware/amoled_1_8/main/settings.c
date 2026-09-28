#include "settings.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"

static const char *TAG = "settings";

#define NVS_NAMESPACE "settings"

static SemaphoreHandle_t s_lock;
static mike_settings_t s_mike;
static char s_admin[64];

static void load_str(nvs_handle_t nvs, const char *key, char *out, size_t len)
{
    size_t size = len;
    if (nvs_get_str(nvs, key, out, &size) != ESP_OK) {
        out[0] = '\0';
    }
}

bool settings_parse_url(const char *url, char *host, size_t host_len, uint16_t *port, bool *tls)
{
    const char *p = url;
    while (*p == ' ') {
        p++;
    }
    *tls = true;
    if (strncasecmp(p, "https://", 8) == 0) {
        p += 8;
    } else if (strncasecmp(p, "wss://", 6) == 0) {
        p += 6;
    } else if (strncasecmp(p, "http://", 7) == 0) {
        p += 7;
        *tls = false;
    } else if (strncasecmp(p, "ws://", 5) == 0) {
        p += 5;
        *tls = false;
    } else if (strstr(p, "://") != NULL) {
        return false;
    }
    size_t n = strcspn(p, ":/ ");
    if (n == 0 || n >= host_len) {
        return false;
    }
    memcpy(host, p, n);
    host[n] = '\0';
    p += n;
    *port = *tls ? 443 : 80;
    if (*p == ':') {
        char *end;
        long value = strtol(p + 1, &end, 10);
        if (end == p + 1 || value <= 0 || value > 65535 || (*end != '\0' && *end != '/' && *end != ' ')) {
            return false;
        }
        *port = (uint16_t)value;
    }
    return true;
}

void settings_init(void)
{
    s_lock = xSemaphoreCreateMutex();
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return;
    }
    load_str(nvs, "mike_url", s_mike.url, sizeof(s_mike.url));
    load_str(nvs, "mike_token", s_mike.token, sizeof(s_mike.token));
    load_str(nvs, "admin", s_admin, sizeof(s_admin));
    if (s_mike.url[0] == '\0') {
        /* Settings from before the single URL: the certificate name is the address to use. */
        char host[64] = "";
        char tls_name[96] = "";
        uint16_t port = 3456;
        load_str(nvs, "mike_host", host, sizeof(host));
        load_str(nvs, "mike_tls", tls_name, sizeof(tls_name));
        nvs_get_u16(nvs, "mike_port", &port);
        if (tls_name[0] || host[0]) {
            snprintf(s_mike.url, sizeof(s_mike.url), "%s://%s:%u", tls_name[0] ? "https" : "http",
                     tls_name[0] ? tls_name : host, port);
        }
    }
    nvs_close(nvs);
    ESP_LOGI(TAG, "mike %s, admin password %s", s_mike.url[0] ? s_mike.url : "not set", s_admin[0] ? "set" : "not set");
}

bool settings_get_mike(mike_settings_t *out)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    *out = s_mike;
    xSemaphoreGive(s_lock);
    bool parsed = settings_parse_url(out->url, out->host, sizeof(out->host), &out->port, &out->tls);
    if (!parsed) {
        out->host[0] = '\0';
        out->port = 0;
        out->tls = false;
    }
    return parsed && out->token[0] != '\0';
}

esp_err_t settings_set_mike(const char *url, const char *token)
{
    char host[96];
    uint16_t port;
    bool tls;
    if (!settings_parse_url(url, host, sizeof(host), &port, &tls)) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        return err;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    strlcpy(s_mike.url, url, sizeof(s_mike.url));
    if (token != NULL && token[0] != '\0') {
        strlcpy(s_mike.token, token, sizeof(s_mike.token));
    }
    nvs_set_str(nvs, "mike_url", s_mike.url);
    nvs_set_str(nvs, "mike_token", s_mike.token);
    nvs_erase_key(nvs, "mike_host");
    nvs_erase_key(nvs, "mike_tls");
    nvs_erase_key(nvs, "mike_port");
    xSemaphoreGive(s_lock);
    err = nvs_commit(nvs);
    nvs_close(nvs);
    return err;
}

bool settings_admin_password_set(void)
{
    return s_admin[0] != '\0';
}

bool settings_check_admin_password(const char *given)
{
    if (given == NULL || s_admin[0] == '\0') {
        return false;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    size_t a = strlen(given);
    size_t b = strlen(s_admin);
    unsigned diff = a ^ b;
    for (size_t i = 0; i < a && i < b; i++) {
        diff |= (unsigned)(given[i] ^ s_admin[i]);
    }
    xSemaphoreGive(s_lock);
    return diff == 0;
}

esp_err_t settings_set_admin_password(const char *password)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        return err;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    strlcpy(s_admin, password, sizeof(s_admin));
    nvs_set_str(nvs, "admin", s_admin);
    xSemaphoreGive(s_lock);
    err = nvs_commit(nvs);
    nvs_close(nvs);
    return err;
}
