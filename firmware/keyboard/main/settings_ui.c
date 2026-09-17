#include "settings_ui.h"

#include <stdio.h>
#include <string.h>

#include "app_config.h"
#include "bsp/esp-bsp.h"
#include "esp_log.h"
#include "lvgl.h"
#include "mike_link.h"
#include "settings.h"
#include "usage_client.h"
#include "wifi.h"

static const char *TAG = "settings_ui";

#define COLOR_BG lv_color_hex(0x000000)
#define COLOR_TEXT lv_color_hex(0xF5F4EF)
#define COLOR_MUTED lv_color_hex(0x9A9893)
#define COLOR_ACCENT lv_color_hex(0xD97757)
#define COLOR_FIELD lv_color_hex(0x2A2927)

#define NETWORKS_MAX 12
#define TEXT_MAX 64
#define ADMIN_MIN 6

typedef enum { MODE_MENU, MODE_SCAN, MODE_EDIT } ui_mode_t;
typedef enum { FIELD_SSID, FIELD_WIFI_PASSWORD, FIELD_ADMIN_PASSWORD } field_t;
typedef enum { ITEM_NETWORK, ITEM_WIFI_PASSWORD, ITEM_ADMIN_PASSWORD, ITEM_CLOSE, ITEM_COUNT } item_t;

/* All of this is touched with the LVGL lock held. */
static lv_obj_t *s_screen;
static lv_obj_t *s_previous;
static lv_obj_t *s_title;
static lv_obj_t *s_note;
static lv_obj_t *s_body;
static lv_obj_t *s_help;
static bool s_active;
static ui_mode_t s_mode;
static int s_selected;

static wifi_network_t s_networks[NETWORKS_MAX];
static int s_network_count;
static bool s_scanning;

static field_t s_field;
static uint32_t s_text[TEXT_MAX];
static size_t s_len;
static size_t s_cursor;
static bool s_reveal;
/* The network chosen from the scan, waiting for its password. */
static char s_pending_ssid[33];
static char s_note_text[128];

/* ----------------------------------------------------------------- text -- */

static size_t to_utf8(const uint32_t *text, size_t len, char *out, size_t cap)
{
    size_t n = 0;
    for (size_t i = 0; i < len; i++) {
        uint32_t c = text[i];
        size_t need = c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
        if (n + need >= cap) {
            break;
        }
        if (need == 1) {
            out[n++] = (char)c;
        } else if (need == 2) {
            out[n++] = 0xC0 | (c >> 6);
            out[n++] = 0x80 | (c & 0x3F);
        } else {
            out[n++] = 0xE0 | (c >> 12);
            out[n++] = 0x80 | ((c >> 6) & 0x3F);
            out[n++] = 0x80 | (c & 0x3F);
        }
    }
    out[n] = '\0';
    return n;
}

/* ------------------------------------------------------------------- draw -- */

static lv_obj_t *label(lv_obj_t *parent, const lv_font_t *font, lv_color_t color, const char *text)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, color, 0);
    lv_label_set_text(l, text);
    return l;
}

