#!/bin/bash
# Fault-injection soak over several rooms/seeds in parallel, then a summary.
# Usage: scripts/soak-batch.sh <outdir> [seconds] [faults] [every-json]
out=$1; secs=${2:-300}; faults=${3:-}; every=${4:-'[60,90]'}
mkdir -p $out
run() { EVERY="$every" npx tsx scripts/fault-soak.ts $1 $2 $secs $faults > $out/$1-$2.txt 2>&1; }
for pair in "living 1" "bedroom 2" "r3 3"; do run $pair & done; wait
for pair in "r7 4" "r11 5" "r23 6"; do run $pair & done; wait
for pair in "r31 7" "r37 8" "r43 9"; do run $pair & done; wait
for pair in "living 10" "r19 11" "r41 12"; do run $pair & done; wait
python3 - "$out" <<'PY'
import sys, glob, re
rows = []
for f in sorted(glob.glob(sys.argv[1] + '/*.txt')):
    head = open(f).readline()
    m = re.search(r'rounds (\d+) \| longest stall (\d+)s \| pet inside furniture ([\d.]+)s \(longest ([\d.]+)s, in view ([\d.]+)s\) \| NaN frames (\d+) \| map precision (\d+)%.*errors (\d+)', head)
    if not m: print('UNPARSED', f, head[:200]); continue
    rows.append([float(x) for x in m.groups()])
    print(head.strip()[:230])
n = len(rows)
if n:
    col = lambda i: [r[i] for r in rows]
    print(f"\nSUMMARY {n} soaks: rounds {sum(col(0)):.0f} | worst stall {max(col(1)):.0f}s (median {sorted(col(1))[n//2]:.0f}s) | inside furniture total {sum(col(2)):.0f}s, in view {sum(col(4)):.0f}s, worst stretch {max(col(3)):.0f}s | NaN frames {sum(col(5)):.0f} | map precision median {sorted(col(6))[n//2]:.0f}% min {min(col(6)):.0f}% | errors {sum(col(7)):.0f}")
PY
