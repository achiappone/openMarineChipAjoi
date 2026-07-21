#!/bin/bash
# Launch openMarine Helm full-screen (Chromium kiosk). Optional arg = initial view.
export DISPLAY=:0
export XAUTHORITY=/home/pi/.Xauthority
URL="http://localhost:3000/openmarine-helm/"
[ -n "$1" ] && URL="${URL}#$1"
pkill -f "chromium-browser.*helm-kiosk" 2>/dev/null
sleep 1
# Hide the mouse cursor on the touchscreen (system-wide, incl. embedded apps).
pkill -x unclutter 2>/dev/null
setsid unclutter -idle 0 -root >/dev/null 2>&1 </dev/null &
rm -f /home/pi/.config/helm-kiosk/Singleton* 2>/dev/null
exec chromium-browser --kiosk "$URL" \
  --user-data-dir=/home/pi/.config/helm-kiosk \
  --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble
