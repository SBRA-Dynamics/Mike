#include "ota_server.h"

#include <stdio.h>
#include <string.h>

#include "app_config.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mdns.h"

static const char *TAG = "ota";

#define CHUNK 4096

static esp_timer_handle_t s_probation;

/* ------------------------------------------------------------- probation -- */

static void probation_expired(void *arg)
{
    ESP_LOGE(TAG, "new image did not reach the network in %d s, rolling back", OTA_CONFIRM_S);
    esp_ota_mark_app_invalid_rollback_and_reboot();
    esp_restart(); /* nothing to roll back to: at least try again */
}

void ota_watchdog_start(void)
{
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &state) != ESP_OK ||
        state != ESP_OTA_IMG_PENDING_VERIFY) {
        return;
    }
    ESP_LOGW(TAG, "running a new image on probation for %d s", OTA_CONFIRM_S);
    const esp_timer_create_args_t args = {.callback = probation_expired, .name = "ota_probation"};
    if (esp_timer_create(&args, &s_probation) == ESP_OK) {
        esp_timer_start_once(s_probation, (uint64_t)OTA_CONFIRM_S * 1000000);
    }
}

void ota_confirm(void)
{
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &state) == ESP_OK &&
        state == ESP_OTA_IMG_PENDING_VERIFY) {
        esp_ota_mark_app_valid_cancel_rollback();
        ESP_LOGI(TAG, "new image confirmed");
    }
    if (s_probation != NULL) {
        esp_timer_stop(s_probation);
    }
}

/* ------------------------------------------------------------------ page -- */

static const char PAGE[] =
    "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>Firmware update</title><style>"
    "body{font:16px system-ui,sans-serif;background:#141413;color:#f5f4ef;max-width:32rem;margin:2rem auto;padding:0 16px}"
    "h1{font-size:1.4rem}input,button{font:inherit;width:100%;box-sizing:border-box;margin:.4rem 0;padding:.6rem;"
    "border-radius:8px;border:1px solid #444;background:#1f1e1d;color:inherit}"
    "button{background:#d97757;border:0;color:#141413;font-weight:600}button:disabled{opacity:.5}"
    "progress{width:100%;height:1rem}#info,#status{color:#9a9893;white-space:pre-line}"
    "</style></head><body><h1>Firmware update</h1><div id=info>...</div>"
    "<input id=file type=file accept='.bin'><input id=pw type=password placeholder=Password>"
    "<button id=go>Upload</button><progress id=bar value=0 max=1></progress><div id=status></div>"
    "<script>"
    "const $=id=>document.getElementById(id);"
    "try{$('pw').value=localStorage.otaPw||''}catch(e){}"
    "const info=()=>fetch('/info').then(r=>r.json()).then(i=>{$('info').textContent="
    "`Version ${i.version} (built ${i.built})\\nRunning from ${i.partition}`;return i});"
    "info();"
    "$('go').onclick=()=>{const f=$('file').files[0];if(!f){$('status').textContent='Choose a .bin first.';return}"
    "try{localStorage.otaPw=$('pw').value}catch(e){}"
    "const x=new XMLHttpRequest();x.open('POST','/update');x.setRequestHeader('X-OTA-Password',$('pw').value);"
    "x.upload.onprogress=e=>{$('bar').value=e.loaded/e.total};$('go').disabled=true;$('status').textContent='Uploading...';"
    "x.onload=()=>{if(x.status!==200){$('status').textContent=x.responseText;$('go').disabled=false;return}"
    "$('status').textContent='Written. Restarting...';"
    "const wait=()=>setTimeout(()=>info().then(()=>{$('status').textContent='Updated and running.';$('go').disabled=false})"
    ".catch(wait),2000);wait()};"
    "x.onerror=()=>{$('status').textContent='Upload failed.';$('go').disabled=false};x.send(f)};"
    "</script></body></html>";

static esp_err_t page_get(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, PAGE, sizeof(PAGE) - 1);
}

static esp_err_t info_get(httpd_req_t *req)
{
    const esp_app_desc_t *app = esp_app_get_description();
    char json[256];
    snprintf(json, sizeof(json), "{\"version\":\"%s\",\"built\":\"%s %s\",\"partition\":\"%s\",\"idf\":\"%s\"}",
             app->version, app->date, app->time, esp_ota_get_running_partition()->label, app->idf_ver);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, json);
}

/* ---------------------------------------------------------------- upload -- */

