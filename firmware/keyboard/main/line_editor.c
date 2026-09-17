#include "line_editor.h"

#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "mike_link.h"
#include "nvs.h"

static const char *TAG = "line_editor";

/* Mike accepts drafts up to 2000 code points. */
#define LINE_MAX 2000
#define HISTORY_MAX 50
#define HISTORY_BLOB_MAX 8000
#define NVS_NAMESPACE "keyboard"

typedef struct {
    uint32_t *text;
    size_t len;
} entry_t;

static uint32_t s_line[LINE_MAX];
static size_t s_len;
static size_t s_cursor;

/* Oldest first. */
static entry_t s_history[HISTORY_MAX];
static int s_history_len;
/* -1 while editing a new line; otherwise the history entry shown. */
static int s_browse = -1;
/* The line that was being typed when browsing started, given back by Down. */
static entry_t s_stash;

/* ----------------------------------------------------------------- UTF-8 -- */

static size_t encode_utf8(const uint32_t *text, size_t len, char *out, size_t cap)
{
    size_t n = 0;
    for (size_t i = 0; i < len; i++) {
        uint32_t c = text[i];
        size_t need = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        if (n + need >= cap) {
            break;
        }
        if (need == 1) {
            out[n++] = (char)c;
        } else if (need == 2) {
            out[n++] = 0xC0 | (c >> 6);
            out[n++] = 0x80 | (c & 0x3F);
        } else if (need == 3) {
            out[n++] = 0xE0 | (c >> 12);
            out[n++] = 0x80 | ((c >> 6) & 0x3F);
            out[n++] = 0x80 | (c & 0x3F);
        } else {
            out[n++] = 0xF0 | (c >> 18);
            out[n++] = 0x80 | ((c >> 12) & 0x3F);
            out[n++] = 0x80 | ((c >> 6) & 0x3F);
            out[n++] = 0x80 | (c & 0x3F);
        }
    }
    out[n] = '\0';
    return n;
}

static size_t decode_utf8(const char *s, uint32_t *out, size_t cap)
{
    size_t n = 0;
    while (*s && n < cap) {
        uint8_t b = (uint8_t)*s++;
        uint32_t c = b;
        int more = b >= 0xF0 ? 3 : b >= 0xE0 ? 2 : b >= 0xC0 ? 1 : 0;
        c = more == 3 ? b & 0x07 : more == 2 ? b & 0x0F : more == 1 ? b & 0x1F : b;
        while (more-- > 0 && (*s & 0xC0) == 0x80) {
            c = (c << 6) | (*s++ & 0x3F);
        }
        out[n++] = c;
    }
    return n;
}

/* --------------------------------------------------------------- history -- */

static entry_t copy_entry(const uint32_t *text, size_t len)
{
    entry_t e = {heap_caps_malloc((len ? len : 1) * sizeof(uint32_t), MALLOC_CAP_SPIRAM), len};
    if (e.text == NULL) {
        e.len = 0;
        return e;
    }
    memcpy(e.text, text, len * sizeof(uint32_t));
    return e;
}

static void history_save(void)
{
    char *blob = heap_caps_malloc(HISTORY_BLOB_MAX, MALLOC_CAP_SPIRAM);
    if (blob == NULL) {
        return;
    }
    /* Counted newest first, so a full blob keeps the recent lines; NUL separated. */
    size_t used = 0;
    int first = s_history_len;
    for (int i = s_history_len - 1; i >= 0; i--) {
        size_t n = 0;
        for (size_t j = 0; j < s_history[i].len; j++) {
            uint32_t c = s_history[i].text[j];
            n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        }
        if (used + n + 1 > HISTORY_BLOB_MAX) {
            break;
        }
        used += n + 1;
        first = i;
    }
    size_t pos = 0;
    for (int i = first; i < s_history_len; i++) {
        pos += encode_utf8(s_history[i].text, s_history[i].len, blob + pos, HISTORY_BLOB_MAX - pos) + 1;
    }

    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_set_blob(nvs, "history", blob, pos);
        nvs_commit(nvs);
        nvs_close(nvs);
    }
    free(blob);
}

static void history_add(const uint32_t *text, size_t len)
{
    const entry_t *last = s_history_len ? &s_history[s_history_len - 1] : NULL;
    if (last && last->len == len && memcmp(last->text, text, len * sizeof(uint32_t)) == 0) {
        return; /* like HISTCONTROL=ignoredups */
    }
    if (s_history_len == HISTORY_MAX) {
        free(s_history[0].text);
        memmove(s_history, s_history + 1, (HISTORY_MAX - 1) * sizeof(entry_t));
        s_history_len--;
    }
    s_history[s_history_len++] = copy_entry(text, len);
    history_save();
}

void line_editor_init(void)
{
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return;
    }
    size_t size = 0;
    if (nvs_get_blob(nvs, "history", NULL, &size) == ESP_OK && size > 0 && size <= HISTORY_BLOB_MAX) {
        char *blob = heap_caps_calloc(1, size + 1, MALLOC_CAP_SPIRAM);
        uint32_t *tmp = heap_caps_malloc(LINE_MAX * sizeof(uint32_t), MALLOC_CAP_SPIRAM);
        if (blob && tmp && nvs_get_blob(nvs, "history", blob, &size) == ESP_OK) {
            for (size_t pos = 0; pos < size && s_history_len < HISTORY_MAX;) {
                size_t n = decode_utf8(blob + pos, tmp, LINE_MAX);
                if (n > 0) {
                    s_history[s_history_len++] = copy_entry(tmp, n);
                }
                pos += strlen(blob + pos) + 1;
            }
        }
        free(blob);
        free(tmp);
    }
    nvs_close(nvs);
    ESP_LOGI(TAG, "%d history lines", s_history_len);
}

