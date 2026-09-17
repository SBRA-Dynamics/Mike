#pragma once

/* secrets.h, with defaults for anything an older copy of it does not define. */

#include "secrets.h"

#ifndef MIKE_HOST
#define MIKE_HOST ""
#endif
#ifndef MIKE_PORT
#define MIKE_PORT 3456
#endif
#ifndef MIKE_TLS_NAME
#define MIKE_TLS_NAME ""
#endif
#ifndef MIKE_TOKEN
#define MIKE_TOKEN ""
#endif
#ifndef KEYBOARD_SERIAL_TEST
#define KEYBOARD_SERIAL_TEST 0
#endif
#ifndef KEYBOARD_DEBUG
#define KEYBOARD_DEBUG 0
#endif
/* Mike's env file wins over secrets.h (main/CMakeLists.txt passes it in). */
#ifdef MIKE_ENV_OTA_PASSWORD
#undef OTA_PASSWORD
#define OTA_PASSWORD MIKE_ENV_OTA_PASSWORD
#endif
#ifndef OTA_PASSWORD
#define OTA_PASSWORD ""
#endif
#ifndef OTA_HOSTNAME
#define OTA_HOSTNAME "claude-usage"
#endif
#ifndef OTA_CONFIRM_S
#define OTA_CONFIRM_S 90
#endif
