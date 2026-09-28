#include "screen_sleep.h"

#include "app_config.h"
#include "bsp/esp-bsp.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lvgl.h"

static const char *TAG = "screen_sleep";

/* The PWR key is also wired to GPIO 10 (SYS_OUT), high while it is pressed. */
#define PWR_BUTTON GPIO_NUM_10
#define CHECK_MS 100
#define POLL_MS 50

static bool s_dark;

static void set_dark(bool dark)
{
    s_dark = dark;
    bsp_display_brightness_set(dark ? 0 : DISPLAY_BRIGHTNESS);
    /* While dark the top layer takes the touch, so the first tap only wakes the screen. */
    lv_obj_set_clickable(lv_layer_top(), dark);
    ESP_LOGI(TAG, "screen %s", dark ? "off" : "on");
}

/* Runs in the LVGL task: touches reset LVGL's inactivity time by themselves,
 * the buttons and keys through screen_sleep_wake(). */
static void check_cb(lv_timer_t *timer)
{
    bool idle = lv_display_get_inactive_time(NULL) >= SCREEN_OFF_S * 1000;
    if (idle != s_dark) {
        set_dark(idle);
    }
}

bool screen_sleep_wake(void)
{
    bool was_dark = false;
    if (bsp_display_lock(0)) {
        was_dark = s_dark;
        lv_display_trigger_activity(NULL);
        if (s_dark) {
            set_dark(false);
        }
        bsp_display_unlock();
    }
    return was_dark;
}

static void pwr_task(void *arg)
{
    bool was_pressed = false;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
        bool now = gpio_get_level(PWR_BUTTON) == 1;
        if (now && !was_pressed) {
            screen_sleep_wake();
        }
        was_pressed = now;
    }
}

void screen_sleep_start(void)
{
    lv_timer_create(check_cb, CHECK_MS, NULL);

    const gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << PWR_BUTTON,
        .mode = GPIO_MODE_INPUT,
    };
    gpio_config(&cfg);
    xTaskCreate(pwr_task, "pwr_button", 2560, NULL, 3, NULL);
}