/* ---------------------------------------------------------------- editing -- */

static void set_line(const uint32_t *text, size_t len)
{
    s_len = len > LINE_MAX ? LINE_MAX : len;
    memcpy(s_line, text, s_len * sizeof(uint32_t));
    s_cursor = s_len;
}

static bool is_space(uint32_t c)
{
    return c == ' ';
}

static size_t word_left(void)
{
    size_t i = s_cursor;
    while (i > 0 && is_space(s_line[i - 1])) {
        i--;
    }
    while (i > 0 && !is_space(s_line[i - 1])) {
        i--;
    }
    return i;
}

static size_t word_right(void)
{
    size_t i = s_cursor;
    while (i < s_len && is_space(s_line[i])) {
        i++;
    }
    while (i < s_len && !is_space(s_line[i])) {
        i++;
    }
    return i;
}

static void erase(size_t from, size_t to)
{
    memmove(s_line + from, s_line + to, (s_len - to) * sizeof(uint32_t));
    s_len -= to - from;
    s_cursor = from;
}

static void browse(int direction)
{
    if (s_history_len == 0) {
        return;
    }
    int next = s_browse;
    if (direction < 0) {
        if (s_browse == -1) {
            free(s_stash.text);
            s_stash = copy_entry(s_line, s_len);
            next = s_history_len - 1;
        } else if (s_browse > 0) {
            next = s_browse - 1;
        } else {
            return;
        }
    } else {
        if (s_browse == -1) {
            return;
        }
        next = s_browse + 1 < s_history_len ? s_browse + 1 : -1;
    }
    s_browse = next;
    if (next == -1) {
        set_line(s_stash.text, s_stash.len);
    } else {
        set_line(s_history[next].text, s_history[next].len);
    }
}

static void submit(void)
{
    size_t start = 0;
    size_t end = s_len;
    while (start < end && is_space(s_line[start])) {
        start++;
    }
    while (end > start && is_space(s_line[end - 1])) {
        end--;
    }
    if (end == start) {
        return;
    }
    mike_link_say(s_line + start, end - start);
    history_add(s_line + start, end - start);
    s_len = 0;
    s_cursor = 0;
    s_browse = -1;
}

void line_editor_key(const key_event_t *event)
{
    size_t len_before = s_len;
    size_t cursor_before = s_cursor;
    bool changed = false;

    switch (event->action) {
    case KEY_CHAR:
        if (s_len < LINE_MAX) {
            memmove(s_line + s_cursor + 1, s_line + s_cursor, (s_len - s_cursor) * sizeof(uint32_t));
            s_line[s_cursor++] = event->codepoint;
            s_len++;
            changed = true;
        }
        break;
    case KEY_BACKSPACE:
        if (s_cursor > 0) {
            erase(s_cursor - 1, s_cursor);
            changed = true;
        }
        break;
    case KEY_DELETE:
        if (s_cursor < s_len) {
            erase(s_cursor, s_cursor + 1);
            changed = true;
        }
        break;
    case KEY_DELETE_WORD:
        if (s_cursor > 0) {
            erase(word_left(), s_cursor);
            changed = true;
        }
        break;
    case KEY_KILL_START:
        if (s_cursor > 0) {
            erase(0, s_cursor);
            changed = true;
        }
        break;
    case KEY_KILL_END:
        if (s_cursor < s_len) {
            s_len = s_cursor;
            changed = true;
        }
        break;
    case KEY_LEFT:
        s_cursor = s_cursor > 0 ? s_cursor - 1 : 0;
        break;
    case KEY_RIGHT:
        s_cursor = s_cursor < s_len ? s_cursor + 1 : s_len;
        break;
    case KEY_WORD_LEFT:
        s_cursor = word_left();
        break;
    case KEY_WORD_RIGHT:
        s_cursor = word_right();
        break;
    case KEY_HOME:
        s_cursor = 0;
        break;
    case KEY_END:
        s_cursor = s_len;
        break;
    case KEY_UP:
        browse(-1);
        changed = true;
        break;
    case KEY_DOWN:
        browse(1);
        changed = true;
        break;
    case KEY_ESCAPE:
        if (s_len > 0) {
            s_len = 0;
            s_cursor = 0;
            changed = true;
        }
        s_browse = -1;
        break;
    case KEY_INTERRUPT:
        mike_link_interrupt();
        return;
    case KEY_TAB:
    case KEY_SETTINGS:
        return;
    case KEY_ENTER:
        submit();
        return; /* the server empties the box itself when the line arrives */
    }

    if (event->action != KEY_UP && event->action != KEY_DOWN && changed) {
        /* Editing a recalled line makes it the new line; history stays as it was. */
        s_browse = -1;
    }
    if (changed || s_len != len_before || s_cursor != cursor_before) {
        mike_link_draft(s_line, s_len, s_cursor);
    }
}
