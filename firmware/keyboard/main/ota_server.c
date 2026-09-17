#include "ota_server.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app_config.h"
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "keyboard_input.h"
#include "mdns.h"
#include "mike_link.h"
#include "settings.h"
#include "usage_client.h"

static const char *TAG = "web";

#define CHUNK 4096
#define JSON_MAX 2048

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
    "<title>Keyboard settings</title><style>"
    "body{font:16px system-ui,sans-serif;background:#141413;color:#f5f4ef;max-width:34rem;margin:1.5rem auto;padding:0 16px}"
    "h1{font-size:1.4rem}h2{font-size:1.05rem;margin:1.6rem 0 .4rem;color:#d97757}"
    "label{display:block;font-size:.85rem;color:#9a9893;margin-top:.5rem}"
    "input,button{font:inherit;width:100%;box-sizing:border-box;margin:.25rem 0;padding:.55rem;border-radius:8px;"
    "border:1px solid #444;background:#1f1e1d;color:inherit}"
    "button{background:#d97757;border:0;color:#141413;font-weight:600;margin-top:.5rem}button:disabled{opacity:.5}"
    "progress{width:100%;height:1rem}.muted{color:#9a9893;white-space:pre-line}.msg{white-space:pre-line;margin:.4rem 0}"
    "a{color:#d97757;word-break:break-all}"
    "</style></head><body><h1>Keyboard settings</h1><div id=status class=muted>...</div>"
    "<div id=first hidden><h2>Set an admin password</h2><div class=msg>None is set yet. The first one can be set here; "
    "after that it is changed on the board (F2).</div><input id=newpw type=password autocomplete=new-password placeholder='At least 6 characters'>"
    "<button id=setpw>Set admin password</button><div id=firstMsg class=msg></div></div>"
    "<label>Admin password</label><input id=pw type=password autocomplete=current-password>"

    "<h2>Mike</h2>"
    "<label>Server address on the LAN</label><input id=host placeholder=192.168.1.10>"
    "<label>Port</label><input id=port type=number placeholder=3456>"
    "<label>Name on the server's certificate (empty for no TLS)</label><input id=tls placeholder=mike.example.com>"
    "<label>Token (MIKE_TOKEN; empty keeps the stored one)</label><input id=token type=password autocomplete=off>"
    "<button id=saveMike>Save and restart</button><div id=mikeMsg class=msg></div>"

    "<h2>Claude login</h2>"
    "<button id=login>Start login</button>"
    "<div id=loginStep hidden><div class=msg>1. Open <a id=loginUrl target=_blank rel=noopener>this link</a> and "
    "authorize.\n2. Paste the code it shows:</div><input id=code autocomplete=off>"
    "<button id=finish>Finish login</button></div><div id=loginMsg class=msg></div>"

    "<h2>Firmware</h2>"
    "<input id=file type=file accept='.bin'><button id=upload>Upload</button>"
    "<progress id=bar value=0 max=1></progress><div id=fwMsg class=msg></div>"

    "<script>"
    "const $=id=>document.getElementById(id);"
    "try{$('pw').value=localStorage.adminPw||''}catch(e){}"
    "$('pw').onchange=()=>{try{localStorage.adminPw=$('pw').value}catch(e){}};"
    "const post=(url,body,type='application/json')=>fetch(url,{method:'POST',body,"
    "headers:{'X-Admin-Password':$('pw').value,'Content-Type':type}})"
    ".then(async r=>{const t=await r.text();if(!r.ok)throw new Error(t||r.status);return t});"
    "const info=()=>fetch('/info').then(r=>r.json()).then(i=>{"
    "$('status').textContent=`Firmware ${i.version} (${i.partition})\\nWiFi ${i.wifi.ssid||'not set'} ${i.wifi.ip||''}\\n`+"
    "`Mike ${i.mike.host?i.mike.host+':'+i.mike.port:'not set'}${i.mike.connected?' - connected':''}\\n`+"
    "`Claude ${i.claude.logged_in?'logged in':'not logged in'}\\n`+"
    "`Keyboard ${i.keyboard.attached?'attached':'not attached'}, ${i.keyboard.interfaces} USB interfaces, `+"
    "`${i.keyboard.reports} reports, ${i.keyboard.keys} keys, ${i.keyboard.transfer_errors} transfer errors`;"
    "$('first').hidden=i.admin_set;"
    "if(!$('host').value){$('host').value=i.mike.host;$('port').value=i.mike.port;$('tls').value=i.mike.tls_name}"
    "$('token').placeholder=i.mike.token_set?'stored':'';return i});"
    "info();"
    "$('setpw').onclick=()=>fetch('/api/admin',{method:'POST',body:JSON.stringify({password:$('newpw').value})})"
    ".then(async r=>{const t=await r.text();if(!r.ok)throw new Error(t);$('pw').value=$('newpw').value;"
    "try{localStorage.adminPw=$('pw').value}catch(e){}$('firstMsg').textContent='Saved.';info()})"
    ".catch(e=>$('firstMsg').textContent=e.message);"
    "$('saveMike').onclick=()=>{$('mikeMsg').textContent='Saving...';"
    "post('/api/mike',JSON.stringify({host:$('host').value.trim(),port:+$('port').value||3456,"
    "tls_name:$('tls').value.trim(),token:$('token').value.trim()}))"
    ".then(()=>{$('mikeMsg').textContent='Saved. Restarting...';$('token').value='';setTimeout(()=>info().catch(()=>{}),8000)})"
    ".catch(e=>$('mikeMsg').textContent=e.message)};"
    "$('login').onclick=()=>post('/api/claude/start','').then(t=>{const u=JSON.parse(t).url;"
    "$('loginUrl').href=u;$('loginStep').hidden=false;$('loginMsg').textContent='';window.open(u,'_blank')})"
    ".catch(e=>$('loginMsg').textContent=e.message);"
    "$('finish').onclick=()=>{$('loginMsg').textContent='Logging in...';"
    "post('/api/claude/finish',JSON.stringify({code:$('code').value.trim()}))"
    ".then(()=>{$('loginMsg').textContent='Logged in.';$('loginStep').hidden=true;$('code').value='';info()})"
    ".catch(e=>$('loginMsg').textContent=e.message)};"
    "$('upload').onclick=()=>{const f=$('file').files[0];if(!f){$('fwMsg').textContent='Choose a .bin first.';return}"
    "const x=new XMLHttpRequest();x.open('POST','/update');x.setRequestHeader('X-Admin-Password',$('pw').value);"
    "x.upload.onprogress=e=>{$('bar').value=e.loaded/e.total};$('upload').disabled=true;$('fwMsg').textContent='Uploading...';"
    "x.onload=()=>{if(x.status!==200){$('fwMsg').textContent=x.responseText;$('upload').disabled=false;return}"
    "$('fwMsg').textContent='Written. Restarting...';"
    "const wait=()=>setTimeout(()=>info().then(()=>{$('fwMsg').textContent='Updated and running.';$('upload').disabled=false})"
    ".catch(wait),2000);wait()};"
    "x.onerror=()=>{$('fwMsg').textContent='Upload failed.';$('upload').disabled=false};x.send(f)};"
    "</script></body></html>";

