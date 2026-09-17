#include "mike_link.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_tls.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "mbedtls/base64.h"
#include "app_config.h"

static const char *TAG = "mike_link";

#define PROTOCOL_VERSION 1
#define OUTBOX_MAX 16
#define RX_MAX 8192
/* Mike pings every 20 s; three missed pings means the socket is dead. */
#define SILENCE_TIMEOUT_MS 65000
#define POLL_MS 20

typedef enum { MSG_DRAFT, MSG_OTHER, MSG_LOG } msg_kind_t;

typedef struct {
    msg_kind_t kind;
    char *json;
} outgoing_t;

static SemaphoreHandle_t s_lock;
static outgoing_t s_outbox[OUTBOX_MAX];
static int s_outbox_len;
/* The newest draft, re-sent after every (re)connect so the lens shows the line again. */
static char *s_last_draft;
static TaskHandle_t s_task;
static volatile bool s_connected;

bool mike_link_enabled(void)
{
    return MIKE_HOST[0] != '\0' && MIKE_TOKEN[0] != '\0';
}

bool mike_link_connected(void)
{
    return s_connected;
}

/* ------------------------------------------------------------ JSON text -- */

typedef struct {
    char *buf;
    size_t len;
    size_t cap;
} sbuf_t;

static void sb_put(sbuf_t *sb, const char *s, size_t n)
{
    if (sb->len + n + 1 > sb->cap) {
        size_t cap = (sb->len + n + 1) * 2;
        char *grown = heap_caps_realloc(sb->buf, cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (grown == NULL) {
            return;
        }
        sb->buf = grown;
        sb->cap = cap;
    }
    memcpy(sb->buf + sb->len, s, n);
    sb->len += n;
    sb->buf[sb->len] = '\0';
}

static void sb_str(sbuf_t *sb, const char *s)
{
    sb_put(sb, s, strlen(s));
}

/* Code points as a JSON string body: UTF-8, with quotes, backslashes and controls escaped. */
static void sb_json_text(sbuf_t *sb, const uint32_t *text, size_t len)
{
    char tmp[8];
    for (size_t i = 0; i < len; i++) {
        uint32_t c = text[i];
        if (c == '"' || c == '\\') {
            tmp[0] = '\\';
            tmp[1] = (char)c;
            sb_put(sb, tmp, 2);
        } else if (c < 0x20) {
            sb_put(sb, tmp, snprintf(tmp, sizeof(tmp), "\\u%04x", (unsigned)c));
        } else if (c < 0x80) {
            tmp[0] = (char)c;
            sb_put(sb, tmp, 1);
        } else if (c < 0x800) {
            tmp[0] = 0xC0 | (c >> 6);
            tmp[1] = 0x80 | (c & 0x3F);
            sb_put(sb, tmp, 2);
        } else if (c < 0x10000) {
            tmp[0] = 0xE0 | (c >> 12);
            tmp[1] = 0x80 | ((c >> 6) & 0x3F);
            tmp[2] = 0x80 | (c & 0x3F);
            sb_put(sb, tmp, 3);
        } else {
            tmp[0] = 0xF0 | (c >> 18);
            tmp[1] = 0x80 | ((c >> 12) & 0x3F);
            tmp[2] = 0x80 | ((c >> 6) & 0x3F);
            tmp[3] = 0x80 | (c & 0x3F);
            sb_put(sb, tmp, 4);
        }
    }
}

/* ---------------------------------------------------------------- outbox -- */

static void enqueue(msg_kind_t kind, char *json)
{
    if (json == NULL || !mike_link_enabled()) {
        free(json);
        return;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (kind == MSG_DRAFT) {
        free(s_last_draft);
        s_last_draft = strdup(json);
    }
    if (kind == MSG_DRAFT && s_outbox_len > 0 && s_outbox[s_outbox_len - 1].kind == MSG_DRAFT) {
        /* Only the newest line matters: replace the draft still waiting. */
        free(s_outbox[s_outbox_len - 1].json);
        s_outbox[s_outbox_len - 1].json = json;
    } else if (s_outbox_len < OUTBOX_MAX) {
        s_outbox[s_outbox_len++] = (outgoing_t){kind, json};
    } else {
        ESP_LOGW(TAG, "outbox full, dropping message");
        free(json);
    }
    xSemaphoreGive(s_lock);
    if (s_task != NULL) {
        xTaskNotifyGive(s_task);
    }
}

void mike_link_draft(const uint32_t *text, size_t len, size_t cursor)
{
    sbuf_t sb = {0};
    sb_str(&sb, "{\"type\":\"draft\",\"text\":\"");
    sb_json_text(&sb, text, len);
    char tail[32];
    snprintf(tail, sizeof(tail), "\",\"cursor\":%u}", (unsigned)cursor);
    sb_str(&sb, tail);
    enqueue(MSG_DRAFT, sb.buf);
}

void mike_link_say(const uint32_t *text, size_t len)
{
    sbuf_t sb = {0};
    sb_str(&sb, "{\"type\":\"say\",\"origin\":\"typed\",\"text\":\"");
    sb_json_text(&sb, text, len);
    sb_str(&sb, "\"}");
    /* The server empties the box when the line arrives; so does our copy. */
    xSemaphoreTake(s_lock, portMAX_DELAY);
    free(s_last_draft);
    s_last_draft = NULL;
    xSemaphoreGive(s_lock);
    enqueue(MSG_OTHER, sb.buf);
}

void mike_link_interrupt(void)
{
    enqueue(MSG_OTHER, strdup("{\"type\":\"interrupt\"}"));
}

void mike_link_log(const char *fmt, ...)
{
    char text[256];
    va_list args;
    va_start(args, fmt);
    vsnprintf(text, sizeof(text), fmt, args);
    va_end(args);
    ESP_LOGI(TAG, "%s", text);

    uint32_t cps[sizeof(text)];
    size_t n = 0;
    for (const char *p = text; *p && n < sizeof(cps); p++) {
        cps[n++] = (uint8_t)*p;
    }
    sbuf_t sb = {0};
    sb_str(&sb, "{\"type\":\"control\",\"action\":\"clientLog\",\"args\":{\"text\":\"");
    sb_json_text(&sb, cps, n);
    sb_str(&sb, "\"}}");
    enqueue(MSG_LOG, sb.buf);
}

/* ------------------------------------------------------------- WebSocket -- */

static bool tls_write_all(esp_tls_t *tls, const uint8_t *data, size_t len)
{
    while (len > 0) {
        ssize_t n = esp_tls_conn_write(tls, data, len);
        if (n < 0) {
            if (n == ESP_TLS_ERR_SSL_WANT_READ || n == ESP_TLS_ERR_SSL_WANT_WRITE) {
                continue;
            }
            return false;
        }
        data += n;
        len -= n;
    }
    return true;
}

/* One masked client frame, written in a single call so it leaves as one TLS record. */
static bool ws_send(esp_tls_t *tls, uint8_t opcode, const uint8_t *payload, size_t len)
{
    size_t header = 2 + (len < 126 ? 0 : (len < 65536 ? 2 : 8)) + 4;
    uint8_t *frame = heap_caps_malloc(header + len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (frame == NULL) {
        return false;
    }
    size_t i = 0;
    frame[i++] = 0x80 | opcode;
    if (len < 126) {
        frame[i++] = 0x80 | len;
    } else if (len < 65536) {
        frame[i++] = 0x80 | 126;
        frame[i++] = len >> 8;
        frame[i++] = len & 0xFF;
    } else {
        frame[i++] = 0x80 | 127;
        for (int b = 7; b >= 0; b--) {
            frame[i++] = ((uint64_t)len >> (8 * b)) & 0xFF;
        }
    }
    uint32_t mask = esp_random();
    memcpy(frame + i, &mask, 4);
    const uint8_t *key = frame + i;
    i += 4;
    for (size_t j = 0; j < len; j++) {
        frame[i + j] = payload[j] ^ key[j % 4];
    }
    bool ok = tls_write_all(tls, frame, header + len);
    free(frame);
    return ok;
}

static bool ws_send_text(esp_tls_t *tls, const char *text)
{
    return ws_send(tls, 0x1, (const uint8_t *)text, strlen(text));
}

static bool ws_handshake(esp_tls_t *tls)
{
    uint8_t nonce[16];
    esp_fill_random(nonce, sizeof(nonce));
    unsigned char key[32];
    size_t key_len = 0;
    mbedtls_base64_encode(key, sizeof(key), &key_len, nonce, sizeof(nonce));

    char req[256];
    int n = snprintf(req, sizeof(req),
                     "GET /ws HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                     "Sec-WebSocket-Key: %.*s\r\nSec-WebSocket-Version: 13\r\n\r\n",
                     MIKE_TLS_NAME[0] ? MIKE_TLS_NAME : MIKE_HOST, MIKE_PORT, (int)key_len, key);
    if (!tls_write_all(tls, (const uint8_t *)req, n)) {
        return false;
    }

    /* Read the response head a byte at a time: nothing after it may be consumed. */
    char head[512];
    size_t len = 0;
    while (len < sizeof(head) - 1) {
        ssize_t r = esp_tls_conn_read(tls, head + len, 1);
        if (r <= 0) {
            if (r == ESP_TLS_ERR_SSL_WANT_READ || r == ESP_TLS_ERR_SSL_WANT_WRITE) {
                continue;
            }
            return false;
        }
        len++;
        head[len] = '\0';
        if (len >= 4 && memcmp(head + len - 4, "\r\n\r\n", 4) == 0) {
            break;
        }
    }
    if (strncmp(head, "HTTP/1.1 101", 12) != 0) {
        ESP_LOGE(TAG, "upgrade refused: %.60s", head);
        return false;
    }
    return true;
}

static void on_text(const char *text, size_t len)
{
    /* The server sends a keyboard only `ready` and `error`. */
    if (memmem(text, len, "\"type\":\"ready\"", 14) != NULL) {
        s_connected = true;
        ESP_LOGI(TAG, "ready: %.*s", (int)(len > 160 ? 160 : len), text);
    } else if (memmem(text, len, "\"type\":\"error\"", 14) != NULL) {
        ESP_LOGW(TAG, "server: %.*s", (int)(len > 200 ? 200 : len), text);
    }
}

typedef struct {
    uint8_t buf[RX_MAX];
    size_t len;
} rx_t;

/* Parses complete frames at the front of rx. Returns false when the socket must close. */
static bool ws_process(esp_tls_t *tls, rx_t *rx)
{
    for (;;) {
        if (rx->len < 2) {
            return true;
        }
        uint8_t opcode = rx->buf[0] & 0x0F;
        bool masked = rx->buf[1] & 0x80;
        uint64_t plen = rx->buf[1] & 0x7F;
        size_t pos = 2;
        if (plen == 126) {
            if (rx->len < 4) {
                return true;
            }
            plen = ((uint64_t)rx->buf[2] << 8) | rx->buf[3];
            pos = 4;
        } else if (plen == 127) {
            if (rx->len < 10) {
                return true;
            }
            plen = 0;
            for (int b = 0; b < 8; b++) {
                plen = (plen << 8) | rx->buf[2 + b];
            }
            pos = 10;
        }
        uint8_t mask[4] = {0};
        if (masked) {
            if (rx->len < pos + 4) {
                return true;
            }
            memcpy(mask, rx->buf + pos, 4);
            pos += 4;
        }
        if (pos + plen > sizeof(rx->buf)) {
            ESP_LOGE(TAG, "frame too large (%u bytes)", (unsigned)plen);
            return false;
        }
        if (rx->len < pos + plen) {
            return true;
        }
        uint8_t *payload = rx->buf + pos;
        if (masked) {
            for (size_t i = 0; i < plen; i++) {
                payload[i] ^= mask[i % 4];
            }
        }

        switch (opcode) {
        case 0x1:
            on_text((const char *)payload, plen);
            break;
        case 0x8:
            ESP_LOGW(TAG, "server closed the socket");
            return false;
        case 0x9:
            if (!ws_send(tls, 0xA, payload, plen)) {
                return false;
            }
            break;
        default:
            break;
        }

        size_t used = pos + plen;
        memmove(rx->buf, rx->buf + used, rx->len - used);
        rx->len -= used;
    }
}

static esp_tls_t *connect_tls(void)
{
    esp_tls_cfg_t cfg = {
        .timeout_ms = 10000,
        .is_plain_tcp = MIKE_TLS_NAME[0] == '\0',
        .crt_bundle_attach = MIKE_TLS_NAME[0] ? esp_crt_bundle_attach : NULL,
        /* Connected by LAN address, verified against the certificate's own name. */
        .common_name = MIKE_TLS_NAME[0] ? MIKE_TLS_NAME : NULL,
    };
    esp_tls_t *tls = esp_tls_init();
    if (tls == NULL) {
        return NULL;
    }
    if (esp_tls_conn_new_sync(MIKE_HOST, strlen(MIKE_HOST), MIKE_PORT, &cfg, tls) != 1) {
        esp_tls_conn_destroy(tls);
        return NULL;
    }
    int fd;
    if (esp_tls_get_conn_sockfd(tls, &fd) == ESP_OK) {
        /* Keystrokes are tiny and must not wait for the previous one's ACK. */
        int one = 1;
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    }
    return tls;
}

static bool flush_outbox(esp_tls_t *tls)
{
    for (;;) {
        xSemaphoreTake(s_lock, portMAX_DELAY);
        if (s_outbox_len == 0) {
            xSemaphoreGive(s_lock);
            return true;
        }
        char *json = s_outbox[0].json;
        memmove(s_outbox, s_outbox + 1, (s_outbox_len - 1) * sizeof(outgoing_t));
        s_outbox_len--;
        xSemaphoreGive(s_lock);

        bool ok = ws_send_text(tls, json);
        free(json);
        if (!ok) {
            return false;
        }
    }
}

/* Drops what was typed while offline; log lines are kept, since they are
 * usually about why the board was offline. */
static void clear_outbox(void)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    int kept = 0;
    for (int i = 0; i < s_outbox_len; i++) {
        if (s_outbox[i].kind == MSG_LOG) {
            s_outbox[kept++] = s_outbox[i];
        } else {
            free(s_outbox[i].json);
        }
    }
    s_outbox_len = kept;
    xSemaphoreGive(s_lock);
}

static void link_task(void *arg)
{
    rx_t *rx = heap_caps_malloc(sizeof(rx_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    int backoff_ms = 1000;

    for (;;) {
        esp_tls_t *tls = connect_tls();
        if (tls == NULL || !ws_handshake(tls)) {
            ESP_LOGW(TAG, "cannot reach Mike at %s:%d, retrying in %d ms", MIKE_HOST, MIKE_PORT, backoff_ms);
            if (tls != NULL) {
                esp_tls_conn_destroy(tls);
            }
            vTaskDelay(pdMS_TO_TICKS(backoff_ms));
            backoff_ms = backoff_ms < 30000 ? backoff_ms * 2 : 30000;
            continue;
        }

        char hello[256];
        snprintf(hello, sizeof(hello), "{\"type\":\"hello\",\"protocol\":%d,\"token\":\"%s\",\"role\":\"keyboard\"}",
                 PROTOCOL_VERSION, MIKE_TOKEN);
        bool ok = ws_send_text(tls, hello);

        /* Whatever was typed while offline is stale; only the current line is worth sending. */
        clear_outbox();
        xSemaphoreTake(s_lock, portMAX_DELAY);
        char *draft = s_last_draft ? strdup(s_last_draft) : NULL;
        xSemaphoreGive(s_lock);
        if (ok && draft != NULL) {
            ok = ws_send_text(tls, draft);
        }
        free(draft);

        int fd = -1;
        esp_tls_get_conn_sockfd(tls, &fd);
        rx->len = 0;
        TickType_t heard = xTaskGetTickCount();
        backoff_ms = 1000;
        ESP_LOGI(TAG, "connected to Mike at %s:%d", MIKE_HOST, MIKE_PORT);

        while (ok) {
            /* Woken at once by a keystroke; otherwise a short nap between socket checks. */
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(POLL_MS));
            if (!flush_outbox(tls)) {
                break;
            }

            fd_set readable;
            FD_ZERO(&readable);
            FD_SET(fd, &readable);
            struct timeval now = {0, 0};
            if (esp_tls_get_bytes_avail(tls) > 0 || select(fd + 1, &readable, NULL, NULL, &now) > 0) {
                ssize_t n = esp_tls_conn_read(tls, rx->buf + rx->len, sizeof(rx->buf) - rx->len);
                if (n > 0) {
                    rx->len += n;
                    heard = xTaskGetTickCount();
                    ok = ws_process(tls, rx);
                } else if (n != ESP_TLS_ERR_SSL_WANT_READ && n != ESP_TLS_ERR_SSL_WANT_WRITE) {
                    break;
                }
            }
            if (pdTICKS_TO_MS(xTaskGetTickCount() - heard) > SILENCE_TIMEOUT_MS) {
                ESP_LOGW(TAG, "no ping from Mike for %d s", SILENCE_TIMEOUT_MS / 1000);
                break;
            }
        }

        s_connected = false;
        esp_tls_conn_destroy(tls);
        ESP_LOGW(TAG, "disconnected from Mike");
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void mike_link_start(void)
{
    if (!mike_link_enabled()) {
        ESP_LOGI(TAG, "MIKE_HOST or MIKE_TOKEN not set, keyboard link disabled");
        return;
    }
    s_lock = xSemaphoreCreateMutex();
    xTaskCreatePinnedToCore(link_task, "mike_link", 8192, NULL, 6, &s_task, 1);
}
