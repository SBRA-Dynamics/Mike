#include "wifi.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "app_config.h"
#include "ota_server.h"

static const char *TAG = "wifi";

#define CONNECTED_BIT BIT0
#define RECONNECT_MS 2000
#define SCAN_MAX 32

static EventGroupHandle_t s_events;
static esp_netif_t *s_netif;
static esp_timer_handle_t s_reconnect;
/* While scanning, a dropped connection is ours: do not reconnect under the scan. */
static volatile bool s_scanning;

static void reconnect(void *arg)
{
    if (!s_scanning) {
        esp_wifi_connect();
    }
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(s_events, CONNECTED_BIT);
        if (!s_scanning) {
            ESP_LOGW(TAG, "disconnected (reason %d), reconnecting", ((wifi_event_sta_disconnected_t *)data)->reason);
            esp_timer_stop(s_reconnect);
            esp_timer_start_once(s_reconnect, RECONNECT_MS * 1000);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = data;
        ESP_LOGI(TAG, "got IP " IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(s_events, CONNECTED_BIT);
        /* On the network means an update can reach this image: it may stay. */
        ota_confirm();
    }
}

void wifi_start(void)
{
    s_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    s_netif = esp_netif_create_default_wifi_sta();
    esp_netif_set_hostname(s_netif, OTA_HOSTNAME);

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL, NULL));
    const esp_timer_create_args_t timer = {.callback = reconnect, .name = "wifi_reconnect"};
    esp_timer_create(&timer, &s_reconnect);

    /* The network and password come from the driver's own NVS storage. */
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    esp_wifi_set_ps(WIFI_PS_MIN_MODEM);

    char ssid[33];
    wifi_stored_ssid(ssid, sizeof(ssid));
    ESP_LOGI(TAG, "stored network: %s", ssid[0] ? ssid : "none");
}

bool wifi_connected(void)
{
    return s_events != NULL && (xEventGroupGetBits(s_events) & CONNECTED_BIT);
}

bool wifi_wait_connected(uint32_t timeout_ms)
{
    TickType_t wait = timeout_ms ? pdMS_TO_TICKS(timeout_ms) : portMAX_DELAY;
    return xEventGroupWaitBits(s_events, CONNECTED_BIT, pdFALSE, pdTRUE, wait) & CONNECTED_BIT;
}

void wifi_stored_ssid(char *out, size_t len)
{
    wifi_config_t cfg;
    out[0] = '\0';
    if (esp_wifi_get_config(WIFI_IF_STA, &cfg) == ESP_OK) {
        /* ssid is 32 bytes and not NUL terminated when it is 32 long. */
        size_t n = strnlen((const char *)cfg.sta.ssid, sizeof(cfg.sta.ssid));
        n = n < len - 1 ? n : len - 1;
        memcpy(out, cfg.sta.ssid, n);
        out[n] = '\0';
    }
}

bool wifi_rssi(int *dbm)
{
    wifi_ap_record_t ap;
    if (!wifi_connected() || esp_wifi_sta_get_ap_info(&ap) != ESP_OK) {
        return false;
    }
    *dbm = ap.rssi;
    return true;
}

void wifi_ip(char *out, size_t len)
{
    esp_netif_ip_info_t ip;
    out[0] = '\0';
    if (wifi_connected() && esp_netif_get_ip_info(s_netif, &ip) == ESP_OK) {
        snprintf(out, len, IPSTR, IP2STR(&ip.ip));
    }
}

int wifi_scan(wifi_network_t *out, int max)
{
    s_scanning = true;
    esp_timer_stop(s_reconnect);
    /* A station that is busy connecting cannot scan. */
    if (!wifi_connected()) {
        esp_wifi_disconnect();
        vTaskDelay(pdMS_TO_TICKS(200));
    }
    int count = 0;
    if (esp_wifi_scan_start(NULL, true) == ESP_OK) {
        uint16_t n = SCAN_MAX;
        wifi_ap_record_t *records = calloc(SCAN_MAX, sizeof(wifi_ap_record_t));
        if (records && esp_wifi_scan_get_ap_records(&n, records) == ESP_OK) {
            /* Records come strongest first; keep the first of each name. */
            for (int i = 0; i < n && count < max; i++) {
                const char *name = (const char *)records[i].ssid;
                if (name[0] == '\0') {
                    continue;
                }
                bool seen = false;
                for (int j = 0; j < count && !seen; j++) {
                    seen = strcmp(out[j].ssid, name) == 0;
                }
                if (!seen) {
                    strlcpy(out[count].ssid, name, sizeof(out[count].ssid));
                    out[count].rssi = records[i].rssi;
                    out[count].open = records[i].authmode == WIFI_AUTH_OPEN;
                    count++;
                }
            }
        }
        free(records);
    }
    s_scanning = false;
    if (!wifi_connected()) {
        esp_wifi_connect();
    }
    return count;
}

esp_err_t wifi_apply(const char *ssid, const char *password)
{
    wifi_config_t cfg = {0};
    strlcpy((char *)cfg.sta.ssid, ssid, sizeof(cfg.sta.ssid));
    strlcpy((char *)cfg.sta.password, password, sizeof(cfg.sta.password));
    cfg.sta.threshold.authmode = password[0] ? WIFI_AUTH_WPA_PSK : WIFI_AUTH_OPEN;
    cfg.sta.pmf_cfg.capable = true;

    s_scanning = true; /* no reconnect to the old network in between */
    esp_timer_stop(s_reconnect);
    esp_wifi_disconnect();
    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &cfg);
    s_scanning = false;
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "network set to %s", ssid);
        esp_wifi_connect();
    }
    return err;
}
