#!/bin/bash
# Launch openMarine Helm full-screen (Chromium kiosk) on the Pi's display.
# Optional arg = initial view: plotter | instruments | stereo | instr-stereo | all.
# Lives on the Pi at /home/pi/helm-launch.sh; the desktop icon calls it.
export DISPLAY=:0
export XAUTHORITY=/home/pi/.Xauthority
URL="http://localhost:3000/openmarine-helm/"
[ -n "$1" ] && URL="${URL}#$1"
# Kill only a prior kiosk chromium. Pattern is specific ('chromium-browser.*helm-kiosk')
# so it never matches the launching shell (a bare 'helm-kiosk' pattern self-matches
# any command line that mentions the profile dir or logfile, killing itself).
pkill -f "chromium-browser.*helm-kiosk" 2>/dev/null
sleep 1
exec chromium-browser --kiosk "$URL" \
  --user-data-dir=/home/pi/.config/helm-kiosk \
  --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble
