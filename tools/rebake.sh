#!/usr/bin/env bash
# THE way to re-bake assets. Use this, never bake_meshy_props.py on its own.
#
# bake_meshy_props.py rebuilds ALL 20 assets from their GLBs, which silently
# throws away every post-bake pass. That bit us twice in one session: a taxi
# re-bake reverted the turtle's authored shell pattern and the cars' hue match,
# and the game shipped looking unchanged. The passes are not optional polish -
# they are part of what the asset IS - so they belong in one ordered script.
#
# Order matters. Decimation happens inside the bake (before the vertex-colour
# sample); the weld runs next so later passes work on final vertices; the colour
# match reads the reference plates; the detail pass authors what the sources
# never had and must come last so nothing overwrites it.
set -euo pipefail
cd "$(dirname "$0")/.."
BLENDER=/Applications/Blender.app/Contents/MacOS/Blender

echo "== 1/4 bake GLB -> JSON =="
REBAKE_PIPELINE=1 "$BLENDER" -b -noaudio --python tools/bake_meshy_props.py 2>&1 | grep -E "^  (wrote|scaled|fv-|dio-)|ALL_BAKED|Error|Traceback" || true

echo "== 2/4 quantise + weld =="
python3 tools/optimize-models.py --apply 'assets/models/fv/*.json' 'assets/models/diorama/*.json' | tail -2

echo "== 3/4 match reference colours =="
python3 tools/match-reference-colors.py --apply

echo "== 4/4 author missing detail =="
python3 tools/detail-pass.py --apply

echo "== done. verify with: node tools/zoom-render.js <asset> =="
