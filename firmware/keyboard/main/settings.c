#include "settings.h"

#include <string.h>

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

void settings_init(void)
{
    s_lock = xSemaphoreCreateMutex();
    s_mike.port = 3456;
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return;
    }
    load_str(nvs, "mike_host", s_mike.host, sizeof(s_mike.host));
    load_str(nvs, "mike_tls", s_mike.tls_name, sizeof(s_mike.tls_name));
    load_str(nvs, "mike_token", s_mike.token, sizeof(s_mike.token));
    load_str(nvs, "admin", s_admin, sizeof(s_admin));
    uint16_t port;
    if (nvs_get_u16(nvs, "mike_port", &port) == ESP_OK) {
        s_mike.port = port;
    }
    nvs_close(nvs);
    ESP_LOGI(TAG, "mike %s, admin password %s", s_mike.host[0] ? s_mike.host : "not set", s_admin[0] ? "set" : "not set");
}

bool settings_get_mike(mike_settings_t *out)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    *out = s_mike;
    xSemaphoreGive(s_lock);
    return out->host[0] != '\0' && out->token[0] != '\0';
}

esp_err_t settings_set_mike(const mike_settings_t *in)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        return err;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    strlcpy(s_mike.host, in->host, sizeof(s_mike.host));
    strlcpy(s_mike.tls_name, in->tls_name, sizeof(s_mike.tls_name));
    s_mike.port = in->port;
    if (in->token[0] != '\0') {
        strlcpy(s_mike.token, in->token, sizeof(s_mike.token));
    }
    nvs_set_str(nvs, "mike_host", s_mike.host);
    nvs_set_str(nvs, "mike_tls", s_mike.tls_name);
    nvs_set_str(nvs, "mike_token", s_mike.token);
    nvs_set_u16(nvs, "mike_port", s_mike.port);
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
