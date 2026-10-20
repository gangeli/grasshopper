#!/bin/bash
# Large-area mapping suite: three homes walked in parallel; prints each report and a summary table.
# Usage: scripts/large-area-suite.sh <outdir> [profile=house] [seconds-scale=1]
# Env passes through to scripts/large-area.ts (NOISE, WALK, WORLD, DEPTH_EVERY, CAMERA, ...).
out=${1:-/tmp/large-area}; prof=${2:-house}; scale=${3:-1}
mkdir -p "$out"
runs=("10x12 1 600" "12x15 2 600" "15x20 3 900")
i=0
for r in "${runs[@]}"; do
  set -- $r
  secs=$(python3 -c "print(int($3*$scale))")
  QUIET=${QUIET:-} PNG="$out/house$i.png" JSON="$out/house$i.json" npx tsx scripts/large-area.ts $1 $2 $secs $prof > "$out/house$i.txt" 2>&1 &
  i=$((i+1))
done
wait
for f in "$out"/house*.txt; do echo "== $f"; tail -7 "$f"; done
python3 scripts/large-area-summary.py "$out"/house*.json
