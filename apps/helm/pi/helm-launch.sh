#!/bin/bash
# Launch openMarine Helm full-screen (Chromium kiosk) on the Pi's display.
# Optional arg = initial view: plotter | instruments | stereo | instr-stereo | all.
# Lives on the Pi at /home/pi/helm-launch.sh; the desktop icon calls it.
export DISPLAY=:0
export XAUTHORITY=/home/pi/.Xauthority
URL="http://localhost:3000/openmarine-helm/"
[ -n "$1" ] && URL="${URL}#$1"
# Kill only a prior kiosk chromium (specific pattern so it never self-matches a shell).
pkill -f "chromium-browser.*helm-kiosk" 2>/dev/null
sleep 1
# Clear stale single-instance locks: a crashed chromium leaves these behind and
# the next launch then opens a blank window or none at all.
rm -f /home/pi/.config/helm-kiosk/Singleton* 2>/dev/null
exec chromium-browser --kiosk "$URL" \
  --user-data-dir=/home/pi/.config/helm-kiosk \
  --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble
