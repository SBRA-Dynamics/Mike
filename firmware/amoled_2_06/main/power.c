#include "power.h"

#include "bsp/esp-bsp.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "power";

#define AXP2101_ADDR 0x34
#define REG_STATUS1 0x00        /* bit5 VBUS good, bit3 battery present */
#define REG_STATUS2 0x01        /* bits7:5 current direction, bits2:0 charger state */
#define REG_GAUGE_CTRL 0x18     /* bit3 fuel gauge on */
#define REG_ADC_CTRL 0x30       /* bit0 battery voltage ADC on */
#define REG_VBAT_H 0x34         /* battery voltage, 13 bits, mV */
#define REG_VBAT_L 0x35
#define REG_BAT_DETECT 0x68     /* bit0 battery detection on */
#define REG_PERCENT 0xA4        /* fuel gauge, 0-100 */

#define POLL_MS 5000

static i2c_master_dev_handle_t s_dev;
static SemaphoreHandle_t s_lock;
static power_status_t s_status;

static bool read_reg(uint8_t reg, uint8_t *value)
{
    return i2c_master_transmit_receive(s_dev, &reg, 1, value, 1, 100) == ESP_OK;
}

static void set_bit(uint8_t reg, uint8_t bit)
{
    uint8_t value;
    if (read_reg(reg, &value) && !(value & (1 << bit))) {
        uint8_t buf[2] = {reg, value | (1 << bit)};
        i2c_master_transmit(s_dev, buf, sizeof(buf), 100);
    }
}

static void read_status(power_status_t *st)
{
    uint8_t s1, s2, percent, vh, vl;
    *st = (power_status_t){.percent = -1};
    if (!read_reg(REG_STATUS1, &s1) || !read_reg(REG_STATUS2, &s2)) {
        return;
    }
    st->ok = true;
    st->battery = s1 & (1 << 3);
    st->usb_power = (s1 & (1 << 5)) && !(s2 & (1 << 3));
    switch (s2 >> 5) {
    case 1: st->flow = POWER_CHARGING; break;
    case 2: st->flow = POWER_DISCHARGING; break;
    default: st->flow = POWER_IDLE; break;
    }
    st->charge_done = (s2 & 0x07) == 4;
    if (st->battery) {
        if (read_reg(REG_PERCENT, &percent)) {
            st->percent = percent > 100 ? 100 : percent;
        }
        if (read_reg(REG_VBAT_H, &vh) && read_reg(REG_VBAT_L, &vl)) {
            st->millivolts = ((vh & 0x1F) << 8) | vl;
        }
    }
}

static void poll_task(void *arg)
{
    power_status_t last = {0};
    for (;;) {
        power_status_t st;
        read_status(&st);
        xSemaphoreTake(s_lock, portMAX_DELAY);
        s_status = st;
        xSemaphoreGive(s_lock);
        if (st.ok != last.ok || st.battery != last.battery || st.flow != last.flow || st.usb_power != last.usb_power) {
            ESP_LOGI(TAG, "battery %s %d%% %d mV, usb %s, %s", st.battery ? "present" : "absent", st.percent,
                     st.millivolts, st.usb_power ? "yes" : "no",
                     st.flow == POWER_CHARGING ? "charging" : st.flow == POWER_DISCHARGING ? "discharging" : "idle");
        }
        last = st;
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
}

void power_start(void)
{
    s_lock = xSemaphoreCreateMutex();
    i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
    const i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = AXP2101_ADDR,
        .scl_speed_hz = 400000,
    };
    if (bus == NULL || i2c_master_bus_add_device(bus, &cfg, &s_dev) != ESP_OK) {
        ESP_LOGE(TAG, "no I2C bus for the AXP2101");
        return;
    }
    /* The gauge only runs with battery detection and the battery voltage ADC on. */
    set_bit(REG_BAT_DETECT, 0);
    set_bit(REG_ADC_CTRL, 0);
    set_bit(REG_GAUGE_CTRL, 3);
    xTaskCreate(poll_task, "power", 3072, NULL, 2, NULL);
}

void power_get(power_status_t *out)
{
    if (s_lock == NULL) {
        *out = (power_status_t){.percent = -1};
        return;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    *out = s_status;
    xSemaphoreGive(s_lock);
}
