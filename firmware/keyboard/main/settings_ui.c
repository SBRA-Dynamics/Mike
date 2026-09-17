#include "settings_ui.h"

#include <stdio.h>
#include <string.h>

#include "app_config.h"
#include "bsp/esp-bsp.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
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
#define KEYBOARD_HEIGHT 210

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
/* In MODE_EDIT: the field and the on-screen keyboard that types into it. */
static lv_obj_t *s_textarea;
static bool s_active;
static ui_mode_t s_mode;
static int s_selected;

static wifi_network_t s_networks[NETWORKS_MAX];
static int s_network_count;
static bool s_scanning;

static field_t s_field;
/* The line being edited, as UTF-8: the text area is rebuilt on every render,
 * so the text has to live outside it. */
static char s_edit_text[TEXT_MAX * 3 + 1];
static bool s_reveal;
/* The network chosen from the scan, waiting for its password. */
static char s_pending_ssid[33];
static char s_note_text[128];

static void render(void);

/* ------------------------------------------------------------------- draw -- */

static lv_obj_t *label(lv_obj_t *parent, const lv_font_t *font, lv_color_t color, const char *text)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, color, 0);
    lv_label_set_text(l, text);
    return l;
}

static void activate(void);

/*
 * A tap and the on-screen keyboard's own buttons both end up rebuilding the
 * screen, which deletes the very object whose event is running. LVGL does not
 * allow that, so the work is handed to a one-shot timer and happens just after
 * the event is over.
 */
typedef enum { SOON_NOTHING, SOON_ACTIVATE, SOON_SAVE, SOON_BACK } soon_t;
static soon_t s_soon;

static void save_edit(void);

static void do_soon(lv_timer_t *timer)
{
    soon_t what = s_soon;
    s_soon = SOON_NOTHING;
    if (what == SOON_ACTIVATE) {
        activate();
    } else if (what == SOON_SAVE) {
        save_edit();
        render();
    } else if (what == SOON_BACK) {
        s_mode = MODE_MENU;
        render();
    }
}

static void soon(soon_t what)
{
    s_soon = what;
    lv_timer_t *timer = lv_timer_create(do_soon, 1, NULL);
    lv_timer_set_repeat_count(timer, 1);
}

static void row_clicked(lv_event_t *e)
{
    s_selected = (int)(intptr_t)lv_event_get_user_data(e);
    soon(SOON_ACTIVATE);
}