static bool password_ok(httpd_req_t *req)
{
    char given[128] = "";
    if (httpd_req_get_hdr_value_str(req, "X-OTA-Password", given, sizeof(given)) != ESP_OK) {
        return false;
    }
    const char *want = OTA_PASSWORD;
    size_t a = strlen(given);
    size_t b = strlen(want);
    unsigned diff = a ^ b;
    for (size_t i = 0; i < a && i < b; i++) {
        diff |= (unsigned)(given[i] ^ want[i]);
    }
    return diff == 0 && b > 0;
}

static void restart_task(void *arg)
{
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
}

static esp_err_t update_post(httpd_req_t *req)
{
    if (!password_ok(req)) {
        ESP_LOGW(TAG, "update refused: wrong password");
        httpd_resp_set_status(req, "403 Forbidden");
        return httpd_resp_sendstr(req, "Wrong password.");
    }

    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    if (target == NULL || req->content_len == 0 || req->content_len > target->size) {
        httpd_resp_set_status(req, "400 Bad Request");
        return httpd_resp_sendstr(req, target ? "Image missing or larger than the partition." : "No OTA partition.");
    }

    esp_ota_handle_t ota;
    esp_err_t err = esp_ota_begin(target, OTA_WITH_SEQUENTIAL_WRITES, &ota);
    if (err != ESP_OK) {
        httpd_resp_set_status(req, "500 Internal Server Error");
        return httpd_resp_sendstr(req, esp_err_to_name(err));
    }
    ESP_LOGI(TAG, "receiving %d bytes into %s", req->content_len, target->label);

    char *buf = heap_caps_malloc(CHUNK, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    size_t left = req->content_len;
    int64_t started = esp_timer_get_time();
    while (buf != NULL && left > 0 && err == ESP_OK) {
        int n = httpd_req_recv(req, buf, left < CHUNK ? left : CHUNK);
        if (n == HTTPD_SOCK_ERR_TIMEOUT) {
            continue;
        }
        if (n <= 0) {
            err = ESP_FAIL;
            break;
        }
        err = esp_ota_write(ota, buf, n);
        left -= n;
    }
    free(buf);

    if (err != ESP_OK || left > 0) {
        esp_ota_abort(ota);
        ESP_LOGE(TAG, "upload failed: %s", esp_err_to_name(err));
        httpd_resp_set_status(req, "500 Internal Server Error");
        return httpd_resp_sendstr(req, "Upload failed; the running firmware is unchanged.");
    }
    /* esp_ota_end validates the image (header, checksum, chip) before anything boots it. */
    err = esp_ota_end(ota);
    if (err == ESP_OK) {
        err = esp_ota_set_boot_partition(target);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "image rejected: %s", esp_err_to_name(err));
        httpd_resp_set_status(req, "400 Bad Request");
        char msg[96];
        snprintf(msg, sizeof(msg), "Image rejected (%s); the running firmware is unchanged.", esp_err_to_name(err));
        return httpd_resp_sendstr(req, msg);
    }

    ESP_LOGI(TAG, "written in %lld ms, restarting into %s", (esp_timer_get_time() - started) / 1000, target->label);
    httpd_resp_sendstr(req, "OK");
    xTaskCreate(restart_task, "ota_restart", 2048, NULL, 5, NULL);
    return ESP_OK;
}

/* ---------------------------------------------------------------- server -- */

void ota_server_start(void)
{
    if (OTA_PASSWORD[0] == '\0') {
        ESP_LOGW(TAG, "OTA_PASSWORD is empty, firmware updates over WiFi are off");
        return;
    }

    if (mdns_init() == ESP_OK) {
        mdns_hostname_set(OTA_HOSTNAME);
        mdns_instance_name_set("Claude usage monitor");
        mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0);
    }

    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.stack_size = 6144;
    cfg.recv_wait_timeout = 10;
    httpd_handle_t server = NULL;
    if (httpd_start(&server, &cfg) != ESP_OK) {
        ESP_LOGE(TAG, "web server did not start");
        return;
    }
    const httpd_uri_t routes[] = {
        {.uri = "/", .method = HTTP_GET, .handler = page_get},
        {.uri = "/info", .method = HTTP_GET, .handler = info_get},
        {.uri = "/update", .method = HTTP_POST, .handler = update_post},
    };
    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        httpd_register_uri_handler(server, &routes[i]);
    }
    ESP_LOGI(TAG, "update page at http://%s.local/", OTA_HOSTNAME);
}
