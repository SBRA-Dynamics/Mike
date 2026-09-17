#pragma once

/*
 * The station: one network, kept by the WiFi driver in its own NVS storage.
 * Reconnects by itself; set on the board from the settings screen (F2).
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

typedef struct {
    char ssid[33];
    int8_t rssi;
    bool open;
} wifi_network_t;

/* Starts the station with the stored network, if there is one. */
void wifi_start(void);

bool wifi_connected(void);

/* Blocks until connected, or for at most timeout_ms (0 = forever). */
bool wifi_wait_connected(uint32_t timeout_ms);

/* The stored network name, "" when none. */
void wifi_stored_ssid(char *out, size_t len);

/* Signal strength of the connection in dBm; false while not connected. */
bool wifi_rssi(int *dbm);

/* The address this board has, "" while not connected. */
void wifi_ip(char *out, size_t len);

/* Networks in range, strongest first, each name once. Takes a few seconds. */
int wifi_scan(wifi_network_t *out, int max);

/* Stores a network and connects to it. */
esp_err_t wifi_apply(const char *ssid, const char *password);
