#!/usr/bin/env bash
# Upload build/claude_usage_monitor.bin to the board over WiFi.
#
#   tools/ota.sh [host]        host defaults to OTA_HOSTNAME.local from main/secrets.h
#
# The password is MIKE_KEYBOARD_OTA_PASSWORD from Mike's env file
# (~/.config/mike/env, or $MIKE_ENV). Run `idf.py build` first.
set -euo pipefail

cd "$(dirname "$0")/.."
secret() { sed -n "s/^#define $1 \"\(.*\)\"/\1/p" main/secrets.h; }

env_file="${MIKE_ENV:-$HOME/.config/mike/env}"
password="$(sed -n 's/^MIKE_KEYBOARD_OTA_PASSWORD=//p' "$env_file" 2>/dev/null | tail -1)"
host="${1:-$(secret OTA_HOSTNAME).local}"
image=build/claude_usage_monitor.bin

[ -n "$password" ] || { echo "MIKE_KEYBOARD_OTA_PASSWORD is not set in $env_file" >&2; exit 1; }
[ -f "$image" ] || { echo "$image not found; run idf.py build" >&2; exit 1; }

echo "Uploading $image ($(stat -c %s "$image") bytes) to $host"
curl --fail-with-body --show-error --silent --max-time 180 \
  -H "X-OTA-Password: $password" \
  --data-binary @"$image" \
  "http://$host/update"
echo

# Wait for the board to come back and say what it runs.
for _ in $(seq 1 45); do
  sleep 2
  if info="$(curl --silent --max-time 2 "http://$host/info")"; then
    echo "Running: $info"
    exit 0
  fi
done
echo "The board did not come back within 90 s; if the image cannot reach WiFi it rolls back by itself." >&2
exit 1
