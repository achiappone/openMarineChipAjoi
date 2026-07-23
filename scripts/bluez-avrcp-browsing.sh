#!/usr/bin/env bash
# Patch BlueZ's AVRCP controller so it can BROWSE a phone's music library over
# Bluetooth (categories: Playlists / Artists / Albums / Genres / Songs), the way a
# factory car head unit does. Applies scripts/bluez-avrcp-browsing.patch to the
# BlueZ source built by bluez-cover-art.sh, rebuilds, and restarts bluetoothd.
#
# Why it's needed: stock BlueZ 5.86 never starts AVRCP browsing for phones (like the
# Pixel) that don't proactively push an AvailablePlayersChanged notification AND that
# expose their real media player as id 0. The patch makes three changes to
# profiles/audio/avrcp.c:
#   1. session_init_browsing(): proactively GetFolderItems(player list) when the
#      browsing channel connects, instead of waiting for a notification.
#   2. set_browsed_player(): allow player id 0 (gate on the browsable flag only) —
#      some phones legitimately use id 0 as their real browsable player.
#   3. after the player list arrives, call set_browsed_player() so SetBrowsedPlayer
#      is actually sent, which registers org.bluez.MediaFolder1 (ListItems/ChangeFolder).
#
# Run ON the Pi, after bluez-cover-art.sh has built BlueZ:
#   ssh openplotter 'bash -s' < scripts/bluez-avrcp-browsing.sh
# (copy the .patch alongside, or the script fetches it relative to $SRC)
set -uo pipefail

SRC=${SRC:-$HOME/build}
BLUEZ_VER=${BLUEZ_VER:-5.86}
BZ="$SRC/bluez-${BLUEZ_VER}"
PATCH=${PATCH:-$HOME/bluez-avrcp-browsing.patch}

[ -d "$BZ" ] || { echo "!! BlueZ source not found at $BZ (run bluez-cover-art.sh first)"; exit 1; }
[ -f "$PATCH" ] || { echo "!! patch not found at $PATCH"; exit 1; }

cd "$BZ/profiles/audio"
# Idempotent: skip if already applied (the id==0 guard is already gone).
if grep -q 'id==0 is allowed' avrcp.c; then
  echo "==> patch already applied"
else
  cp -n avrcp.c avrcp.c.orig 2>/dev/null || true
  patch -N avrcp.c < "$PATCH" || { echo "!! patch failed to apply"; exit 1; }
  echo "==> patch applied"
fi

cd "$BZ"
make -j"$(nproc)" || { echo "!! build failed"; exit 1; }
sudo make install >/dev/null 2>&1
sudo systemctl daemon-reload
sudo systemctl restart bluetooth
echo "==> patched bluetoothd installed and restarted"
echo "    Reconnect the phone FROM THE PHONE, then check:"
echo "    busctl --system introspect org.bluez /org/bluez/hci0/dev_<MAC>/avrcp/player0 | grep MediaFolder1"
