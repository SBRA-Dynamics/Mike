#include "keyboard_input.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "mike_link.h"
#include "app_config.h"

static const char *TAG = "keyboard";

static key_handler_t s_handler;
static volatile bool s_attached;

bool keyboard_input_attached(void)
{
    return s_attached;
}

/* ------------------------------------------------------------ dead keys -- */

/* Accent keys on a Swedish layout do nothing until the next key. */
static uint32_t s_dead;

typedef struct {
    uint32_t accent;
    const char *base;  /* ASCII letters */
    const uint32_t *composed;
} compose_t;

static const uint32_t ACUTE[] = {0xE1, 0xE9, 0xED, 0xF3, 0xFA, 0xFD, 0xC1, 0xC9, 0xCD, 0xD3, 0xDA, 0xDD};
static const uint32_t GRAVE[] = {0xE0, 0xE8, 0xEC, 0xF2, 0xF9, 0xC0, 0xC8, 0xCC, 0xD2, 0xD9};
static const uint32_t DIAERESIS[] = {0xE4, 0xEB, 0xEF, 0xF6, 0xFC, 0xFF, 0xC4, 0xCB, 0xCF, 0xD6, 0xDC};
static const uint32_t CIRCUMFLEX[] = {0xE2, 0xEA, 0xEE, 0xF4, 0xFB, 0xC2, 0xCA, 0xCE, 0xD4, 0xDB};
static const uint32_t TILDE[] = {0xE3, 0xF1, 0xF5, 0xC3, 0xD1, 0xD5};

static const compose_t COMPOSE[] = {
    {0xB4, "aeiouyAEIOUY", ACUTE},
    {'`', "aeiouAEIOU", GRAVE},
    {0xA8, "aeiouyAEIOU", DIAERESIS},
    {'^', "aeiouAEIOU", CIRCUMFLEX},
    {'~', "anoANO", TILDE},
};

static void emit(key_action_t action, uint32_t codepoint)
{
    key_event_t event = {action, codepoint};
    if (action != KEY_CHAR) {
        s_dead = 0;
        s_handler(&event);
        return;
    }
    if (s_dead == 0) {
        s_handler(&event);
        return;
    }
    uint32_t accent = s_dead;
    s_dead = 0;
    if (codepoint != ' ') {
        for (size_t i = 0; i < sizeof(COMPOSE) / sizeof(COMPOSE[0]); i++) {
            const char *hit = COMPOSE[i].accent == accent && codepoint < 0x80 ? strchr(COMPOSE[i].base, (int)codepoint) : NULL;
            if (hit != NULL) {
                event.codepoint = COMPOSE[i].composed[hit - COMPOSE[i].base];
                s_handler(&event);
                return;
            }
        }
    }
    /* No composition: the accent itself, then the key (space gives the accent alone). */
    key_event_t spacing = {KEY_CHAR, accent};
    s_handler(&spacing);
    if (codepoint != ' ') {
        s_handler(&event);
    }
}

#if KEYBOARD_SERIAL_TEST
/* ============================================================== serial ===
 * A VT100 terminal on the USB serial console, for testing without a keyboard:
 *   python3 -m serial.tools.miniterm /dev/ttyACM1 115200
 */
#include "driver/usb_serial_jtag.h"

static int read_byte(TickType_t wait)
{
    uint8_t b;
    return usb_serial_jtag_read_bytes(&b, 1, wait) == 1 ? b : -1;
}