/* One line: name on the left, value on the right, and a tap does what Enter does. */
static void row(int index, const char *name, const char *value)
{
    lv_obj_t *r = lv_obj_create(s_body);
    lv_obj_remove_style_all(r);
    lv_obj_set_size(r, lv_pct(100), LV_SIZE_CONTENT);
    lv_obj_set_style_pad_all(r, 8, 0);
    lv_obj_set_style_radius(r, 8, 0);
    lv_obj_set_style_bg_color(r, COLOR_ACCENT, 0);
    bool selected = index == s_selected;
    lv_obj_set_style_bg_opa(r, selected ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
    lv_obj_set_clickable(r, true);
    lv_obj_add_event_cb(r, row_clicked, LV_EVENT_CLICKED, (void *)(intptr_t)index);

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

/* --------------------------------------------------------------- scanning -- */

static void scan_task(void *arg)
{
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
    vTaskDelete(NULL);
}

/* Seconds long, so it runs on its own task and the screen says so meanwhile. */
static void scan_start(void)
{
    s_mode = MODE_SCAN;
    s_selected = 0;
    s_scanning = true;
    render();
    xTaskCreate(scan_task, "wifi_scan", 4096, NULL, 4, NULL);
}

/* ----------------------------------------------------------------- typing -- */

static void textarea_changed(lv_event_t *e)
{
    strlcpy(s_edit_text, lv_textarea_get_text(lv_event_get_target(e)), sizeof(s_edit_text));
}

static void keyboard_event(lv_event_t *e)
{
    /* The keyboard's own tick and cross: save, or go back. */
    soon(lv_event_get_code(e) == LV_EVENT_READY ? SOON_SAVE : SOON_BACK);
}

static void start_edit(field_t field)
{
    s_mode = MODE_EDIT;
    s_field = field;
    s_edit_text[0] = '\0';
    s_reveal = false;
}

/* ------------------------------------------------------------------ draw -- */

static void render(void)
{
    lv_obj_clean(s_body);
    s_textarea = NULL;
    lv_label_set_text(s_note, s_note_text);

    if (s_mode == MODE_MENU) {
        lv_label_set_text(s_title, "Settings");
        char ssid[33];
        wifi_stored_ssid(ssid, sizeof(ssid));
        row(ITEM_NETWORK, "WiFi network", ssid[0] ? ssid : "not set");
        row(ITEM_WIFI_PASSWORD, "WiFi password", "change");
        row(ITEM_ADMIN_PASSWORD, "Admin password", settings_admin_password_set() ? "set" : "not set");
        row(ITEM_CLOSE, "Close", "");

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
        lv_label_set_text(s_help, "Tap a line, or Up/Down and Enter   BOOT closes");
    } else if (s_mode == MODE_SCAN) {
        lv_label_set_text(s_title, "Choose a network");
        if (s_scanning) {
            info("Scanning...");
        } else {
            for (int i = 0; i < s_network_count; i++) {
                char value[24];
                snprintf(value, sizeof(value), "%d dBm%s", s_networks[i].rssi, s_networks[i].open ? ", open" : "");
                row(i, s_networks[i].ssid, value);
            }
            row(s_network_count, "Other network...", "");
            row(s_network_count + 1, "Back", "");
        }
        lv_label_set_text(s_help, "Tap a network, or Up/Down and Enter   Esc back");
    } else {
        const char *title = s_field == FIELD_SSID ? "Network name"
                            : s_field == FIELD_ADMIN_PASSWORD ? "Admin password"
                                                              : "WiFi password";
        lv_label_set_text(s_title, title);
        if (s_field == FIELD_WIFI_PASSWORD) {
            char text[64];
            snprintf(text, sizeof(text), "For %s", s_pending_ssid);
            info(text);
        }

        s_textarea = lv_textarea_create(s_body);
        lv_obj_set_width(s_textarea, lv_pct(100));
        lv_textarea_set_one_line(s_textarea, true);
        lv_textarea_set_max_length(s_textarea, TEXT_MAX);
        lv_textarea_set_password_mode(s_textarea, s_field != FIELD_SSID && !s_reveal);
        lv_textarea_set_text(s_textarea, s_edit_text);
        lv_obj_set_style_text_font(s_textarea, &lv_font_montserrat_20, 0);
        lv_obj_set_style_bg_color(s_textarea, COLOR_FIELD, 0);
        lv_obj_set_style_text_color(s_textarea, COLOR_TEXT, 0);
        lv_obj_add_event_cb(s_textarea, textarea_changed, LV_EVENT_VALUE_CHANGED, NULL);

        /* The on-screen keyboard: the only way in when no USB keyboard is attached. */
        lv_obj_t *keyboard = lv_keyboard_create(s_body);
        lv_obj_set_size(keyboard, lv_pct(100), KEYBOARD_HEIGHT);
        lv_keyboard_set_textarea(keyboard, s_textarea);
        lv_obj_add_event_cb(keyboard, keyboard_event, LV_EVENT_READY, NULL);
        lv_obj_add_event_cb(keyboard, keyboard_event, LV_EVENT_CANCEL, NULL);

        lv_label_set_text(s_help, s_field == FIELD_ADMIN_PASSWORD
                                      ? "At least 6 characters   Tick saves   Tab shows it"
                                      : "Tick saves   Cross goes back   Tab shows it");
    }
}

static void refresh_timer(lv_timer_t *timer)
{
    if (s_active && s_mode == MODE_MENU) {
        render(); /* the IP and connection state change under it */
    }
}

/* ------------------------------------------------------------- the screen -- */

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

static void close_locked(void)
{
    s_active = false;
    lv_screen_load(s_previous);
}

void settings_ui_close(void)
{
    if (!s_active || !bsp_display_lock(0)) {
        return;
    }
    close_locked();
    bsp_display_unlock();
}

/* --------------------------------------------------------------- choosing -- */

static void save_edit(void)
{
    switch (s_field) {
    case FIELD_SSID:
        if (s_edit_text[0] == '\0') {
            return;
        }
        strlcpy(s_pending_ssid, s_edit_text, sizeof(s_pending_ssid));
        start_edit(FIELD_WIFI_PASSWORD);
        return;
    case FIELD_WIFI_PASSWORD:
        if (wifi_apply(s_pending_ssid, s_edit_text) == ESP_OK) {
            snprintf(s_note_text, sizeof(s_note_text), "Saved. Connecting to %s...", s_pending_ssid);
        } else {
            strlcpy(s_note_text, "Could not save the network.", sizeof(s_note_text));
        }
        s_mode = MODE_MENU;
        s_selected = ITEM_NETWORK;
        return;
    case FIELD_ADMIN_PASSWORD:
        if (strlen(s_edit_text) < ADMIN_MIN) {
            strlcpy(s_note_text, "At least 6 characters.", sizeof(s_note_text));
            return;
        }
        strlcpy(s_note_text,
                settings_set_admin_password(s_edit_text) == ESP_OK ? "Admin password saved."
                                                                  : "Could not save the password.",
                sizeof(s_note_text));
        s_mode = MODE_MENU;
        s_selected = ITEM_ADMIN_PASSWORD;
        return;
    }
}

/* What Enter, or a tap on the selected line, does. Renders unless it scanned. */
static void activate(void)
{
    if (s_mode == MODE_MENU) {
        s_note_text[0] = '\0';
        if (s_selected == ITEM_NETWORK) {
            scan_start();
            return;
        }
        if (s_selected == ITEM_WIFI_PASSWORD) {
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
            return;
        }
    } else if (s_mode == MODE_SCAN) {
        if (s_scanning) {
            return;
        }
        if (s_selected == s_network_count + 1) {
            s_mode = MODE_MENU;
            s_selected = ITEM_NETWORK;
        } else if (s_selected == s_network_count) {
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
    }
    render();
}

/* ------------------------------------------------------------------ keys -- */

static void menu_key(const key_event_t *e)
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
        return;
    case KEY_ENTER:
        activate();
        return;
    default:
        return;
    }
    render();
}

static void scan_key(const key_event_t *e)
{
    if (s_scanning) {
        return;
    }
    int count = s_network_count + 2; /* "Other network..." and "Back" */
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
        activate();
        return;
    default:
        return;
    }
    render();
}

/* A USB keyboard types into the same text area the on-screen one does. */
static void edit_key(const key_event_t *e)
{
    if (s_textarea == NULL) {
        return;
    }
    switch (e->action) {
    case KEY_CHAR:
        lv_textarea_add_char(s_textarea, e->codepoint);
        return;
    case KEY_BACKSPACE:
        lv_textarea_delete_char(s_textarea);
        return;
    case KEY_DELETE:
        lv_textarea_delete_char_forward(s_textarea);
        return;
    case KEY_LEFT:
        lv_textarea_cursor_left(s_textarea);
        return;
    case KEY_RIGHT:
        lv_textarea_cursor_right(s_textarea);
        return;
    case KEY_HOME:
        lv_textarea_set_cursor_pos(s_textarea, 0);
        return;
    case KEY_END:
        lv_textarea_set_cursor_pos(s_textarea, LV_TEXTAREA_CURSOR_LAST);
        return;
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
            menu_key(event);
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
}
