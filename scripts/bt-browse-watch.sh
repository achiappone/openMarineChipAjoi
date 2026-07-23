#!/usr/bin/env bash
# Sample AVRCP browsing capability every few seconds and log one line per change.
# Run it, then play music in each app in turn (Apple Music, Spotify, YouTube Music,
# a local library player…) — the log shows what each app actually exposes, keyed by
# the player name AVRCP reports.
#
#   ssh openplotter 'bash -s' < scripts/bt-browse-watch.sh   (Ctrl-C to stop)
#   DURATION=300 INTERVAL=5 ...                              (defaults below)
set -uo pipefail
DURATION=${DURATION:-240}
INTERVAL=${INTERVAL:-5}

end=$((SECONDS + DURATION))
last=""
echo "time                 device        app                  status    folder items  cover"
while [ $SECONDS -lt $end ]; do
  for PL in $(busctl --system tree org.bluez | grep -o '/org/bluez/hci[0-9]*/dev_[0-9A-F_]*\(/avrcp\)\?/player[0-9]*'); do
    dev=${PL%%/avrcp*}; dev=${dev%%/player*}
    alias=$(busctl --system get-property org.bluez "$dev" org.bluez.Device1 Alias 2>/dev/null | sed 's/^s "//; s/"$//' | cut -c1-12)
    app=$(busctl --system get-property org.bluez "$PL" org.bluez.MediaPlayer1 Name 2>/dev/null | sed 's/^s "//; s/"$//' | cut -c1-19)
    status=$(busctl --system get-property org.bluez "$PL" org.bluez.MediaPlayer1 Status 2>/dev/null | sed 's/^s "//; s/"$//')
    port=$(busctl --system get-property org.bluez "$PL" org.bluez.MediaPlayer1 ObexPort 2>/dev/null | sed 's/^q //')
    kids=$(busctl --system tree org.bluez | grep -o "${PL}/[A-Za-z0-9_/]*" | sort -u)
    folder=$(busctl --system introspect org.bluez "$PL" 2>/dev/null | grep -c 'MediaFolder1')
    for k in $kids; do
      folder=$((folder + $(busctl --system introspect org.bluez "$k" 2>/dev/null | grep -c 'MediaFolder1')))
    done
    items=$(echo "$kids" | grep -c 'item[0-9]*$')
    line=$(printf '%-13s %-20s %-9s %-6s %-6s %s' "$alias" "${app:-?}" "${status:-?}" "$folder" "$items" "${port:-none}")
    # Only log transitions, so switching apps stands out in the noise.
    if [ "$line" != "$last" ]; then
      echo "$(date +%H:%M:%S)            $line"
      last="$line"
    fi
  done
  sleep "$INTERVAL"
done
echo "done."