static void escape_sequence(void)
{
    int c = read_byte(pdMS_TO_TICKS(30));
    if (c < 0) {
        emit(KEY_ESCAPE, 0);
        return;
    }
    if (c != '[' && c != 'O') {
        emit(KEY_ESCAPE, 0);
        return;
    }
    char params[8] = {0};
    size_t n = 0;
    int final;
    while ((final = read_byte(pdMS_TO_TICKS(30))) >= 0 && final < 0x40) {
        if (n < sizeof(params) - 1) {
            params[n++] = (char)final;
        }
    }
    bool ctrl = strstr(params, ";5") != NULL;
    switch (final) {
    case 'A': emit(KEY_UP, 0); break;
    case 'B': emit(KEY_DOWN, 0); break;
    case 'C': emit(ctrl ? KEY_WORD_RIGHT : KEY_RIGHT, 0); break;
    case 'D': emit(ctrl ? KEY_WORD_LEFT : KEY_LEFT, 0); break;
    case 'H': emit(KEY_HOME, 0); break;
    case 'F': emit(KEY_END, 0); break;
    case '~':
        if (strcmp(params, "3") == 0) {
            emit(KEY_DELETE, 0);
        } else if (strcmp(params, "1") == 0 || strcmp(params, "7") == 0) {
            emit(KEY_HOME, 0);
        } else if (strcmp(params, "4") == 0 || strcmp(params, "8") == 0) {
            emit(KEY_END, 0);
        }
        break;
    default:
        break;
    }
}

static void serial_task(void *arg)
{
    usb_serial_jtag_driver_config_t cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    usb_serial_jtag_driver_install(&cfg);
    s_attached = true;
    ESP_LOGI(TAG, "serial test keyboard ready");

    uint32_t cp = 0;
    int pending = 0;
    bool after_cr = false;
    for (;;) {
        int c = read_byte(portMAX_DELAY);
        if (c < 0) {
            continue;
        }
        if (pending > 0) {
            if ((c & 0xC0) == 0x80) {
                cp = (cp << 6) | (c & 0x3F);
                if (--pending == 0) {
                    emit(KEY_CHAR, cp);
                }
                continue;
            }
            pending = 0;
        }
        bool cr = c == '\r';
        if (c == '\n' && after_cr) {
            after_cr = false;
            continue;
        }
        after_cr = cr;
        switch (c) {
        case '\r':
        case '\n': emit(KEY_ENTER, 0); break;
        case 0x7F:
        case 0x08: emit(KEY_BACKSPACE, 0); break;
        case 0x1B: escape_sequence(); break;
        case 0x03: emit(KEY_INTERRUPT, 0); break;
        case 0x15: emit(KEY_KILL_START, 0); break;
        case 0x0B: emit(KEY_KILL_END, 0); break;
        case 0x17: emit(KEY_DELETE_WORD, 0); break;
        case 0x01: emit(KEY_HOME, 0); break;
        case 0x05: emit(KEY_END, 0); break;
        default:
            if (c >= 0xF0) {
                cp = c & 0x07;
                pending = 3;
            } else if (c >= 0xE0) {
                cp = c & 0x0F;
                pending = 2;
            } else if (c >= 0xC0) {
                cp = c & 0x1F;
                pending = 1;
            } else if (c >= 0x20 && c < 0x7F) {
                emit(KEY_CHAR, c);
            }
            break;
        }
    }
}

void keyboard_input_start(key_handler_t handler)
{
    s_handler = handler;
    xTaskCreatePinnedToCore(serial_task, "kbd_serial", 6144, NULL, 7, NULL, 1);
}

#else
/* ================================================================= USB ===
 * A USB keyboard on the board's USB-C port. The port then runs as a USB host,
 * which takes it away from the serial console and from flashing: hold BOOT while
 * resetting to flash again.
 */
#include "usb/hid_host.h"
#include "usb/hid_usage_keyboard.h"
#include "usb/usb_host.h"

#define REPEAT_DELAY_MS 400
#define REPEAT_RATE_MS 33

#define MOD_LCTRL 0x01
#define MOD_LSHIFT 0x02
#define MOD_LALT 0x04
#define MOD_RCTRL 0x10
#define MOD_RSHIFT 0x20
#define MOD_RALT 0x40

typedef enum { ITEM_DEVICE, ITEM_REPORT, ITEM_ERROR } item_kind_t;

typedef struct {
    item_kind_t kind;
    hid_host_device_handle_t device;
    hid_host_driver_event_t event;
    uint8_t report[16];
    uint8_t len;
} item_t;

static QueueHandle_t s_queue;
static bool s_caps;

