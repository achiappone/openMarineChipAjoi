#!/usr/bin/env bash
# Build a modern BlueZ on the Pi so the stereo can pull album art straight off the
# phone over Bluetooth (AVRCP 1.6 cover art = BIP over OBEX). No internet needed at
# playback time, and it works for any app on the phone, not just Apple Music.
#
# Why: Bookworm ships BlueZ 5.66, which has no OBEX/BIP client. The bits the stereo
# service needs — MediaPlayer1.ObexPort, Track.ImgHandle, org.bluez.obex.Image1 —
# only landed upstream in 5.79, and all three are experimental interfaces.
#
# Binaries install into /usr/local, but note `make install` DOES overwrite the
# distro's obex user unit (/usr/lib/systemd/user/obex.service) to point at the new
# obexd. To roll back to Bookworm's 5.66:
#
#   sudo rm -f /etc/systemd/system/bluetooth.service.d/cover-art.conf
#   sudo apt-get install --reinstall bluez bluez-obexd
#   sudo systemctl daemon-reload && sudo systemctl restart bluetooth
#
# Note the stereo service reads BlueZ over busctl (D-Bus), not `bluetoothctl
# devices` — from 5.8x that prints nothing when run non-interactively.
#
# Run it ON the Pi:  ssh openplotter 'bash -s' < scripts/bluez-cover-art.sh
set -euo pipefail

BLUEZ_VER=${BLUEZ_VER:-5.86}
ELL_VER=${ELL_VER:-0.83}
SRC=${SRC:-$HOME/build}
JOBS=${JOBS:-$(nproc)}

echo "==> building bluez ${BLUEZ_VER} (ell ${ELL_VER}) into /usr/local"
# Non-fatal: the Pi carries a dead nodesource repo, and one stale source shouldn't
# stop the build — the install below is what actually has to succeed.
sudo apt-get update || echo "(apt-get update reported errors — continuing)"
sudo apt-get install -y build-essential pkg-config curl xz-utils \
  libdbus-1-dev libglib2.0-dev libudev-dev libical-dev libreadline-dev \
  libjson-c-dev libsystemd-dev python3-docutils

mkdir -p "$SRC"

# ell: bluez needs a newer one than the distro has, so build it too and link against
# it with --enable-external-ell.
cd "$SRC"
[ -d "ell-${ELL_VER}" ] || {
  curl -fsSLO "https://mirrors.edge.kernel.org/pub/linux/libs/ell/ell-${ELL_VER}.tar.xz"
  tar xf "ell-${ELL_VER}.tar.xz"
}
cd "ell-${ELL_VER}"
./configure --prefix=/usr/local
make -j"$JOBS"
sudo make install
sudo ldconfig

cd "$SRC"
[ -d "bluez-${BLUEZ_VER}" ] || {
  curl -fsSLO "https://mirrors.edge.kernel.org/pub/linux/bluetooth/bluez-${BLUEZ_VER}.tar.xz"
  tar xf "bluez-${BLUEZ_VER}.tar.xz"
}
cd "bluez-${BLUEZ_VER}"
PKG_CONFIG_PATH=/usr/local/lib/pkgconfig ./configure \
  --prefix=/usr/local --sysconfdir=/etc --localstatedir=/var \
  --enable-experimental --enable-external-ell \
  --enable-obex --enable-client --enable-tools --enable-library \
  --disable-manpages
make -j"$JOBS"
sudo make install
sudo ldconfig

# ObexPort and ImgHandle are experimental interfaces, so bluetoothd needs the
# runtime switch. obexd has no such flag — its Image1 interface is compiled in by
# the --enable-experimental above — so it just needs to be the new binary, which
# `make install` already wired into the unit and the D-Bus activation file.
echo "==> enabling experimental interfaces on bluetoothd"
sudo install -d /etc/systemd/system/bluetooth.service.d
sudo tee /etc/systemd/system/bluetooth.service.d/cover-art.conf >/dev/null <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/local/libexec/bluetooth/bluetoothd --experimental
EOF
sudo rm -rf /etc/systemd/user/obex.service.d

sudo systemctl daemon-reload
systemctl --user daemon-reload || true
sudo systemctl restart bluetooth
systemctl --user restart obex 2>/dev/null || true

echo "==> installed: $(/usr/local/libexec/bluetooth/bluetoothd -v)"
echo "==> running:   $(bluetoothctl --version)"
cat <<'EOF'

Next: reconnect the phone, start playback, then check that the cover-art channel
came up (both should print a value, not an error):

  busctl --system get-property org.bluez \
    "$(busctl --system tree org.bluez | grep -o '/org/bluez/hci[0-9]*/dev_[^ ]*/player[0-9]*' | head -1)" \
    org.bluez.MediaPlayer1 ObexPort

  systemctl restart stereo-service   # picks the art up on the next track poll
EOF
