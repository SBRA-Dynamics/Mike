#include "factory_reset.h"

#include <stdio.h>

#include "app_config.h"
#include "bsp/esp-bsp.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "nvs.h"

static const char *TAG = "factory_reset";

#define BOOT_BUTTON GPIO_NUM_0
#define POLL_MS 50
#define UPDATE_MS 100

/* The namespaces that hold settings; the WiFi driver's own is cleared with esp_wifi_restore(). */
static const char *const NAMESPACES[] = {"settings", "claude", "keyboard"};

static bool pressed(void)
{
    return gpio_get_level(BOOT_BUTTON) == 0;
}

static void erase_everything(void)
{
    ESP_LOGW(TAG, "resetting all settings");
    esp_wifi_restore();
    for (size_t i = 0; i < sizeof(NAMESPACES) / sizeof(NAMESPACES[0]); i++) {
        nvs_handle_t nvs;
        if (nvs_open(NAMESPACES[i], NVS_READWRITE, &nvs) == ESP_OK) {
            nvs_erase_all(nvs);
            nvs_commit(nvs);
            nvs_close(nvs);
        }
    }
}

typedef struct {
    lv_obj_t *screen;
    lv_obj_t *previous;
    lv_obj_t *label;
    lv_obj_t *bar;
} countdown_ui_t;

static void show(countdown_ui_t *ui)
{
    if (!bsp_display_lock(0)) {
        return;
    }
    ui->previous = lv_screen_active();
    ui->screen = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(ui->screen, lv_color_hex(0x000000), 0);
    lv_obj_set_style_bg_opa(ui->screen, LV_OPA_COVER, 0);
    lv_obj_set_scrollable(ui->screen, false);

    ui->label = lv_label_create(ui->screen);
    lv_obj_set_style_text_font(ui->label, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(ui->label, lv_color_hex(0xF5F4EF), 0);
    lv_obj_align(ui->label, LV_ALIGN_CENTER, 0, -30);

    ui->bar = lv_bar_create(ui->screen);
    lv_obj_set_size(ui->bar, 280, 14);
    lv_obj_align(ui->bar, LV_ALIGN_CENTER, 0, 10);
    lv_bar_set_range(ui->bar, 0, FACTORY_RESET_COUNTDOWN_S * 1000);
    lv_obj_set_style_radius(ui->bar, 7, LV_PART_MAIN);
    lv_obj_set_style_radius(ui->bar, 7, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(ui->bar, lv_color_hex(0x2A2927), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(ui->bar, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_bg_color(ui->bar, lv_color_hex(0xE5484D), LV_PART_INDICATOR);

    lv_obj_t *hint = lv_label_create(ui->screen);
    lv_obj_set_style_text_font(hint, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(hint, lv_color_hex(0x9A9893), 0);
    lv_label_set_text(hint, "Release BOOT to cancel");
    lv_obj_align(hint, LV_ALIGN_CENTER, 0, 45);

    lv_screen_load(ui->screen);
    bsp_display_unlock();
}

static void update(countdown_ui_t *ui, int left_ms)
{
    if (!bsp_display_lock(0)) {
        return;
    }
    lv_label_set_text_fmt(ui->label, "Resetting settings in %ds", (left_ms + 999) / 1000);
    lv_bar_set_value(ui->bar, left_ms, LV_ANIM_OFF);
    bsp_display_unlock();
}

static void hide(countdown_ui_t *ui)
{
    if (!bsp_display_lock(0)) {
        return;
    }
    lv_screen_load(ui->previous);
    lv_obj_delete(ui->screen);
    bsp_display_unlock();
}

static void finish(countdown_ui_t *ui)
{
    if (bsp_display_lock(0)) {
        lv_label_set_text(ui->label, "Settings reset. Restarting...");
        lv_bar_set_value(ui->bar, 0, LV_ANIM_OFF);
        bsp_display_unlock();
    }
    erase_everything();
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_restart();
}

static void watch_task(void *arg)
{
    for (;;) {
        /* Wait for a hold of FACTORY_RESET_HOLD_S. */
        int held_ms = 0;
        while (held_ms < FACTORY_RESET_HOLD_S * 1000) {
            vTaskDelay(pdMS_TO_TICKS(POLL_MS));
            held_ms = pressed() ? held_ms + POLL_MS : 0;
        }
        ESP_LOGW(TAG, "BOOT held for %d s, counting down", FACTORY_RESET_HOLD_S);

        countdown_ui_t ui = {0};
        show(&ui);
        int left_ms = FACTORY_RESET_COUNTDOWN_S * 1000;
        while (left_ms > 0 && pressed()) {
            update(&ui, left_ms);
            vTaskDelay(pdMS_TO_TICKS(UPDATE_MS));
            left_ms -= UPDATE_MS;
        }
        if (left_ms <= 0) {
            finish(&ui);
        }
        ESP_LOGI(TAG, "released, reset cancelled");
        hide(&ui);
        /* Only a fresh press starts over. */
        while (pressed()) {
            vTaskDelay(pdMS_TO_TICKS(POLL_MS));
        }
    }
}

void factory_reset_start(void)
{
    const gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << BOOT_BUTTON,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&cfg);
    xTaskCreate(watch_task, "factory_reset", 4096, NULL, 3, NULL);
}
