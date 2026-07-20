#!/usr/bin/env bash
# Sync an app folder to the Pi, then optionally install deps and run/restart it.
#
# This is the CODE deploy loop. System config files (/boot, /etc) still go
# through deploy.sh; this script is for things that RUN on the Pi (SignalK
# plugins, webapps, standalone services/scripts).
#
# Each app lives in apps/<name>/ and carries a deploy.env describing where it
# goes on the Pi and how to activate it:
#
#     REMOTE_DIR="/home/pi/apps/<name>"     # required: where it lands on the Pi
#     INSTALL="npm install --omit=dev"      # optional: run in REMOTE_DIR after sync
#     RUN="node index.js"                   # optional: command to run the new code
#     LOGS="journalctl -u signalk -n 60 -f" # optional: how to follow its output
#
# Usage:
#     ./scripts/dev.sh <app>          # dry run: show what WOULD sync, change nothing
#     ./scripts/dev.sh <app> --push   # sync the files for real
#     ./scripts/dev.sh <app> --run    # sync, run INSTALL (if set), then RUN
#     ./scripts/dev.sh <app> --logs   # follow the app's logs (LOGS)
set -euo pipefail

HOST="${HOST:-openplotter}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

app="${1:-}"
mode="${2:---dry}"
[[ -z "$app" ]] && { echo "usage: dev.sh <app> [--push|--run|--logs]"; exit 2; }

appdir="apps/$app"
[[ -d "$appdir" ]] || { echo "no such app: $appdir"; exit 2; }
envfile="$appdir/deploy.env"
[[ -f "$envfile" ]] || { echo "missing $envfile (see scripts/dev.sh header)"; exit 2; }

# deploy.env sets: REMOTE_DIR (required), INSTALL / RUN / LOGS (optional).
REMOTE_DIR=""; INSTALL=""; RUN=""; LOGS=""
# shellcheck disable=SC1090
source "$envfile"
[[ -n "$REMOTE_DIR" ]] || { echo "$envfile must set REMOTE_DIR"; exit 2; }

# Never ship local deps or VCS/editor cruft. Deps install on the Pi because its
# node is v18 and native modules must be built there, not on this Mac (v25).
# rsync protects excluded paths from --delete, so the Pi's node_modules survives.
EXCLUDES=(--exclude '.git' --exclude 'node_modules' --exclude '.DS_Store' --exclude 'deploy.env')

do_sync() { # $@ = extra rsync flags (e.g. --dry-run)
  rsync -az --delete --itemize-changes "${EXCLUDES[@]}" "$@" \
    -e "ssh -o BatchMode=yes" \
    "$appdir/" "$HOST:$REMOTE_DIR/"
}

case "$mode" in
  --dry)
    echo "DRY RUN   $appdir/  ->  $HOST:$REMOTE_DIR/"
    ssh -n -o BatchMode=yes "$HOST" "mkdir -p '$REMOTE_DIR'"   # so rsync has a target to compare
    do_sync --dry-run
    echo "(nothing written — re-run with --push to sync, or --run to sync + activate)"
    ;;
  --push|--run)
    ssh -n -o BatchMode=yes "$HOST" "mkdir -p '$REMOTE_DIR'"
    do_sync
    echo "--- synced to $HOST:$REMOTE_DIR"
    if [[ "$mode" == "--run" ]]; then
      [[ -n "$INSTALL" ]] && { echo "--- install: $INSTALL"; ssh -o BatchMode=yes "$HOST" "cd '$REMOTE_DIR' && $INSTALL"; }
      [[ -n "$RUN" ]]     && { echo "--- run: $RUN";         ssh -o BatchMode=yes "$HOST" "$RUN"; }
      echo "--- done"
    fi
    ;;
  --logs)
    [[ -n "$LOGS" ]] || { echo "$envfile sets no LOGS command"; exit 2; }
    exec ssh -o BatchMode=yes "$HOST" "$LOGS"
    ;;
  *) echo "unknown mode: $mode (use --push, --run, or --logs)"; exit 2 ;;
esac
