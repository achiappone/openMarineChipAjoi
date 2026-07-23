#!/usr/bin/env bash
# Build an Android Auto head-unit receiver (aasdk + openauto) on the Pi, for a
# phone plugged in over USB (AOAP). Wired on purpose: it skips the 5GHz AP, the
# Bluetooth handshake and the wireless handshake Google keeps changing — and it
# leaves the Pi's wlan0 alone as the boat's network.
#
# NOTE: openauto's original Pi video path used the Broadcom OMX/MMAL stack, which
# Bookworm removed. We build with RPI3_BUILD=FALSE so video goes through Qt
# Multimedia/GStreamer instead. That is the part most likely to need work.
#
# CarPlay is NOT in scope here at any price: it needs Apple MFi authentication
# hardware, wired or wireless. Only a licensed dongle does CarPlay.
#
#   ssh openplotter 'bash -s' < scripts/android-auto-build.sh
set -uo pipefail

SRC=${SRC:-$HOME/build}
JOBS=${JOBS:-$(nproc)}
mkdir -p "$SRC"

echo "==> deps"
sudo apt-get update || echo "(apt update reported errors — continuing)"
sudo apt-get install -y --no-install-recommends \
  build-essential cmake git pkg-config \
  libboost-all-dev libusb-1.0-0-dev libssl-dev \
  protobuf-compiler libprotobuf-dev \
  qtbase5-dev qtmultimedia5-dev qtdeclarative5-dev qtconnectivity5-dev \
  libqt5multimedia5 libqt5multimedia5-plugins libqt5multimediawidgets5 \
  librtaudio-dev libtag1-dev \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav \
  gstreamer1.0-tools libqt5gstreamer-dev qtgstreamer-plugins-qt5 qml-module-qtgstreamer || {
    echo "!! dependency install failed"; exit 1; }

echo "==> aasdk"
cd "$SRC"
[ -d aasdk ] || git clone --depth 1 https://github.com/openDsh/aasdk.git
cd aasdk
# OpenSSL 3.0 (Bookworm) removed FIPS_mode_set(); aasdk still calls it. Guard it.
if grep -q 'FIPS_mode_set(0);' src/Transport/SSLWrapper.cpp && \
   ! grep -q 'OPENSSL_VERSION_NUMBER < 0x30000000L' src/Transport/SSLWrapper.cpp; then
  sed -i 's|^\( *\)FIPS_mode_set(0);|#if (OPENSSL_VERSION_NUMBER < 0x30000000L)\n\1FIPS_mode_set(0);\n#endif|' src/Transport/SSLWrapper.cpp
  echo "==> patched SSLWrapper.cpp for OpenSSL 3.0"
fi
mkdir -p build && cd build
cmake -DCMAKE_BUILD_TYPE=Release .. || { echo "!! aasdk cmake failed"; exit 1; }
make -j"$JOBS" || { echo "!! aasdk build failed"; exit 1; }
# openauto's Findaasdk.cmake looks for aasdk_proto/*.pb.h under the source root,
# but protoc generates the headers into build/aasdk_proto/. Copy them next to the
# .proto sources so find_path() resolves them.
cp -f "$SRC"/aasdk/build/aasdk_proto/*.pb.h "$SRC/aasdk/aasdk_proto/" 2>/dev/null
# openauto's Findaasdk.cmake hardcodes `set(AASDK_DIR ~/aasdk)`, which overrides any
# -DAASDK_DIR we pass, so give it exactly that path.
ln -sfn "$SRC/aasdk" "$HOME/aasdk"
echo "==> aasdk built"

# openauto links libh264bitstream, which Bookworm doesn't package — build it.
echo "==> h264bitstream"
sudo apt-get install -y autoconf libtool automake >/dev/null 2>&1
cd "$SRC"
[ -d h264bitstream ] || git clone --depth 1 https://github.com/aizvorski/h264bitstream.git
cd h264bitstream
if [ ! -f /usr/local/lib/libh264bitstream.so ]; then
  autoreconf -i && ./configure && make -j"$JOBS" && sudo make install && sudo ldconfig
fi
echo "==> h264bitstream installed"

echo "==> openauto"
cd "$SRC"
[ -d openauto ] || git clone --depth 1 https://github.com/openDsh/openauto.git
cd openauto
# GST_BUILD=ON selects GSTVideoOutput: it auto-picks v4l2h264dec (Pi4 hardware
# decode) and renders through a QtQuick sink that actually shows on Bookworm's X —
# the default Qt-Multimedia path picks vaapisink and renders black here.
rm -rf build && mkdir -p build && cd build
cmake -DCMAKE_BUILD_TYPE=Release -DGST_BUILD=ON \
  .. || { echo "!! openauto cmake failed"; exit 1; }
make -j"$JOBS" || { echo "!! openauto build failed"; exit 1; }

echo "==> built: $(ls -la "$SRC"/openauto/bin/autoapp 2>/dev/null || echo 'autoapp NOT FOUND')"
echo "==> done"
