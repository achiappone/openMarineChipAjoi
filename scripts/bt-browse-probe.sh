#!/usr/bin/env bash
# What does the connected phone actually expose over AVRCP browsing?
#
# AVRCP browsing (MediaFolder1 / MediaItem1) is wildly inconsistent: it depends on
# the phone, the media app, and whether the browsing channel happens to be up. Run
# this while each app is PLAYING to capture what's really there, instead of
# designing a browse UI against assumptions.
#
#   ssh openplotter 'bash -s' < scripts/bt-browse-probe.sh
#
# Run it once per app (Apple Music, Spotify, YouTube Music, a local player…) and
# compare. The "browsing" verdict at the end is what a browse screen would need.
set -uo pipefail

for PL in $(busctl --system tree org.bluez | grep -o '/org/bluez/hci[0-9]*/dev_[0-9A-F_]*\(/avrcp\)\?/player[0-9]*'); do
  dev=${PL%%/avrcp*}; dev=${dev%%/player*}
  name=$(busctl --system get-property org.bluez "$dev" org.bluez.Device1 Alias 2>/dev/null | sed 's/^s //')
  echo "==================================================================="
  echo "device : $name"
  echo "player : $PL"
  for p in Name Status Browsable Searchable ObexPort; do
    v=$(busctl --system get-property org.bluez "$PL" org.bluez.MediaPlayer1 $p 2>/dev/null) || v="(absent)"
    printf '  %-11s %s\n' "$p" "$v"
  done

  echo "  interfaces:"
  busctl --system introspect org.bluez "$PL" 2>/dev/null | grep 'interface' | awk '{print "    " $1}'

  echo "  child objects:"
  # busctl tree draws box characters before each path, so match the path itself.
  kids=$(busctl --system tree org.bluez | grep -o "${PL}/[A-Za-z0-9_/]*" | sort -u)
  [ -z "$kids" ] && echo "    (none)"
  for k in $kids; do
    ifaces=$(busctl --system introspect org.bluez "$k" 2>/dev/null | grep 'interface' | grep '^org.bluez' | awk '{print $1}' | tr '\n' ' ')
    typ=$(busctl --system get-property org.bluez "$k" org.bluez.MediaItem1 Type 2>/dev/null | sed 's/^s //')
    ttl=$(busctl --system get-property org.bluez "$k" org.bluez.MediaItem1 Metadata 2>/dev/null | grep -o '"Title" s "[^"]*"' | head -1)
    echo "    ${k##*/}  type=${typ:-?}  ifaces=${ifaces:-none}  ${ttl}"
  done

  # The verdict: a browse screen needs MediaFolder1 somewhere to enumerate items.
  folder=$(busctl --system introspect org.bluez "$PL" 2>/dev/null | grep -c 'MediaFolder1')
  for k in $kids; do
    n=$(busctl --system introspect org.bluez "$k" 2>/dev/null | grep -c 'MediaFolder1')
    folder=$((folder + n))
  done
  items=$(echo "$kids" | grep -c 'item[0-9]*$')
  echo "  VERDICT: MediaFolder1 interfaces=$folder, listed items=$items"
  if [ "$folder" -gt 0 ]; then
    echo "           -> browsable: a Queue/Library screen is possible for this app"
  elif [ "$items" -gt 1 ]; then
    echo "           -> queue only: upcoming tracks visible, no folder navigation"
  else
    echo "           -> now-playing only: no browse screen possible for this app"
  fi
done
