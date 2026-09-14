#!/usr/bin/env bash
# Scientifically clean eyes-in-the-loop run: Astra LOW for EVERY round,
# including the initial spec (an earlier run started from a HIGH spec, which
# confounded the comparison).
#
# Each round: eyes (Astra low) -> numeric spec JSON -> hands (Blender build)
# -> render -> back to the eyes. Astra's own 1-10 score for the previous
# render comes back with each correction; Luna low gives a final independent
# score. All eyes calls go through tools/astra_eyes.py, which retries once on
# malformed JSON (measured failure: a hallucinated token inside a number).
#
# !! Always pass a FULLY QUALIFIED model id (provider/id). A bare id such as
# !! "claude-opus-5" resolves to the VENICE provider and spends real Venice
# !! credits - that happened once (2026-09-09) and is not authorized.
# !! Use openai-codex/gpt-6-astra, deepseek-api/..., or an explicitly agreed route.
#
# Usage: bash tools/eyes-loop.sh [rounds] [eyes-model] [tag-prefix] [thinking]
#   e.g. bash tools/eyes-loop.sh 3 claude-opus-5 opus-high high
#        bash tools/eyes-loop.sh 3 openai-codex/gpt-6-astra astra low
set -euo pipefail
ROOT="$HOME/Developer/funkys-burnquest"
cd "$ROOT"
ROUNDS="${1:-3}"
EYES_MODEL="${2:-openai-codex/gpt-6-astra}"
TAGP="${3:-low}"
THINK="${4:-low}"
LOG="$ROOT/test-shots/car/loop-${TAGP}.log"
: > "$LOG"

IMGS=(
  "$ROOT/test-shots/pipeline-car/00-canonical-34-sunset.jpg"
  "$ROOT/test-shots/pipeline-car/04-blender-ortho-side.jpg"
  "$ROOT/test-shots/pipeline-car/03-blender-ortho-front.jpg"
)

echo "=== eyes-in-the-loop: $ROUNDS rounds | eyes=$EYES_MODEL (thinking $THINK) ===" | tee -a "$LOG"

for r in $(seq 1 "$ROUNDS"); do
  tag="$TAGP-r$r"
  spec="test-shots/car/spec-$tag.json"

  echo "--- round $r: eyes ($EYES_MODEL $THINK) ---" | tee -a "$LOG"
  t0=$(date +%s)
  if [ "$r" -eq 1 ]; then
    python3 tools/eyes_spec.py "$spec" /tmp/spec-prompt.txt "${IMGS[@]}" \
        --model "$EYES_MODEL" --thinking low 2>&1 | tee -a "$LOG"
  else
    python3 tools/eyes_spec.py "$spec" /tmp/correct3-prompt.txt "${IMGS[@]}" \
        "$ROOT/test-shots/car/spec-three-quarter-$TAGP-r$((r-1)).png" \
        --model "$EYES_MODEL" --thinking "$THINK" 2>&1 | tee -a "$LOG"
  fi
  t1=$(date +%s)
  echo "  eyes took $((t1-t0))s" | tee -a "$LOG"

  echo "--- round $r: hands (Blender build) ---" | tee -a "$LOG"
  /Applications/Blender.app/Contents/MacOS/Blender -b -t 4 --python tools/make_car_spec.py \
      -- "$spec" "$tag" 2>&1 | grep -E 'SPECSTATS' | tee -a "$LOG"
done

echo "--- independent score (Luna low) on final render ---" | tee -a "$LOG"
FINAL="$ROOT/test-shots/car/spec-three-quarter-$TAGP-r$ROUNDS.png"
omp --model 'openai-codex/gpt-5.6-luna' --thinking low -p --no-session --hide-thinking \
    --max-time 300 "@${IMGS[0]}" "@$FINAL" \
    'Image 1 = reference car design. Image 2 = a Blender model. Score it 1-10 for match and name the single biggest mismatch in one sentence. Nothing else.' \
    2>&1 | tail -3 | tee -a "$LOG"
echo "=== done: renders are test-shots/car/spec-*-$TAGP-r*.png ===" | tee -a "$LOG"
