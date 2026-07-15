#!/usr/bin/env bash
# Push tracked config from this repo to the Pi.
# Shows a diff and asks before writing. Backs up every file it replaces.
#
#   ./scripts/deploy.sh            # diff only, changes nothing
#   ./scripts/deploy.sh --apply    # actually write
set -euo pipefail

HOST="${HOST:-openplotter}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true

STAMP="$(git log -1 --format=%h 2>/dev/null || echo nogit)"

changed=0
while IFS= read -r local; do
  remote="${local#pi}"

  # Diff against the live file. `|| true` because diff exits 1 when files differ.
  # -n is load-bearing: without it ssh drains the loop's stdin and we silently
  # process only the first file.
  d=$(ssh -n -o BatchMode=yes "$HOST" "cat '$remote' 2>/dev/null" | diff -u --label "PI:$remote" - --label "REPO:$remote" "$local" || true)

  if [[ -z "$d" ]]; then
    echo "  same    $remote"
    continue
  fi

  changed=$((changed + 1))
  echo
  echo "=== $remote ==="
  echo "$d"

  if $APPLY; then
    # Back up, then write via sudo tee since /boot and /etc need root.
    ssh -o BatchMode=yes "$HOST" \
      "sudo cp -a '$remote' '${remote}.bak-${STAMP}' 2>/dev/null || true; sudo tee '$remote' >/dev/null" < "$local"
    echo "--- WROTE $remote (backup: ${remote}.bak-${STAMP})"
  fi
done < <(find pi -type f | sort)

echo
if (( changed == 0 )); then
  echo "Pi already matches the repo."
elif $APPLY; then
  echo "Applied $changed file(s). A reboot is required for /boot/firmware/config.txt to take effect."
else
  echo "$changed file(s) differ. Nothing was written — re-run with --apply to write."
fi