static esp_err_t page_get(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, PAGE, sizeof(PAGE) - 1);
}

/* -------------------------------------------------------------- helpers -- */

static esp_err_t send_json(httpd_req_t *req, cJSON *root)
{
    char *text = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_sendstr(req, text ? text : "{}");
    cJSON_free(text);
    return err;
}

static esp_err_t fail(httpd_req_t *req, const char *status, const char *message)
{
    httpd_resp_set_status(req, status);
    return httpd_resp_sendstr(req, message);
}

/* Refuses the request unless it carries the admin password. Returns true when allowed. */
static bool authorized(httpd_req_t *req)
{
    if (!settings_admin_password_set()) {
        fail(req, "403 Forbidden", "No admin password is set. Press F2 on the keyboard and set one.");
        return false;
    }
    char given[80] = "";
    httpd_req_get_hdr_value_str(req, "X-Admin-Password", given, sizeof(given));
    if (!settings_check_admin_password(given)) {
        ESP_LOGW(TAG, "wrong admin password for %s", req->uri);
        fail(req, "403 Forbidden", "Wrong admin password.");
        return false;
    }
    return true;
}

/* The request body as parsed JSON, or NULL (and an error already sent). */
static cJSON *read_json(httpd_req_t *req)
{
    if (req->content_len > JSON_MAX) {
        fail(req, "413 Payload Too Large", "Too large.");
        return NULL;
    }
    char buf[JSON_MAX + 1];
    size_t got = 0;
    while (got < req->content_len) {
        int n = httpd_req_recv(req, buf + got, req->content_len - got);
        if (n == HTTPD_SOCK_ERR_TIMEOUT) {
            continue;
        }
        if (n <= 0) {
            return NULL;
        }
        got += n;
    }
    buf[got] = '\0';
    cJSON *root = cJSON_Parse(buf);
    if (root == NULL) {
        fail(req, "400 Bad Request", "Not JSON.");
    }
    return root;
}

static void restart_task(void *arg)
{
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
}

/* ----------------------------------------------------------------- status -- */

