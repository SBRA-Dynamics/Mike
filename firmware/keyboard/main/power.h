#pragma once

/*
 * Battery and charging, read from the board's AXP2101 power manager (I2C 0x34).
 *
 * The AXP2101 has its own fuel gauge: it tracks the battery from its voltage
 * and the charge going in and out, and keeps a state-of-charge estimate in
 * register 0xA4 (0-100 %). The estimate needs a few charge cycles to settle,
 * and it is not written anywhere else - after the battery has been
 * disconnected the gauge starts over from the voltage alone. Only reads, and
 * the three enable bits the gauge needs; the charger's own settings are left
 * as the board comes.
 */

#include <stdbool.h>

typedef enum {
    POWER_IDLE,         /* no current either way: full, or no battery */
    POWER_CHARGING,
    POWER_DISCHARGING,
} power_flow_t;

typedef struct {
    bool ok;            /* the AXP2101 answered */
    bool battery;       /* a battery is connected */
    int percent;        /* fuel gauge estimate, -1 without a battery */
    int millivolts;     /* battery voltage, 0 without a battery */
    bool usb_power;     /* VBUS present and good */
    power_flow_t flow;
    bool charge_done;
} power_status_t;

/* Starts reading. Call after the display (which sets up the I2C bus). */
void power_start(void);

/* The last reading. */
void power_get(power_status_t *out);
