#include "usage_client.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_rom_crc.h"
#include "nvs.h"
#include "secrets.h"

static const char *TAG = "usage_client";

#define USAGE_URL "https://api.anthropic.com/api/oauth/usage"
#define TOKEN_URL "https://platform.claude.com/v1/oauth/token"
/* Public OAuth client id of Claude Code; the usage endpoint only accepts its tokens. */
#define OAUTH_CLIENT_ID "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
#define OAUTH_SCOPES "user:profile user:inference"
#define OAUTH_BETA "oauth-2025-04-20"
#define USER_AGENT "claude-usage-monitor/1.0 (ESP32-S3)"

#define NVS_NAMESPACE "claude"
#define TOKEN_MAX 512
#define RESPONSE_MAX (32 * 1024)
#define REFRESH_MARGIN_S 300

static char s_refresh_token[TOKEN_MAX];
static char s_access_token[TOKEN_MAX];
static int64_t s_access_expires; /* UTC epoch seconds, 0 = unknown */

static bool time_is_valid(void)
{
    return time(NULL) > 1700000000;
}

static void nvs_save_tokens(void)
{
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open failed, rotated tokens are not persisted");
        return;
    }
    nvs_set_str(nvs, "rt", s_refresh_token);
    nvs_set_str(nvs, "at", s_access_token);
    nvs_set_i64(nvs, "exp", s_access_expires);
    nvs_commit(nvs);
    nvs_close(nvs);
}

void usage_client_init(void)
{
    /* Fingerprint of the compiled-in tokens, to notice when secrets.h was edited. */
    uint32_t seed_crc = esp_rom_crc32_le(0, (const uint8_t *)CLAUDE_REFRESH_TOKEN, strlen(CLAUDE_REFRESH_TOKEN));
    seed_crc = esp_rom_crc32_le(seed_crc, (const uint8_t *)CLAUDE_ACCESS_TOKEN, strlen(CLAUDE_ACCESS_TOKEN));

    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open failed, using compiled-in tokens only");
        strlcpy(s_refresh_token, CLAUDE_REFRESH_TOKEN, sizeof(s_refresh_token));
        strlcpy(s_access_token, CLAUDE_ACCESS_TOKEN, sizeof(s_access_token));
        return;
    }

    uint32_t stored_crc = 0;
    size_t len = sizeof(s_refresh_token);
    bool have_stored = nvs_get_u32(nvs, "seed_crc", &stored_crc) == ESP_OK && stored_crc == seed_crc &&
                       nvs_get_str(nvs, "rt", s_refresh_token, &len) == ESP_OK;

    if (have_stored) {
        len = sizeof(s_access_token);
        if (nvs_get_str(nvs, "at", s_access_token, &len) != ESP_OK) {
            s_access_token[0] = '\0';
        }
        if (nvs_get_i64(nvs, "exp", &s_access_expires) != ESP_OK) {
            s_access_expires = 0;
        }
        ESP_LOGI(TAG, "using tokens stored in NVS");
    } else {
        /* New (or first) token in secrets.h: forget whatever was rotated before. */
        strlcpy(s_refresh_token, CLAUDE_REFRESH_TOKEN, sizeof(s_refresh_token));
        strlcpy(s_access_token, CLAUDE_ACCESS_TOKEN, sizeof(s_access_token));
        s_access_expires = 0;
        nvs_set_u32(nvs, "seed_crc", seed_crc);
        nvs_set_str(nvs, "rt", s_refresh_token);
        nvs_set_str(nvs, "at", s_access_token);
        nvs_set_i64(nvs, "exp", 0);
        nvs_commit(nvs);
        ESP_LOGI(TAG, "seeded tokens from secrets.h");
    }
    nvs_close(nvs);
}

bool usage_client_has_credentials(void)
{
    return s_refresh_token[0] != '\0' || s_access_token[0] != '\0';
}