/* Swedish layout for the keys that are not letters: unshifted, shifted, AltGr.
 * A value with DEAD set is an accent that waits for the next key. */
#define DEAD 0x80000000u

typedef struct {
    uint8_t usage;
    uint32_t plain, shift, altgr;
} keymap_t;

static const keymap_t KEYMAP[] = {
    {0x1E, '1', '!', 0},       {0x1F, '2', '"', '@'},   {0x20, '3', '#', 0xA3},     {0x21, '4', 0xA4, '$'},
    {0x22, '5', '%', 0x20AC},  {0x23, '6', '&', 0},     {0x24, '7', '/', '{'},      {0x25, '8', '(', '['},
    {0x26, '9', ')', ']'},     {0x27, '0', '=', '}'},   {0x2C, ' ', ' ', ' '},      {0x2D, '+', '?', '\\'},
    {0x2E, DEAD | 0xB4, DEAD | '`', 0},                 {0x2F, 0xE5, 0xC5, 0},      {0x30, DEAD | 0xA8, DEAD | '^', DEAD | '~'},
    {0x31, '\'', '*', 0},      {0x32, '\'', '*', 0},    {0x33, 0xF6, 0xD6, 0},      {0x34, 0xE4, 0xC4, 0},
    {0x35, 0xA7, 0xBD, 0},     {0x36, ',', ';', 0},     {0x37, '.', ':', 0},        {0x38, '-', '_', 0},
    {0x64, '<', '>', '|'},     {0x54, '/', '/', 0},     {0x55, '*', '*', 0},        {0x56, '-', '-', 0},
    {0x57, '+', '+', 0},       {0x59, '1', '1', 0},     {0x5A, '2', '2', 0},        {0x5B, '3', '3', 0},
    {0x5C, '4', '4', 0},       {0x5D, '5', '5', 0},     {0x5E, '6', '6', 0},        {0x5F, '7', '7', 0},
    {0x60, '8', '8', 0},       {0x61, '9', '9', 0},     {0x62, '0', '0', 0},        {0x63, ',', ',', 0},
};

/* Is this key worth repeating while held? */
static bool repeats(uint8_t usage)
{
    return usage != HID_KEY_ENTER && usage != 0x58 && usage != HID_KEY_ESC && usage != 0x39;
}

/* One key press, translated and handed on. */
static void press(uint8_t mods, uint8_t usage)
{
    bool shift = mods & (MOD_LSHIFT | MOD_RSHIFT);
    bool altgr = (mods & MOD_RALT) || ((mods & (MOD_LCTRL | MOD_RCTRL)) && (mods & MOD_LALT));
    bool ctrl = (mods & (MOD_LCTRL | MOD_RCTRL)) && !altgr;

    switch (usage) {
    case HID_KEY_ENTER:
    case 0x58: emit(KEY_ENTER, 0); return;
    case HID_KEY_ESC: emit(KEY_ESCAPE, 0); return;
    case HID_KEY_DEL: emit(ctrl ? KEY_DELETE_WORD : KEY_BACKSPACE, 0); return;
    case 0x4C: emit(KEY_DELETE, 0); return;
    case 0x4F: emit(ctrl ? KEY_WORD_RIGHT : KEY_RIGHT, 0); return;
    case 0x50: emit(ctrl ? KEY_WORD_LEFT : KEY_LEFT, 0); return;
    case 0x51: emit(KEY_DOWN, 0); return;
    case 0x52: emit(KEY_UP, 0); return;
    case 0x4A: emit(KEY_HOME, 0); return;
    case 0x4D: emit(KEY_END, 0); return;
    case 0x39: s_caps = !s_caps; return;
    default: break;
    }

    if (usage >= HID_KEY_A && usage <= HID_KEY_Z) {
        char letter = 'a' + (usage - HID_KEY_A);
        if (ctrl) {
            switch (letter) {
            case 'c': emit(KEY_INTERRUPT, 0); break;
            case 'u': emit(KEY_KILL_START, 0); break;
            case 'k': emit(KEY_KILL_END, 0); break;
            case 'w': emit(KEY_DELETE_WORD, 0); break;
            case 'a': emit(KEY_HOME, 0); break;
            case 'e': emit(KEY_END, 0); break;
            default: break;
            }
            return;
        }
        if (altgr) {
            return;
        }
        emit(KEY_CHAR, (shift != s_caps) ? (uint32_t)(letter - 'a' + 'A') : (uint32_t)letter);
        return;
    }

    if (ctrl) {
        return;
    }
    for (size_t i = 0; i < sizeof(KEYMAP) / sizeof(KEYMAP[0]); i++) {
        if (KEYMAP[i].usage != usage) {
            continue;
        }
        uint32_t v = altgr ? KEYMAP[i].altgr : (shift ? KEYMAP[i].shift : KEYMAP[i].plain);
        /* Caps Lock reaches the Swedish letters too. */
        if (s_caps && !altgr && (usage == 0x2F || usage == 0x33 || usage == 0x34)) {
            v = shift ? KEYMAP[i].plain : KEYMAP[i].shift;
        }
        if (v == 0) {
            return;
        }
        if (v & DEAD) {
            uint32_t accent = v & ~DEAD;
            if (s_dead) {
                /* The same accent twice gives it once; a different one starts over. */
                uint32_t previous = s_dead;
                emit(KEY_CHAR, ' ');
                if (accent != previous) {
                    s_dead = accent;
                }
            } else {
                s_dead = accent;
            }
            return;
        }
        emit(KEY_CHAR, v);
        return;
    }
}