static esp_err_t info_get(httpd_req_t *req)
{
    const esp_app_desc_t *app = esp_app_get_description();
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "version", app->version);
    char built[40];
    snprintf(built, sizeof(built), "%s %s", app->date, app->time);
    cJSON_AddStringToObject(root, "built", built);
    cJSON_AddStringToObject(root, "partition", esp_ota_get_running_partition()->label);
    cJSON_AddBoolToObject(root, "admin_set", settings_admin_password_set());

    cJSON *wifi = cJSON_AddObjectToObject(root, "wifi");
    wifi_config_t cfg;
    char ssid[33] = "";
    if (esp_wifi_get_config(WIFI_IF_STA, &cfg) == ESP_OK) {
        strlcpy(ssid, (const char *)cfg.sta.ssid, sizeof(ssid));
    }
    cJSON_AddStringToObject(wifi, "ssid", ssid);
    esp_netif_ip_info_t ip;
    char ip_text[16] = "";
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif && esp_netif_get_ip_info(netif, &ip) == ESP_OK && ip.ip.addr != 0) {
        snprintf(ip_text, sizeof(ip_text), IPSTR, IP2STR(&ip.ip));
    }
    cJSON_AddStringToObject(wifi, "ip", ip_text);

    mike_settings_t mike;
    settings_get_mike(&mike);
    cJSON *m = cJSON_AddObjectToObject(root, "mike");
    cJSON_AddStringToObject(m, "host", mike.host);
    cJSON_AddNumberToObject(m, "port", mike.port);
    cJSON_AddStringToObject(m, "tls_name", mike.tls_name);
    cJSON_AddBoolToObject(m, "token_set", mike.token[0] != '\0');
    cJSON_AddBoolToObject(m, "connected", mike_link_connected());

    cJSON *c = cJSON_AddObjectToObject(root, "claude");
    cJSON_AddBoolToObject(c, "logged_in", usage_client_has_credentials());

    keyboard_stats_t kb;
    keyboard_input_stats(&kb);
    cJSON *k = cJSON_AddObjectToObject(root, "keyboard");
    cJSON_AddBoolToObject(k, "attached", kb.attached);
    cJSON_AddNumberToObject(k, "interfaces", kb.interfaces);
    cJSON_AddNumberToObject(k, "reports", kb.reports);
    cJSON_AddNumberToObject(k, "transfer_errors", kb.transfer_errors);
    cJSON_AddNumberToObject(k, "keys", kb.keys);
    cJSON_AddNumberToObject(k, "last_usage", kb.last_usage);
    return send_json(req, root);
}

/* ------------------------------------------------------------------- mike -- */

static esp_err_t mike_post(httpd_req_t *req)
{
    if (!authorized(req)) {
        return ESP_OK;
    }
    cJSON *root = read_json(req);
    if (root == NULL) {
        return ESP_OK;
    }
    mike_settings_t in = {0};
    const char *host = cJSON_GetStringValue(cJSON_GetObjectItem(root, "host"));
    const char *tls = cJSON_GetStringValue(cJSON_GetObjectItem(root, "tls_name"));
    const char *token = cJSON_GetStringValue(cJSON_GetObjectItem(root, "token"));
    cJSON *port = cJSON_GetObjectItem(root, "port");
    strlcpy(in.host, host ? host : "", sizeof(in.host));
    strlcpy(in.tls_name, tls ? tls : "", sizeof(in.tls_name));
    strlcpy(in.token, token ? token : "", sizeof(in.token));
    in.port = cJSON_IsNumber(port) && port->valueint > 0 && port->valueint < 65536 ? port->valueint : 3456;
    cJSON_Delete(root);

    if (settings_set_mike(&in) != ESP_OK) {
        return fail(req, "500 Internal Server Error", "Could not save.");
    }
    ESP_LOGI(TAG, "Mike settings saved, restarting");
    httpd_resp_sendstr(req, "OK");
    xTaskCreate(restart_task, "restart", 2048, NULL, 5, NULL);
    return ESP_OK;
}

/* ------------------------------------------------------------------ admin -- */

/*
 * The first admin password can be set from the web page, while none is set.
 * Without this a board whose keyboard does not work could never be given one,
 * and without one it refuses firmware updates: a board that locks itself out.
 * Once set, only the settings screen on the board changes it.
 */
