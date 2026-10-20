#!/bin/sh
# Run relocalization trials on 4 processes: persist-trials.sh <outdir> <first> <last>
out=$1
first=$2
last=$3
mkdir -p "$out"
n=$(( (last - first + 1 + 3) / 4 ))
for k in 0 1 2 3; do
  a=$(( first + k * n ))
  b=$(( a + n - 1 ))
  if [ $b -gt $last ]; then b=$last; fi
  npx tsx scripts/persist-trials.ts $a $b > "$out/trials-$k.jsonl" 2> "$out/trials-$k.err" &
done
wait
cat "$out"/trials-*.jsonl | wc -l