static void interface_callback(hid_host_device_handle_t device, const hid_host_interface_event_t event, void *arg)
{
    switch (event) {
    case HID_HOST_INTERFACE_EVENT_INPUT_REPORT: {
        item_t item = {.kind = ITEM_REPORT};
        size_t len = 0;
        uint8_t data[64];
        if (hid_host_device_get_raw_input_report_data(device, data, sizeof(data), &len) == ESP_OK) {
            item.len = len > sizeof(item.report) ? sizeof(item.report) : len;
            memcpy(item.report, data, item.len);
            xQueueSend(s_queue, &item, 0);
        }
        break;
    }
    case HID_HOST_INTERFACE_EVENT_DISCONNECTED: {
        ESP_LOGI(TAG, "keyboard disconnected");
        s_attached = false;
        hid_host_device_close(device);
        /* An empty report releases whatever was held, so nothing keeps repeating. */
        item_t released = {.kind = ITEM_REPORT, .len = 8};
        xQueueSend(s_queue, &released, 0);
        break;
    }
    case HID_HOST_INTERFACE_EVENT_TRANSFER_ERROR: {
        item_t error = {.kind = ITEM_ERROR};
        xQueueSend(s_queue, &error, 0);
        break;
    }
    default:
        break;
    }
}

static void device_callback(hid_host_device_handle_t device, const hid_host_driver_event_t event, void *arg)
{
    item_t item = {.kind = ITEM_DEVICE, .device = device, .event = event};
    xQueueSend(s_queue, &item, 0);
}

static void open_device(hid_host_device_handle_t device)
{
    hid_host_dev_params_t params;
    if (hid_host_device_get_params(device, &params) != ESP_OK) {
        return;
    }
    if (KEYBOARD_DEBUG) {
        mike_link_log("usb: interface %u subclass %u protocol %u", params.iface_num, params.sub_class, params.proto);
    }
    if (params.sub_class != HID_SUBCLASS_BOOT_INTERFACE || params.proto != HID_PROTOCOL_KEYBOARD) {
        /* Mice and media-key interfaces of the same keyboard are left alone. */
        return;
    }
    const hid_host_device_config_t cfg = {.callback = interface_callback};
    if (hid_host_device_open(device, &cfg) != ESP_OK) {
        return;
    }
    esp_err_t proto = hid_class_request_set_protocol(device, HID_REPORT_PROTOCOL_BOOT);
    esp_err_t idle = hid_class_request_set_idle(device, 0, 0);
    esp_err_t started = hid_host_device_start(device);
    if (KEYBOARD_DEBUG) {
        mike_link_log("usb: keyboard interface %u set_protocol %s set_idle %s start %s", params.iface_num,
                      esp_err_to_name(proto), esp_err_to_name(idle), esp_err_to_name(started));
    }
    if (started == ESP_OK) {
        s_attached = true;
        ESP_LOGI(TAG, "keyboard connected");
    }
}

