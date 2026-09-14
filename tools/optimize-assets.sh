#!/usr/bin/env bash
# Resize + recompress the sprite set. Run from the repo root: bash tools/optimize-assets.sh
#
# The source PNGs are 1024-1536px, 2.1-2.9MB each, but the largest thing ever
# drawn on screen is a ~2-tile truck: ~222 CSS px on an ultrawide, ~444 device px
# at DPR 2. 512px is therefore already generous headroom, and the originals are
# roughly 25x larger than anything the game can display.
#
# Originals stay in git history (commit 13ed229, Mimi's untouched baseline).
set -euo pipefail
MAX=512
cd "$(dirname "$0")/.."
before=$(du -sk assets/images | cut -f1)
for f in assets/images/*.png; do
  w=$(sips -g pixelWidth "$f" | awk '/pixelWidth/{print $2}')
  h=$(sips -g pixelHeight "$f" | awk '/pixelHeight/{print $2}')
  big=$(( w > h ? w : h ))
  if [ "$big" -gt "$MAX" ]; then
    sips -Z "$MAX" "$f" --out "$f" >/dev/null
  fi
done
after=$(du -sk assets/images | cut -f1)
printf 'assets/images: %s KB -> %s KB  (%.1fx smaller)\n' "$before" "$after" \
  "$(echo "$before/$after" | bc -l)"
