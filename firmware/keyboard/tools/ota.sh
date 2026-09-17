#!/usr/bin/env bash
# Upload build/claude_usage_monitor.bin to the board over WiFi.
#
#   tools/ota.sh [host]        host defaults to claude-usage.local
#
# The password is the admin password set on the board (F2): taken from
# $KEYBOARD_ADMIN_PASSWORD, or asked for. Run `idf.py build` first.
set -euo pipefail

cd "$(dirname "$0")/.."
host="${1:-claude-usage.local}"
image=build/claude_usage_monitor.bin
[ -f "$image" ] || { echo "$image not found; run idf.py build" >&2; exit 1; }

password="${KEYBOARD_ADMIN_PASSWORD:-}"
if [ -z "$password" ]; then
  read -r -s -p "Admin password for $host: " password
  echo
fi

echo "Uploading $image ($(stat -c %s "$image") bytes) to $host"
curl --fail-with-body --show-error --silent --max-time 180 \
  -H "X-Admin-Password: $password" \
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