static void usb_lib_task(void *arg)
{
    const usb_host_config_t cfg = {.skip_phy_setup = false, .intr_flags = ESP_INTR_FLAG_LEVEL1};
    ESP_ERROR_CHECK(usb_host_install(&cfg));
    xTaskNotifyGive((TaskHandle_t)arg);
    for (;;) {
        uint32_t flags;
        usb_host_lib_handle_events(portMAX_DELAY, &flags);
        if (flags & USB_HOST_LIB_EVENT_FLAGS_NO_CLIENTS) {
            usb_host_device_free_all();
        }
    }
}

static void keyboard_task(void *arg)
{
    xTaskCreatePinnedToCore(usb_lib_task, "usb_lib", 4096, xTaskGetCurrentTaskHandle(), 8, NULL, 0);
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(2000));

    const hid_host_driver_config_t hid_cfg = {
        .create_background_task = true,
        .task_priority = 8,
        .stack_size = 4096,
        .core_id = 0,
        .callback = device_callback,
    };
    ESP_ERROR_CHECK(hid_host_install(&hid_cfg));
    ESP_LOGI(TAG, "waiting for a USB keyboard");

    uint8_t held[6] = {0};
    uint8_t mods = 0;
    uint8_t repeat_key = 0;
    TickType_t repeat_at = 0;

    for (;;) {
        TickType_t wait = portMAX_DELAY;
        if (repeat_key) {
            TickType_t now = xTaskGetTickCount();
            wait = repeat_at > now ? repeat_at - now : 0;
        }
        item_t item;
        if (xQueueReceive(s_queue, &item, wait) != pdTRUE) {
            if (repeat_key) {
                press(mods, repeat_key);
                repeat_at = xTaskGetTickCount() + pdMS_TO_TICKS(REPEAT_RATE_MS);
            }
            continue;
        }

        if (item.kind == ITEM_ERROR) {
            if (KEYBOARD_DEBUG) {
                mike_link_log("usb: transfer error");
            }
            continue;
        }
        if (item.kind == ITEM_DEVICE) {
            if (item.event == HID_HOST_DRIVER_EVENT_CONNECTED) {
                open_device(item.device);
            }
            continue;
        }

        if (KEYBOARD_DEBUG) {
            char hex[3 * sizeof(item.report) + 1] = "";
            for (int i = 0; i < item.len; i++) {
                sprintf(hex + 3 * i, "%02x ", item.report[i]);
            }
            mike_link_log("usb: report %u: %s", item.len, hex);
        }
        if (item.len < 8) {
            continue;
        }
        const uint8_t *report = item.report;
        mods = report[0];
        if (report[2] == HID_KEY_ROLLOVER) {
            continue; /* too many keys at once: keep the previous state */
        }
        for (int i = 2; i < 8; i++) {
            uint8_t usage = report[i];
            if (usage <= HID_KEY_ERROR_UNDEFINED || memchr(held, usage, sizeof(held)) != NULL) {
                continue;
            }
            press(mods, usage);
            if (repeats(usage)) {
                repeat_key = usage;
                repeat_at = xTaskGetTickCount() + pdMS_TO_TICKS(REPEAT_DELAY_MS);
            }
        }
        if (repeat_key && memchr(report + 2, repeat_key, 6) == NULL) {
            repeat_key = 0;
        }
        memcpy(held, report + 2, sizeof(held));
    }
}

void keyboard_input_start(key_handler_t handler)
{
    s_handler = handler;
    s_queue = xQueueCreate(32, sizeof(item_t));
    xTaskCreatePinnedToCore(keyboard_task, "keyboard", 6144, NULL, 7, NULL, 1);
}
#endif
