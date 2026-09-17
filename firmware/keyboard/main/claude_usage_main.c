#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "bsp/esp-bsp.h"
#include "esp_event.h"
#include "esp_idf_version.h"
#include "esp_io_expander.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "factory_reset.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "app_config.h"
#include "keyboard_input.h"
#include "line_editor.h"
#include "lvgl.h"
#include "mike_link.h"
#include "nvs_flash.h"
#include "ota_server.h"
#include "power.h"
#include "settings.h"
#include "settings_ui.h"
#include "usage_client.h"
#include "wifi.h"

static const char *TAG = "claude_usage";

#define RETRY_AFTER_ERROR_S 30
#define PIXEL_SHIFT_PERIOD_MS (5 * 60 * 1000)
#define SCREEN_MARGIN 6

#define COLOR_BG lv_color_hex(0x000000)
#define COLOR_TEXT lv_color_hex(0xF5F4EF)
#define COLOR_MUTED lv_color_hex(0x9A9893)
#define COLOR_TRACK lv_color_hex(0x2A2927)
#define COLOR_ACCENT lv_color_hex(0xD97757) /* Claude orange */
#define COLOR_WARN lv_color_hex(0xE8A33D)
#define COLOR_CRIT lv_color_hex(0xE5484D)
#define COLOR_OK lv_color_hex(0x46A758)

static TaskHandle_t s_poll_task;

/* Everything below is only touched with the LVGL lock held. */
static lv_obj_t *s_root;
static lv_obj_t *s_content;
static lv_obj_t *s_footer;
static lv_obj_t *s_status_dot;
static lv_obj_t *s_battery;
static lv_obj_t *s_wifi;
static lv_obj_t *s_wifi_bars[4];
static usage_data_t s_data;
static bool s_have_data;
static char s_error[128];
static char s_status[96];

/* ------------------------------------------------------------------ UI -- */

static lv_color_t severity_color(int percent)
{
    if (percent >= 90) {
        return COLOR_CRIT;
    }
    if (percent >= 75) {
        return COLOR_WARN;
    }
    return COLOR_ACCENT;
}

/* "Resets in 2 d 5 h 13 min", leading zero units left out. */
static void format_reset(time_t resets_at, char *buf, size_t len)
{
    buf[0] = '\0';
    if (resets_at == 0) {
        return;
    }
    long diff = (long)(resets_at - time(NULL));
    if (diff <= 0) {
        strlcpy(buf, "Resetting now", len);
        return;
    }
    long minutes = (diff + 59) / 60;
    long days = minutes / (24 * 60);
    long hours = (minutes / 60) % 24;
    minutes %= 60;
    if (days > 0) {
        snprintf(buf, len, "Resets in %ld d %ld h %ld min", days, hours, minutes);
    } else if (hours > 0) {
        snprintf(buf, len, "Resets in %ld h %ld min", hours, minutes);
    } else {
        snprintf(buf, len, "Resets in %ld min", minutes);
    }
}

static lv_obj_t *plain_container(lv_obj_t *parent)
{
    lv_obj_t *obj = lv_obj_create(parent);
    lv_obj_remove_style_all(obj);
    lv_obj_set_clickable(obj, false);
    lv_obj_set_event_bubble(obj, true);
    lv_obj_set_width(obj, lv_pct(100));
    lv_obj_set_height(obj, LV_SIZE_CONTENT);
    return obj;
}

static lv_obj_t *label(lv_obj_t *parent, const lv_font_t *font, lv_color_t color, const char *text)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, color, 0);
    lv_label_set_text(l, text);
    return l;
}

static void section_header(const char *text)
{
    lv_obj_t *l = label(s_content, &lv_font_montserrat_14, COLOR_MUTED, text);
    lv_obj_set_style_pad_top(l, 6, 0);
}