static esp_err_t admin_post(httpd_req_t *req)
{
    if (settings_admin_password_set()) {
        return fail(req, "403 Forbidden", "An admin password is already set; change it on the board (F2).");
    }
    cJSON *root = read_json(req);
    if (root == NULL) {
        return ESP_OK;
    }
    const char *password = cJSON_GetStringValue(cJSON_GetObjectItem(root, "password"));
    esp_err_t err = ESP_ERR_INVALID_ARG;
    if (password != NULL && strlen(password) >= 6 && strlen(password) < 64) {
        err = settings_set_admin_password(password);
    }
    cJSON_Delete(root);
    if (err == ESP_ERR_INVALID_ARG) {
        return fail(req, "400 Bad Request", "At least 6 characters.");
    }
    if (err != ESP_OK) {
        return fail(req, "500 Internal Server Error", "Could not save.");
    }
    ESP_LOGI(TAG, "admin password set from the web page");
    return httpd_resp_sendstr(req, "OK");
}

/* ----------------------------------------------------------------- claude -- */

static esp_err_t claude_start_post(httpd_req_t *req)
{
    if (!authorized(req)) {
        return ESP_OK;
    }
    char url[512];
    if (usage_client_login_start(url, sizeof(url)) != ESP_OK) {
        return fail(req, "500 Internal Server Error", "Could not start the login.");
    }
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "url", url);
    return send_json(req, root);
}

static esp_err_t claude_finish_post(httpd_req_t *req)
{
    if (!authorized(req)) {
        return ESP_OK;
    }
    cJSON *root = read_json(req);
    if (root == NULL) {
        return ESP_OK;
    }
    const char *code = cJSON_GetStringValue(cJSON_GetObjectItem(root, "code"));
    char err[128] = "";
    esp_err_t ret = code && code[0] ? usage_client_login_finish(code, err, sizeof(err)) : ESP_ERR_INVALID_ARG;
    cJSON_Delete(root);
    if (ret != ESP_OK) {
        return fail(req, "400 Bad Request", err[0] ? err : "Paste the code first.");
    }
    return httpd_resp_sendstr(req, "OK");
}

/* --------------------------------------------------------------- firmware -- */

static esp_err_t update_post(httpd_req_t *req)
{
    if (!authorized(req)) {
        return ESP_OK;
    }

    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    if (target == NULL || req->content_len == 0 || req->content_len > target->size) {
        return fail(req, "400 Bad Request", target ? "Image missing or larger than the partition." : "No OTA partition.");
    }

    esp_ota_handle_t ota;
    esp_err_t err = esp_ota_begin(target, OTA_WITH_SEQUENTIAL_WRITES, &ota);
    if (err != ESP_OK) {
        return fail(req, "500 Internal Server Error", esp_err_to_name(err));
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
        return fail(req, "500 Internal Server Error", "Upload failed; the running firmware is unchanged.");
    }
    /* esp_ota_end validates the image (header, checksum, chip) before anything boots it. */
    err = esp_ota_end(ota);
    if (err == ESP_OK) {
        err = esp_ota_set_boot_partition(target);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "image rejected: %s", esp_err_to_name(err));
        char msg[96];
        snprintf(msg, sizeof(msg), "Image rejected (%s); the running firmware is unchanged.", esp_err_to_name(err));
        return fail(req, "400 Bad Request", msg);
    }

    ESP_LOGI(TAG, "written in %lld ms, restarting into %s", (esp_timer_get_time() - started) / 1000, target->label);
    httpd_resp_sendstr(req, "OK");
    xTaskCreate(restart_task, "ota_restart", 2048, NULL, 5, NULL);
    return ESP_OK;
}

/* ---------------------------------------------------------------- server -- */

void ota_server_start(void)
{
    if (mdns_init() == ESP_OK) {
        mdns_hostname_set(OTA_HOSTNAME);
        mdns_instance_name_set("Claude usage keyboard");
        mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0);
    }

    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.stack_size = 8192;
    cfg.recv_wait_timeout = 10;
    httpd_handle_t server = NULL;
    if (httpd_start(&server, &cfg) != ESP_OK) {
        ESP_LOGE(TAG, "web server did not start");
        return;
    }
    const httpd_uri_t routes[] = {
        {.uri = "/", .method = HTTP_GET, .handler = page_get},
        {.uri = "/info", .method = HTTP_GET, .handler = info_get},
        {.uri = "/api/mike", .method = HTTP_POST, .handler = mike_post},
        {.uri = "/api/admin", .method = HTTP_POST, .handler = admin_post},
        {.uri = "/api/claude/start", .method = HTTP_POST, .handler = claude_start_post},
        {.uri = "/api/claude/finish", .method = HTTP_POST, .handler = claude_finish_post},
        {.uri = "/update", .method = HTTP_POST, .handler = update_post},
    };
    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        httpd_register_uri_handler(server, &routes[i]);
    }
    ESP_LOGI(TAG, "settings page at http://%s.local/", OTA_HOSTNAME);
}
