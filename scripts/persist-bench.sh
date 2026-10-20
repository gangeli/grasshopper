#!/bin/sh
# Run the multi-session benchmark for homes <first>..<last> on 4 processes, then summarize.
#   sh scripts/persist-bench.sh <outdir> <first> <last> [bench options...]
out=$1
first=$2
last=$3
shift 3
mkdir -p "$out"
s=$first
while [ $s -le $last ]; do
  for k in 0 1 2 3; do
    seed=$((s + k))
    if [ $seed -le $last ]; then
      npx tsx scripts/persist-bench.ts --seeds $seed-$seed "$@" > "$out/home-$seed.log" 2>&1 &
    fi
  done
  wait
  s=$((s + 4))
done
python3 scripts/bench-summary.py "$out"/home-*.log