/* One selectable line: name on the left, value on the right. */
static void row(const char *name, const char *value, bool selected)
{
    lv_obj_t *r = lv_obj_create(s_body);
    lv_obj_remove_style_all(r);
    lv_obj_set_size(r, lv_pct(100), LV_SIZE_CONTENT);
    lv_obj_set_style_pad_all(r, 8, 0);
    lv_obj_set_style_radius(r, 8, 0);
    lv_obj_set_style_bg_color(r, COLOR_ACCENT, 0);
    lv_obj_set_style_bg_opa(r, selected ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
    lv_color_t fg = selected ? COLOR_BG : COLOR_TEXT;
    lv_obj_t *n = label(r, &lv_font_montserrat_20, fg, name);
    lv_label_set_long_mode(n, LV_LABEL_LONG_DOT);
    lv_obj_set_width(n, value && value[0] ? lv_pct(60) : lv_pct(100));
    if (value && value[0]) {
        lv_obj_t *v = label(r, &lv_font_montserrat_14, selected ? COLOR_BG : COLOR_MUTED, value);
        lv_obj_align(v, LV_ALIGN_RIGHT_MID, 0, 0);
    }
}

static void info(const char *text)
{
    lv_obj_t *l = label(s_body, &lv_font_montserrat_14, COLOR_MUTED, text);
    lv_label_set_long_mode(l, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(l, lv_pct(100));
}

static void render(void)
{
    lv_obj_clean(s_body);
    lv_label_set_text(s_note, s_note_text);

    if (s_mode == MODE_MENU) {
        lv_label_set_text(s_title, "Settings");
        char ssid[33];
        wifi_stored_ssid(ssid, sizeof(ssid));
        row("WiFi network", ssid[0] ? ssid : "not set", s_selected == ITEM_NETWORK);
        row("WiFi password", "change", s_selected == ITEM_WIFI_PASSWORD);
        row("Admin password", settings_admin_password_set() ? "set" : "not set", s_selected == ITEM_ADMIN_PASSWORD);
        row("Close", "", s_selected == ITEM_CLOSE);

        char ip[16];
        wifi_ip(ip, sizeof(ip));
        mike_settings_t mike;
        bool mike_set = settings_get_mike(&mike);
        char text[256];
        snprintf(text, sizeof(text), "\nWiFi: %s%s\nWeb page: http://%s.local/\nMike: %s\nClaude: %s",
                 ip[0] ? "connected, " : "not connected", ip, OTA_HOSTNAME,
                 !mike_set ? "not set (web page)" : mike_link_connected() ? "connected" : "not connected",
                 usage_client_has_credentials() ? "logged in" : "not logged in (web page)");
        info(text);
        lv_label_set_text(s_help, "Up/Down choose   Enter open   Esc or F2 close");
    } else if (s_mode == MODE_SCAN) {
        lv_label_set_text(s_title, "Choose a network");
        if (s_scanning) {
            info("Scanning...");
        } else {
            for (int i = 0; i < s_network_count; i++) {
                char value[24];
                snprintf(value, sizeof(value), "%d dBm%s", s_networks[i].rssi, s_networks[i].open ? ", open" : "");
                row(s_networks[i].ssid, value, s_selected == i);
            }
            row("Other network...", "", s_selected == s_network_count);
        }
        lv_label_set_text(s_help, "Up/Down choose   Enter select   Esc back");
    } else {
        const char *title = s_field == FIELD_SSID ? "Network name"
                            : s_field == FIELD_ADMIN_PASSWORD ? "Admin password"
                                                              : "WiFi password";
        lv_label_set_text(s_title, title);
        if (s_field == FIELD_WIFI_PASSWORD) {
            char text[64];
            snprintf(text, sizeof(text), "For %s", s_pending_ssid);
            info(text);
        } else if (s_field == FIELD_ADMIN_PASSWORD) {
            info("Protects the web page and firmware updates. At least 6 characters.");
        }

        bool masked = s_field != FIELD_SSID && !s_reveal;
        uint32_t shown[TEXT_MAX + 1];
        size_t n = 0;
        for (size_t i = 0; i <= s_len; i++) {
            if (i == s_cursor) {
                shown[n++] = '|';
            }
            if (i < s_len) {
                shown[n++] = masked ? '*' : s_text[i];
            }
        }
        char utf8[TEXT_MAX * 3 + 4];
        to_utf8(shown, n, utf8, sizeof(utf8));

        lv_obj_t *box = lv_obj_create(s_body);
        lv_obj_remove_style_all(box);
        lv_obj_set_size(box, lv_pct(100), LV_SIZE_CONTENT);
        lv_obj_set_style_pad_all(box, 10, 0);
        lv_obj_set_style_radius(box, 8, 0);
        lv_obj_set_style_bg_color(box, COLOR_FIELD, 0);
        lv_obj_set_style_bg_opa(box, LV_OPA_COVER, 0);
        lv_obj_t *l = label(box, &lv_font_montserrat_20, COLOR_TEXT, utf8);
        lv_label_set_long_mode(l, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(l, lv_pct(100));
        lv_label_set_text(s_help, s_field == FIELD_SSID ? "Enter next   Esc back"
                                                        : "Enter save   Tab show/hide   Esc back");
    }
}

static void refresh_timer(lv_timer_t *timer)
{
    if (s_active && s_mode == MODE_MENU) {
        render(); /* the IP and connection state change under it */
    }
}

void settings_ui_create(void)
{
    s_screen = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(s_screen, COLOR_BG, 0);
    lv_obj_set_style_bg_opa(s_screen, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_hor(s_screen, 22, 0);
    lv_obj_set_style_pad_ver(s_screen, 18, 0);
    lv_obj_set_flex_flow(s_screen, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(s_screen, 10, 0);
    lv_obj_set_scrollable(s_screen, false);

    s_title = label(s_screen, &lv_font_montserrat_28, COLOR_TEXT, "Settings");
    s_note = label(s_screen, &lv_font_montserrat_14, COLOR_ACCENT, "");
    lv_label_set_long_mode(s_note, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_note, lv_pct(100));

    s_body = lv_obj_create(s_screen);
    lv_obj_remove_style_all(s_body);
    lv_obj_set_width(s_body, lv_pct(100));
    lv_obj_set_flex_grow(s_body, 1);
    lv_obj_set_flex_flow(s_body, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(s_body, 4, 0);

    s_help = label(s_screen, &lv_font_montserrat_14, COLOR_MUTED, "");
    lv_label_set_long_mode(s_help, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_help, lv_pct(100));

    lv_timer_create(refresh_timer, 2000, NULL);
}

bool settings_ui_active(void)
{
    return s_active;
}

static void open_locked(const char *note)
{
    if (!s_active) {
        s_previous = lv_screen_active();
        lv_screen_load(s_screen);
        s_active = true;
    }
    s_mode = MODE_MENU;
    s_selected = 0;
    strlcpy(s_note_text, note ? note : "", sizeof(s_note_text));
    render();
}

void settings_ui_open(const char *note)
{
    if (bsp_display_lock(0)) {
        open_locked(note);
        bsp_display_unlock();
    }
}

/* ------------------------------------------------------------------ keys -- */

static void start_edit(field_t field)
{
    s_mode = MODE_EDIT;
    s_field = field;
    s_len = 0;
    s_cursor = 0;
    s_reveal = false;
}

static void close_locked(void)
{
    s_active = false;
    lv_screen_load(s_previous);
}

/* Returns true when the screen must be redrawn after a scan (done without the lock). */
static bool menu_key(const key_event_t *e)
{
    switch (e->action) {
    case KEY_UP:
        s_selected = (s_selected + ITEM_COUNT - 1) % ITEM_COUNT;
        break;
    case KEY_DOWN:
        s_selected = (s_selected + 1) % ITEM_COUNT;
        break;
    case KEY_ESCAPE:
        close_locked();
        return false;
    case KEY_ENTER:
        s_note_text[0] = '\0';
        if (s_selected == ITEM_NETWORK) {
            s_mode = MODE_SCAN;
            s_scanning = true;
            s_selected = 0;
            return true;
        } else if (s_selected == ITEM_WIFI_PASSWORD) {
            wifi_stored_ssid(s_pending_ssid, sizeof(s_pending_ssid));
            if (s_pending_ssid[0] == '\0') {
                strlcpy(s_note_text, "Choose a network first.", sizeof(s_note_text));
            } else {
                start_edit(FIELD_WIFI_PASSWORD);
            }
        } else if (s_selected == ITEM_ADMIN_PASSWORD) {
            start_edit(FIELD_ADMIN_PASSWORD);
        } else {
            close_locked();
            return false;
        }
        break;
    default:
        return false;
    }
    render();
    return false;
}

static void scan_key(const key_event_t *e)
{
    if (s_scanning) {
        return;
    }
    int count = s_network_count + 1; /* plus "Other network..." */
    switch (e->action) {
    case KEY_UP:
        s_selected = (s_selected + count - 1) % count;
        break;
    case KEY_DOWN:
        s_selected = (s_selected + 1) % count;
        break;
    case KEY_ESCAPE:
        s_mode = MODE_MENU;
        s_selected = ITEM_NETWORK;
        break;
    case KEY_ENTER:
        if (s_selected == s_network_count) {
            start_edit(FIELD_SSID);
        } else if (s_networks[s_selected].open) {
            wifi_apply(s_networks[s_selected].ssid, "");
            snprintf(s_note_text, sizeof(s_note_text), "Connecting to %s...", s_networks[s_selected].ssid);
            s_mode = MODE_MENU;
            s_selected = ITEM_NETWORK;
        } else {
            strlcpy(s_pending_ssid, s_networks[s_selected].ssid, sizeof(s_pending_ssid));
            start_edit(FIELD_WIFI_PASSWORD);
        }
        break;
    default:
        return;
    }
    render();
}

static void save_edit(void)
{
    char text[TEXT_MAX * 3 + 1];
    to_utf8(s_text, s_len, text, sizeof(text));

    switch (s_field) {
    case FIELD_SSID:
        if (s_len == 0) {
            return;
        }
        strlcpy(s_pending_ssid, text, sizeof(s_pending_ssid));
        start_edit(FIELD_WIFI_PASSWORD);
        return;
    case FIELD_WIFI_PASSWORD:
        if (wifi_apply(s_pending_ssid, text) == ESP_OK) {
            snprintf(s_note_text, sizeof(s_note_text), "Saved. Connecting to %s...", s_pending_ssid);
        } else {
            strlcpy(s_note_text, "Could not save the network.", sizeof(s_note_text));
        }
        s_mode = MODE_MENU;
        s_selected = ITEM_NETWORK;
        return;
    case FIELD_ADMIN_PASSWORD:
        if (s_len < ADMIN_MIN) {
            strlcpy(s_note_text, "At least 6 characters.", sizeof(s_note_text));
            return;
        }
        strlcpy(s_note_text,
                settings_set_admin_password(text) == ESP_OK ? "Admin password saved." : "Could not save the password.",
                sizeof(s_note_text));
        s_mode = MODE_MENU;
        s_selected = ITEM_ADMIN_PASSWORD;
        return;
    }
}

static void edit_key(const key_event_t *e)
{
    switch (e->action) {
    case KEY_CHAR:
        if (s_len < TEXT_MAX && e->codepoint < 0x10000) {
            memmove(s_text + s_cursor + 1, s_text + s_cursor, (s_len - s_cursor) * sizeof(uint32_t));
            s_text[s_cursor++] = e->codepoint;
            s_len++;
        }
        break;
    case KEY_BACKSPACE:
        if (s_cursor > 0) {
            memmove(s_text + s_cursor - 1, s_text + s_cursor, (s_len - s_cursor) * sizeof(uint32_t));
            s_cursor--;
            s_len--;
        }
        break;
    case KEY_DELETE:
        if (s_cursor < s_len) {
            memmove(s_text + s_cursor, s_text + s_cursor + 1, (s_len - s_cursor - 1) * sizeof(uint32_t));
            s_len--;
        }
        break;
    case KEY_LEFT:
        s_cursor = s_cursor > 0 ? s_cursor - 1 : 0;
        break;
    case KEY_RIGHT:
        s_cursor = s_cursor < s_len ? s_cursor + 1 : s_len;
        break;
    case KEY_HOME:
        s_cursor = 0;
        break;
    case KEY_END:
        s_cursor = s_len;
        break;
    case KEY_KILL_START:
        memmove(s_text, s_text + s_cursor, (s_len - s_cursor) * sizeof(uint32_t));
        s_len -= s_cursor;
        s_cursor = 0;
        break;
    case KEY_TAB:
        s_reveal = !s_reveal;
        break;
    case KEY_ESCAPE:
        s_mode = MODE_MENU;
        break;
    case KEY_ENTER:
        save_edit();
        break;
    default:
        return;
    }
    render();
}

void settings_ui_key(const key_event_t *event)
{
    bool scan = false;
    if (s_screen == NULL || !bsp_display_lock(0)) {
        return;
    }
    if (event->action == KEY_SETTINGS) {
        if (s_active) {
            close_locked();
        } else {
            open_locked(NULL);
        }
    } else if (s_active) {
        switch (s_mode) {
        case MODE_MENU:
            scan = menu_key(event);
            if (scan) {
                render();
            }
            break;
        case MODE_SCAN:
            scan_key(event);
            break;
        case MODE_EDIT:
            edit_key(event);
            break;
        }
    }
    bsp_display_unlock();

    if (scan) {
        /* Seconds long: done without holding the display. */
        wifi_network_t found[NETWORKS_MAX];
        int n = wifi_scan(found, NETWORKS_MAX);
        ESP_LOGI(TAG, "%d networks", n);
        if (bsp_display_lock(0)) {
            memcpy(s_networks, found, sizeof(found));
            s_network_count = n;
            s_scanning = false;
            if (s_active && s_mode == MODE_SCAN) {
                render();
            }
            bsp_display_unlock();
        }
    }
}
