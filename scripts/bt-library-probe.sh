#!/usr/bin/env bash
# Actively drive AVRCP media browsing the way a car head unit does, and print the
# library tree the phone exposes. This is what proves whether a Bluetooth
# "browse by genre/album/artist/song" screen is buildable for a given phone+app.
#
# Why the earlier passive probe found nothing: BlueZ only registers
# org.bluez.MediaFolder1 once a browsing SCOPE exists, and the AVCTP browsing
# channel comes up a few seconds AFTER the audio connects. So we (a) wait for it,
# and (b) navigate into the Filesystem folder to force the scope — then enumerate.
#
# Read-only: it lists items and changes folders (browsing), it does NOT play
# anything or change any setting.
#
#   ssh openplotter 'bash -s' < scripts/bt-library-probe.sh
#
# Run it with the phone connected over Bluetooth and MUSIC PLAYING in the app you
# used in the car (ideally a local-library player, but try whatever you used).
set -uo pipefail

SYS="busctl --system"
prop() { $SYS get-property org.bluez "$1" "$2" "$3" 2>/dev/null; }
call() { $SYS call org.bluez "$1" "$2" "$3" "${@:4}" 2>&1; }

# --- find the connected player, waiting for the browsing channel to appear ---
PL=""
echo "Waiting for an AVRCP player (up to 20s)…"
for i in $(seq 1 20); do
  PL=$($SYS tree org.bluez | grep -o '/org/bluez/hci[0-9]*/dev_[0-9A-F_]*\(/avrcp\)\?/player[0-9]*' | head -1)
  [ -n "$PL" ] && break
  sleep 1
done
if [ -z "$PL" ]; then echo "No player found — is the phone connected and playing?"; exit 1; fi
echo "player: $PL"
echo "app:    $(prop "$PL" org.bluez.MediaPlayer1 Name | sed 's/^s //')"
echo "browsable: $(prop "$PL" org.bluez.MediaPlayer1 Browsable)"

# --- wait for BlueZ to register MediaFolder1 (browsing scope) on the player ---
echo "Waiting for the browsing channel / MediaFolder1 (up to 25s)…"
have_folder=""
for i in $(seq 1 25); do
  if $SYS introspect org.bluez "$PL" 2>/dev/null | grep -q 'org.bluez.MediaFolder1'; then
    have_folder=1; break
  fi
  # Nudge it: navigating to the Filesystem child forces the scope on many stacks.
  FS=$($SYS tree org.bluez | grep -o "${PL}/Filesystem" | head -1)
  [ -n "$FS" ] && call "$PL" org.bluez.MediaFolder1 ChangeFolder "o" "$FS" >/dev/null 2>&1
  sleep 1
done

if [ -z "$have_folder" ]; then
  echo
  echo "RESULT: MediaFolder1 never appeared — this phone/app is NOT exposing a"
  echo "browsable library over BlueZ right now. Child objects present:"
  $SYS tree org.bluez | grep -o "${PL}/[A-Za-z0-9_/]*" | sort -u | sed 's/^/  /'
  exit 0
fi

echo "MediaFolder1 present — enumerating the library root…"
echo

# --- list an item's key fields ---
show_item() {
  local it=$1 indent=$2
  local meta name type ftype
  name=$(prop "$it" org.bluez.MediaItem1 Name | sed 's/^s "//; s/"$//')
  type=$(prop "$it" org.bluez.MediaItem1 Type | sed 's/^s "//; s/"$//')
  ftype=$(prop "$it" org.bluez.MediaItem1 FolderType 2>/dev/null | sed 's/^s "//; s/"$//')
  meta=$(prop "$it" org.bluez.MediaItem1 Metadata 2>/dev/null | grep -o '"Title" s "[^"]*"\|"Artist" s "[^"]*"' | tr '\n' ' ')
  printf '%s%-9s %-11s %s %s\n' "$indent" "${type:-?}" "${ftype:-}" "$name" "$meta"
}

# ListItems triggers a fetch; the items then appear as child objects in the tree.
list_scope() {
  local indent=$1
  call "$PL" org.bluez.MediaFolder1 ListItems "a{sv}" 0 >/dev/null 2>&1
  sleep 1
  $SYS tree org.bluez | grep -oE "${PL}/(Filesystem|NowPlaying)(/item[0-9]+)+" | sort -u | while read -r it; do
    show_item "$it" "$indent"
  done
}

echo "=== LIBRARY ROOT (the genre/album/artist/song categories) ==="
list_scope "  "

echo
echo "=== drilling one level into the first folder ==="
FIRST=$($SYS tree org.bluez | grep -oE "${PL}/Filesystem/item[0-9]+" | sort -u | head -1)
if [ -n "$FIRST" ] && [ "$(prop "$FIRST" org.bluez.MediaItem1 Type | sed 's/^s //')" = '"folder"' ]; then
  echo "into: $(prop "$FIRST" org.bluez.MediaItem1 Name | sed 's/^s //')"
  call "$PL" org.bluez.MediaFolder1 ChangeFolder "o" "$FIRST" >/dev/null 2>&1
  sleep 1
  list_scope "    "
else
  echo "(first root entry isn't a navigable folder)"
fi

echo
echo "Done. If categories and items printed above, a Bluetooth library-browse"
echo "screen is buildable on this data."