/* Performs one HTTPS request and collects the body into buf (NUL terminated). */
static esp_err_t http_request(esp_http_client_method_t method, const char *url, const char *bearer,
                              const char *json_body, int *status, char *buf, size_t cap)
{
    esp_http_client_config_t cfg = {
        .url = url,
        .method = method,
        .timeout_ms = 20000,
        .buffer_size = 4096,
        .buffer_size_tx = 2048,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (client == NULL) {
        return ESP_ERR_NO_MEM;
    }

    esp_http_client_set_header(client, "User-Agent", USER_AGENT);
    esp_http_client_set_header(client, "Accept", "application/json");
    esp_http_client_set_header(client, "anthropic-beta", OAUTH_BETA);
    if (bearer != NULL) {
        char auth[TOKEN_MAX + 16];
        snprintf(auth, sizeof(auth), "Bearer %s", bearer);
        esp_http_client_set_header(client, "Authorization", auth);
    }
    int body_len = 0;
    if (json_body != NULL) {
        esp_http_client_set_header(client, "Content-Type", "application/json");
        body_len = strlen(json_body);
    }

    esp_err_t err = esp_http_client_open(client, body_len);
    if (err == ESP_OK && body_len > 0 && esp_http_client_write(client, json_body, body_len) != body_len) {
        err = ESP_FAIL;
    }
    if (err == ESP_OK && esp_http_client_fetch_headers(client) < 0) {
        err = ESP_FAIL;
    }

    size_t total = 0;
    if (err == ESP_OK) {
        *status = esp_http_client_get_status_code(client);
        while (total < cap - 1) {
            int n = esp_http_client_read(client, buf + total, cap - 1 - total);
            if (n < 0) {
                err = ESP_FAIL;
                break;
            }
            if (n == 0) {
                break;
            }
            total += n;
        }
    }
    buf[total] = '\0';

    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return err;
}

static esp_err_t refresh_access_token(char *buf, size_t cap, char *err, size_t err_len)
{
    if (s_refresh_token[0] == '\0') {
        snprintf(err, err_len, "Access token expired.\nSet CLAUDE_REFRESH_TOKEN.");
        return ESP_ERR_INVALID_STATE;
    }

    cJSON *req = cJSON_CreateObject();
    cJSON_AddStringToObject(req, "grant_type", "refresh_token");
    cJSON_AddStringToObject(req, "refresh_token", s_refresh_token);
    cJSON_AddStringToObject(req, "client_id", OAUTH_CLIENT_ID);
    cJSON_AddStringToObject(req, "scope", OAUTH_SCOPES);
    char *body = cJSON_PrintUnformatted(req);
    cJSON_Delete(req);

    int status = 0;
    esp_err_t ret = http_request(HTTP_METHOD_POST, TOKEN_URL, NULL, body, &status, buf, cap);
    cJSON_free(body);
    if (ret != ESP_OK) {
        snprintf(err, err_len, "Token refresh: network error");
        return ret;
    }
    if (status != 200) {
        ESP_LOGE(TAG, "token refresh HTTP %d: %.200s", status, buf);
        if (status == 400 || status == 401) {
            snprintf(err, err_len, "Refresh token rejected (%d).\nRun tools/claude_login.py", status);
        } else {
            snprintf(err, err_len, "Token refresh failed (HTTP %d)", status);
        }
        return ESP_FAIL;
    }

    cJSON *root = cJSON_Parse(buf);
    const char *access = cJSON_GetStringValue(cJSON_GetObjectItem(root, "access_token"));
    const char *refresh = cJSON_GetStringValue(cJSON_GetObjectItem(root, "refresh_token"));
    cJSON *expires_in = cJSON_GetObjectItem(root, "expires_in");
    if (access == NULL) {
        cJSON_Delete(root);
        snprintf(err, err_len, "Token refresh: bad response");
        return ESP_FAIL;
    }
    strlcpy(s_access_token, access, sizeof(s_access_token));
    if (refresh != NULL) {
        strlcpy(s_refresh_token, refresh, sizeof(s_refresh_token));
    }
    s_access_expires = (time_is_valid() && cJSON_IsNumber(expires_in))
                           ? (int64_t)time(NULL) + (int64_t)expires_in->valuedouble
                           : 0;
    cJSON_Delete(root);
    nvs_save_tokens();
    ESP_LOGI(TAG, "access token refreshed, expires at %" PRId64, s_access_expires);
    return ESP_OK;
}

/* Days since 1970-01-01 for a proleptic Gregorian date. */
static int64_t days_from_civil(int y, unsigned m, unsigned d)
{
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (int64_t)doe - 719468;
}

/* Parses "2026-09-17T04:00:00.272136+00:00" into UTC epoch seconds. */
static time_t parse_iso8601(const char *s)
{
    int y, mo, d, h, mi, se;
    if (s == NULL || sscanf(s, "%d-%d-%dT%d:%d:%d", &y, &mo, &d, &h, &mi, &se) != 6) {
        return 0;
    }
    int64_t t = days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se;

    const char *tz = strchr(s, 'T');
    tz = tz ? strpbrk(tz, "Z+-") : NULL;
    int oh, om;
    if (tz != NULL && *tz != 'Z' && sscanf(tz + 1, "%d:%d", &oh, &om) == 2) {
        int offset = oh * 3600 + om * 60;
        t += (*tz == '+') ? -offset : offset;
    }
    return (time_t)t;
}

static void add_limit(usage_data_t *out, const char *title, bool weekly, double percent, const char *resets_at,
                      bool active)
{
    if (out->limit_count >= USAGE_MAX_LIMITS) {
        return;
    }
    usage_limit_t *l = &out->limits[out->limit_count++];
    strlcpy(l->title, title, sizeof(l->title));
    l->weekly = weekly;
    l->percent = percent < 0 ? 0 : (percent > 100 ? 100 : (int)(percent + 0.5));
    l->resets_at = parse_iso8601(resets_at);
    l->active = active;
}

static double money(cJSON *obj)
{
    cJSON *minor = cJSON_GetObjectItem(obj, "amount_minor");
    cJSON *exp = cJSON_GetObjectItem(obj, "exponent");
    if (!cJSON_IsNumber(minor)) {
        return 0;
    }
    double v = minor->valuedouble;
    for (int i = 0; cJSON_IsNumber(exp) && i < exp->valueint; i++) {
        v /= 10.0;
    }
    return v;
}

static esp_err_t parse_usage(const char *json, usage_data_t *out)
{
    cJSON *root = cJSON_Parse(json);
    if (root == NULL) {
        return ESP_FAIL;
    }
    memset(out, 0, sizeof(*out));

    cJSON *limits = cJSON_GetObjectItem(root, "limits");
    cJSON *item;
    if (cJSON_IsArray(limits) && cJSON_GetArraySize(limits) > 0) {
        cJSON_ArrayForEach(item, limits) {
            const char *kind = cJSON_GetStringValue(cJSON_GetObjectItem(item, "kind"));
            const char *group = cJSON_GetStringValue(cJSON_GetObjectItem(item, "group"));
            cJSON *percent = cJSON_GetObjectItem(item, "percent");
            const char *resets = cJSON_GetStringValue(cJSON_GetObjectItem(item, "resets_at"));
            bool active = cJSON_IsTrue(cJSON_GetObjectItem(item, "is_active"));
            if (kind == NULL || !cJSON_IsNumber(percent)) {
                continue;
            }

            char title[48];
            if (strcmp(kind, "session") == 0) {
                strlcpy(title, "Current session", sizeof(title));
            } else if (strcmp(kind, "weekly_all") == 0) {
                strlcpy(title, "All models", sizeof(title));
            } else {
                cJSON *model = cJSON_GetObjectItem(cJSON_GetObjectItem(item, "scope"), "model");
                cJSON *surface = cJSON_GetObjectItem(cJSON_GetObjectItem(item, "scope"), "surface");
                const char *name = cJSON_GetStringValue(cJSON_GetObjectItem(model, "display_name"));
                if (name == NULL) {
                    name = cJSON_GetStringValue(cJSON_GetObjectItem(surface, "display_name"));
                }
                if (name != NULL) {
                    snprintf(title, sizeof(title), "%s only", name);
                } else {
                    strlcpy(title, kind, sizeof(title));
                }
            }
            bool weekly = group != NULL ? strcmp(group, "session") != 0 : strncmp(kind, "weekly", 6) == 0;
            add_limit(out, title, weekly, percent->valuedouble, resets, active);
        }
    } else {
        /* Older response shape without the "limits" summary. */
        static const struct {
            const char *key;
            const char *title;
            bool weekly;
        } windows[] = {
            {"five_hour", "Current session", false},
            {"seven_day", "All models", true},
            {"seven_day_opus", "Opus only", true},
            {"seven_day_sonnet", "Sonnet only", true},
        };
        for (size_t i = 0; i < sizeof(windows) / sizeof(windows[0]); i++) {
            cJSON *w = cJSON_GetObjectItem(root, windows[i].key);
            cJSON *util = cJSON_GetObjectItem(w, "utilization");
            if (cJSON_IsNumber(util)) {
                add_limit(out, windows[i].title, windows[i].weekly, util->valuedouble,
                          cJSON_GetStringValue(cJSON_GetObjectItem(w, "resets_at")), false);
            }
        }
    }

    cJSON *spend = cJSON_GetObjectItem(root, "spend");
    if (cJSON_IsObject(spend)) {
        out->spend_present = true;
        out->spend_enabled = cJSON_IsTrue(cJSON_GetObjectItem(spend, "enabled"));
        cJSON *used = cJSON_GetObjectItem(spend, "used");
        cJSON *limit = cJSON_GetObjectItem(spend, "limit");
        out->spend_used = money(used);
        out->spend_limit = money(limit);
        cJSON *percent = cJSON_GetObjectItem(spend, "percent");
        out->spend_percent = cJSON_IsNumber(percent) ? percent->valueint : 0;
        const char *currency = cJSON_GetStringValue(cJSON_GetObjectItem(used, "currency"));
        strlcpy(out->spend_currency, currency ? currency : "", sizeof(out->spend_currency));
    }

    cJSON_Delete(root);
    out->fetched_at = time(NULL);
    return out->limit_count > 0 ? ESP_OK : ESP_ERR_NOT_FOUND;
}

esp_err_t usage_client_fetch(usage_data_t *out, char *err, size_t err_len)
{
    err[0] = '\0';
    if (!usage_client_has_credentials()) {
        snprintf(err, err_len, "No Claude token.\nEdit main/secrets.h");
        return ESP_ERR_INVALID_STATE;
    }

    char *buf = heap_caps_malloc(RESPONSE_MAX, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == NULL) {
        snprintf(err, err_len, "Out of memory");
        return ESP_ERR_NO_MEM;
    }

    esp_err_t ret = ESP_OK;
    bool refreshed = false;
    bool expired = s_access_expires != 0 && time_is_valid() && time(NULL) >= s_access_expires - REFRESH_MARGIN_S;
    if (s_access_token[0] == '\0' || (expired && s_refresh_token[0] != '\0')) {
        ret = refresh_access_token(buf, RESPONSE_MAX, err, err_len);
        refreshed = true;
    }

    int status = 0;
    while (ret == ESP_OK) {
        ret = http_request(HTTP_METHOD_GET, USAGE_URL, s_access_token, NULL, &status, buf, RESPONSE_MAX);
        if (ret != ESP_OK) {
            snprintf(err, err_len, "Usage: network error");
            break;
        }
        if (status == 401 && !refreshed) {
            ESP_LOGW(TAG, "usage returned 401, refreshing token");
            ret = refresh_access_token(buf, RESPONSE_MAX, err, err_len);
            refreshed = true;
            continue;
        }
        if (status != 200) {
            ESP_LOGE(TAG, "usage HTTP %d: %.200s", status, buf);
            if (status == 429) {
                snprintf(err, err_len, "Rate limited (HTTP 429)");
            } else {
                snprintf(err, err_len, "Usage request failed (HTTP %d)", status);
            }
            ret = ESP_FAIL;
            break;
        }
        ret = parse_usage(buf, out);
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "unexpected usage response: %.300s", buf);
            snprintf(err, err_len, "Unexpected usage response");
        }
        break;
    }

    free(buf);
    return ret;
}
