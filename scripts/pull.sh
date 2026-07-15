#!/usr/bin/env bash
# Copy live config off the Pi into this repo, so the repo reflects reality.
# Run this before editing, and after any change made through the OpenPlotter GUI.
set -euo pipefail

HOST="${HOST:-openplotter}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Files we track. Repo path mirrors the Pi's absolute path under pi/.
FILES=(
  /boot/firmware/config.txt
  /boot/firmware/cmdline.txt
  /home/pi/.signalk/settings.json
  /home/pi/.signalk/package.json
)

for f in "${FILES[@]}"; do
  dest="pi${f}"
  mkdir -p "$(dirname "$dest")"
  if scp -q "${HOST}:${f}" "$dest" 2>/dev/null; then
    echo "  pulled  ${f}"
  else
    echo "  MISSING ${f} (not on Pi yet)"
  fi
done

# interfaces.d is a directory and starts out empty; mirror it wholesale.
rm -rf pi/etc/network/interfaces.d
mkdir -p pi/etc/network/interfaces.d
if ssh -o BatchMode=yes "$HOST" 'ls -A /etc/network/interfaces.d/ 2>/dev/null' | grep -q .; then
  scp -q "${HOST}:/etc/network/interfaces.d/*" pi/etc/network/interfaces.d/
  echo "  pulled  /etc/network/interfaces.d/*"
else
  echo "  empty   /etc/network/interfaces.d"
fi

echo
git status --short