static void usage_row(const char *title, const char *value, int percent, const char *subtitle, bool dimmed)
{
    lv_obj_t *row = plain_container(s_content);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(row, 6, 0);

    lv_obj_t *top = plain_container(row);
    label(top, &lv_font_montserrat_20, COLOR_TEXT, title);
    lv_obj_t *pct = label(top, &lv_font_montserrat_20, COLOR_TEXT, value);
    lv_obj_align(pct, LV_ALIGN_TOP_RIGHT, 0, 0);

    lv_obj_t *bar = lv_bar_create(row);
    lv_obj_set_clickable(bar, false);
    lv_obj_set_size(bar, lv_pct(100), 12);
    lv_bar_set_range(bar, 0, 100);
    lv_bar_set_value(bar, percent, LV_ANIM_OFF);
    lv_obj_set_style_radius(bar, 6, LV_PART_MAIN);
    lv_obj_set_style_radius(bar, 6, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(bar, COLOR_TRACK, LV_PART_MAIN);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_bg_color(bar, dimmed ? COLOR_MUTED : severity_color(percent), LV_PART_INDICATOR);

    if (subtitle != NULL && subtitle[0] != '\0') {
        label(row, &lv_font_montserrat_14, COLOR_MUTED, subtitle);
    }
}

static void render(void)
{
    lv_obj_clean(s_content);

    if (!s_have_data) {
        lv_obj_t *l = label(s_content, &lv_font_montserrat_20, COLOR_MUTED, s_status);
        lv_label_set_long_mode(l, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(l, lv_pct(100));
    } else {
        char value[16];
        char subtitle[64];
        bool weekly_header = false;
        for (int i = 0; i < s_data.limit_count; i++) {
            const usage_limit_t *l = &s_data.limits[i];
            if (l->weekly && !weekly_header) {
                section_header("Weekly limits");
                weekly_header = true;
            }
            snprintf(value, sizeof(value), "%d%%", l->percent);
            format_reset(l->resets_at, subtitle, sizeof(subtitle));
            usage_row(l->title, value, l->percent, subtitle, false);
        }

        if (s_data.spend_present && (s_data.spend_enabled || s_data.spend_used > 0)) {
            section_header("Extra usage");
            char title[48];
            snprintf(title, sizeof(title), "%.2f / %.0f %s", s_data.spend_used, s_data.spend_limit,
                     s_data.spend_currency);
            snprintf(value, sizeof(value), "%d%%", s_data.spend_percent);
            usage_row(title, value, s_data.spend_percent > 100 ? 100 : s_data.spend_percent,
                      s_data.spend_enabled ? "Enabled" : "Turned off", !s_data.spend_enabled);
        }
    }

    bool wifi_up = wifi_connected();
    lv_color_t dot = COLOR_OK;
    if (!wifi_up || (s_error[0] && !s_have_data)) {
        dot = COLOR_CRIT;
    } else if (s_error[0]) {
        dot = COLOR_WARN;
    }
    lv_obj_set_style_bg_color(s_status_dot, dot, 0);

    if (s_error[0] != '\0') {
        lv_label_set_text(s_footer, s_error);
        lv_obj_set_style_text_color(s_footer, COLOR_CRIT, 0);
    } else if (s_have_data) {
        struct tm tm;
        localtime_r(&s_data.fetched_at, &tm);
        char text[96];
        size_t n = strftime(text, sizeof(text), "Updated %H:%M", &tm);
        if (mike_link_enabled()) {
            snprintf(text + n, sizeof(text) - n, "   Keyboard %s, Mike %s", keyboard_input_attached() ? "on" : "off",
                     mike_link_connected() ? "on" : "off");
        }
        lv_label_set_text(s_footer, text);
        lv_obj_set_style_text_color(s_footer, COLOR_MUTED, 0);
    } else {
        lv_label_set_text(s_footer, "");
    }
}

/* The battery in the header: level and percent, a bolt while charging, USB without a battery. */
static void battery_render(void)
{
    power_status_t p;
    power_get(&p);
    char text[32] = "";
    lv_color_t color = COLOR_MUTED;
    if (p.ok && p.battery && p.percent >= 0) {
        const char *level = p.percent >= 85   ? LV_SYMBOL_BATTERY_FULL
                            : p.percent >= 60 ? LV_SYMBOL_BATTERY_3
                            : p.percent >= 35 ? LV_SYMBOL_BATTERY_2
                            : p.percent >= 10 ? LV_SYMBOL_BATTERY_1
                                              : LV_SYMBOL_BATTERY_EMPTY;
        if (p.flow == POWER_CHARGING) {
            snprintf(text, sizeof(text), LV_SYMBOL_CHARGE " %s %d%%", level, p.percent);
            color = COLOR_OK;
        } else {
            snprintf(text, sizeof(text), "%s %d%%", level, p.percent);
            color = p.percent <= 15 && !p.usb_power ? COLOR_CRIT : COLOR_MUTED;
        }
    } else if (p.ok && p.usb_power) {
        strlcpy(text, LV_SYMBOL_USB, sizeof(text));
    }
    lv_label_set_text(s_battery, text);
    lv_obj_set_style_text_color(s_battery, color, 0);
    lv_obj_align_to(s_battery, s_status_dot, LV_ALIGN_OUT_LEFT_MID, -10, 0);
}

/* WiFi strength as four bars; all dim and the first one red while not connected. */
static void wifi_render(void)
{
    int dbm = 0;
    bool connected = wifi_rssi(&dbm);
    int lit = !connected ? 0 : dbm >= -55 ? 4 : dbm >= -65 ? 3 : dbm >= -75 ? 2 : 1;
    for (int i = 0; i < 4; i++) {
        lv_color_t color = i < lit ? COLOR_TEXT : COLOR_TRACK;
        if (!connected && i == 0) {
            color = COLOR_CRIT;
        }
        lv_obj_set_style_bg_color(s_wifi_bars[i], color, 0);
    }
    lv_obj_align_to(s_wifi, s_battery, LV_ALIGN_OUT_LEFT_BOTTOM, -12, 0);
}

static void battery_timer_cb(lv_timer_t *timer)
{
    battery_render();
    wifi_render();
}

static void tick_timer_cb(lv_timer_t *timer)
{
    render(); /* keeps the "Resets in" countdowns current */
}

static void pixel_shift_cb(lv_timer_t *timer)
{
    /* AMOLED burn-in protection: nudge the static layout a few pixels. */
    int dx = (int)(esp_random() % (2 * SCREEN_MARGIN + 1)) - SCREEN_MARGIN;
    int dy = (int)(esp_random() % (2 * SCREEN_MARGIN + 1)) - SCREEN_MARGIN;
    lv_obj_set_pos(s_root, SCREEN_MARGIN + dx, SCREEN_MARGIN + dy);
}

static void touch_cb(lv_event_t *e)
{
    if (s_poll_task != NULL) {
        xTaskNotifyGive(s_poll_task);
    }
}

static void ui_create(void)
{
    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, COLOR_BG, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_set_scrollable(scr, false);
    lv_obj_add_event_cb(scr, touch_cb, LV_EVENT_CLICKED, NULL);

    s_root = lv_obj_create(scr);
    lv_obj_remove_style_all(s_root);
    lv_obj_set_event_bubble(s_root, true);
    lv_obj_set_size(s_root, lv_display_get_horizontal_resolution(NULL) - 2 * SCREEN_MARGIN,
                    lv_display_get_vertical_resolution(NULL) - 2 * SCREEN_MARGIN);
    lv_obj_set_pos(s_root, SCREEN_MARGIN, SCREEN_MARGIN);
    lv_obj_set_style_pad_hor(s_root, 16, 0);
    lv_obj_set_style_pad_ver(s_root, 14, 0);
    lv_obj_set_flex_flow(s_root, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(s_root, 10, 0);

    lv_obj_t *header = plain_container(s_root);
    label(header, &lv_font_montserrat_28, COLOR_TEXT, "Plan usage");
    s_status_dot = lv_obj_create(header);
    lv_obj_remove_style_all(s_status_dot);
    lv_obj_set_size(s_status_dot, 12, 12);
    lv_obj_set_style_radius(s_status_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(s_status_dot, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(s_status_dot, COLOR_MUTED, 0);
    lv_obj_align(s_status_dot, LV_ALIGN_RIGHT_MID, 0, 0);
    s_battery = label(header, &lv_font_montserrat_14, COLOR_MUTED, "");
    lv_obj_align_to(s_battery, s_status_dot, LV_ALIGN_OUT_LEFT_MID, -10, 0);

    s_wifi = lv_obj_create(header);
    lv_obj_remove_style_all(s_wifi);
    lv_obj_set_size(s_wifi, 4 * 4 + 3 * 2, 14);
    for (int i = 0; i < 4; i++) {
        s_wifi_bars[i] = lv_obj_create(s_wifi);
        lv_obj_remove_style_all(s_wifi_bars[i]);
        lv_obj_set_size(s_wifi_bars[i], 4, 5 + i * 3);
        lv_obj_set_style_radius(s_wifi_bars[i], 1, 0);
        lv_obj_set_style_bg_opa(s_wifi_bars[i], LV_OPA_COVER, 0);
        lv_obj_align(s_wifi_bars[i], LV_ALIGN_BOTTOM_LEFT, i * 6, 0);
    }
    wifi_render();

    s_content = plain_container(s_root);
    lv_obj_set_flex_flow(s_content, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(s_content, 14, 0);
    lv_obj_set_flex_grow(s_content, 1);
    lv_obj_set_scrollable(s_content, true);
    lv_obj_set_scrollbar_mode(s_content, LV_SCROLLBAR_MODE_OFF);

    s_footer = label(s_root, &lv_font_montserrat_14, COLOR_MUTED, "");
    lv_label_set_long_mode(s_footer, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_footer, lv_pct(100));

    battery_render();
    wifi_render();
    render();
    lv_timer_create(tick_timer_cb, 20 * 1000, NULL);
    lv_timer_create(battery_timer_cb, 5 * 1000, NULL);
    lv_timer_create(pixel_shift_cb, PIXEL_SHIFT_PERIOD_MS, NULL);
}

static void ui_set_status(const char *status)
{
    ESP_LOGI(TAG, "%s", status);
    if (bsp_display_lock(0)) {
        strlcpy(s_status, status, sizeof(s_status));
        render();
        bsp_display_unlock();
    }
}


/* ---------------------------------------------------------------- Poll -- */

static void poll_task(void *arg)
{
    char ssid[33];
    wifi_stored_ssid(ssid, sizeof(ssid));
    char status[96];
    if (ssid[0] == '\0') {
        snprintf(status, sizeof(status), "No WiFi set.\nPress F2 on the keyboard.");
    } else {
        snprintf(status, sizeof(status), "Connecting to WiFi\n\"%s\"...", ssid);
    }
    ui_set_status(status);
    wifi_wait_connected(0);

    ui_set_status("Syncing time...");
    esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    esp_netif_sntp_init(&sntp);
    if (esp_netif_sntp_sync_wait(pdMS_TO_TICKS(15000)) != ESP_OK) {
        ESP_LOGW(TAG, "SNTP sync timed out, continuing");
    }

    ui_set_status("Fetching usage...");
    usage_data_t *data = heap_caps_malloc(sizeof(usage_data_t), MALLOC_CAP_SPIRAM);
    char err[128];
    uint32_t backoff_s = 0;

    while (true) {
        uint32_t wait_s = USAGE_POLL_INTERVAL_S;
        TickType_t fetched_at = xTaskGetTickCount();
        if (!wifi_connected()) {
            strlcpy(err, "WiFi disconnected", sizeof(err));
            wait_s = 5;
        } else if (usage_client_fetch(data, err, sizeof(err)) == ESP_OK) {
            ESP_LOGI(TAG, "usage: %d limits, first %s %d%%", data->limit_count, data->limits[0].title,
                     data->limits[0].percent);
            backoff_s = 0;
        } else if (strstr(err, "429") != NULL) {
            /* Rate limited: honour Retry-After, and back off harder each time it repeats. */
            backoff_s = backoff_s ? backoff_s * 2 : USAGE_BACKOFF_MIN_S;
            backoff_s = backoff_s > USAGE_BACKOFF_MAX_S ? USAGE_BACKOFF_MAX_S : backoff_s;
            int retry_after = usage_client_retry_after_s();
            wait_s = retry_after > (int)backoff_s ? (uint32_t)retry_after : backoff_s;
            snprintf(err, sizeof(err), "Rate limited, next try in %lu min", (unsigned long)((wait_s + 59) / 60));
            ESP_LOGW(TAG, "rate limited, waiting %lu s", (unsigned long)wait_s);
        } else {
            ESP_LOGW(TAG, "fetch failed: %s", err);
            wait_s = RETRY_AFTER_ERROR_S;
        }

        if (bsp_display_lock(0)) {
            if (err[0] == '\0') {
                s_data = *data;
                s_have_data = true;
                s_error[0] = '\0';
            } else {
                strlcpy(s_error, err, sizeof(s_error));
                strlcpy(s_status, "Waiting for data...", sizeof(s_status));
            }
            render();
            bsp_display_unlock();
        }

        /* Sleep until the next poll. A tap brings it forward, but never closer than
         * USAGE_TAP_MIN_S to the last fetch, and not at all while rate limited. */
        TickType_t due = fetched_at + pdMS_TO_TICKS(wait_s * 1000);
        for (;;) {
            TickType_t now = xTaskGetTickCount();
            if (now >= due) {
                break;
            }
            if (ulTaskNotifyTake(pdTRUE, due - now) && backoff_s == 0) {
                TickType_t earliest = fetched_at + pdMS_TO_TICKS(USAGE_TAP_MIN_S * 1000);
                if (earliest < due) {
                    due = earliest;
                }
            }
        }
    }
}

/* Keystrokes: F2 and the settings screen first, everything else to Mike. */
static void on_key(const key_event_t *event)
{
    if (event->action == KEY_SETTINGS || settings_ui_active()) {
        settings_ui_key(event);
        return;
    }
    line_editor_key(event);
}

void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);
    ota_watchdog_start();
    settings_init();

    setenv("TZ", LOCAL_TIMEZONE, 1);
    tzset();

    /* esp_wifi_init() needs a large contiguous block of internal RAM: start it before LVGL. */
    wifi_start();
    ota_server_start();
    usage_client_init();

    /* The keyboard: settings on F2, everything else -> line editor -> the text box on the glasses. */
    mike_link_start();
    if (KEYBOARD_DEBUG) {
        mike_link_forward_logs();
    }
    line_editor_init();
    keyboard_input_start(on_key);

    /*
     * The panel and touch reset lines sit on the TCA9554 expander (pins 0-2), and the BSP
     * never drives them, so pulse them like Waveshare's Arduino examples do. Without this
     * the FT3168 touch controller on V1 boards does not answer and the BSP aborts.
     */
    esp_io_expander_handle_t expander = bsp_io_expander_init();
    if (expander != NULL) {
        const uint32_t pins = IO_EXPANDER_PIN_NUM_0 | IO_EXPANDER_PIN_NUM_1 | IO_EXPANDER_PIN_NUM_2;
        esp_io_expander_set_dir(expander, pins, IO_EXPANDER_OUTPUT);
        esp_io_expander_set_level(expander, pins, 0);
        vTaskDelay(pdMS_TO_TICKS(20));
        esp_io_expander_set_level(expander, pins, 1);
        vTaskDelay(pdMS_TO_TICKS(200));
    }

#if ESP_IDF_VERSION < ESP_IDF_VERSION_VAL(6, 0, 0)
    esp_log_level_t i2c_log_level = esp_log_level_get("i2c.master");
    esp_log_level_set("i2c.master", ESP_LOG_NONE);
#endif
    bsp_display_cfg_t display_cfg = {
        .lvgl_port_cfg = ESP_LVGL_PORT_INIT_CONFIG(),
    };
    display_cfg.lvgl_port_cfg.task_stack = 12 * 1024;
    lv_display_t *display = bsp_display_start_with_config(&display_cfg);
#if ESP_IDF_VERSION < ESP_IDF_VERSION_VAL(6, 0, 0)
    esp_log_level_set("i2c.master", i2c_log_level);
#endif
    if (display == NULL) {
        ESP_LOGE(TAG, "display start failed");
        return;
    }
    bsp_display_brightness_set(DISPLAY_BRIGHTNESS);

    if (bsp_display_lock(0)) {
        ui_create();
        settings_ui_create();
        bsp_display_unlock();
    }
    factory_reset_start();
    power_start();

    char ssid[33];
    wifi_stored_ssid(ssid, sizeof(ssid));
    if (ssid[0] == '\0') {
        settings_ui_open("No WiFi yet. Choose a network, then set an admin password for the web page.");
    }

    xTaskCreate(poll_task, "usage_poll", 10240, NULL, 5, &s_poll_task);
}
