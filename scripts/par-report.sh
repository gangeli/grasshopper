#!/bin/bash
# Run real-report.ts over the 12 rooms in 4 parallel processes and merge the room lines.
# Usage: scripts/par-report.sh <outfile> [profile]   (env CAMERA/CAMERA_EVERY/STEREO/WORLD/NAV/MULTIVIEW/PATHS pass through)
out=$1; prof=${2:-real}
groups=("living,bedroom,r3" "r7,r11,r19" "r23,r29,r31" "r37,r41,r43")
for i in 0 1 2 3; do npx tsx scripts/real-report.ts $prof ${groups[$i]} > $out.$i 2>&1 & done
wait
cat $out.0 | head -2 > $out
for i in 0 1 2 3; do grep -E "^(living|bedroom|r[0-9]+) |camera:" $out.$i >> $out; done
rm -f $out.0 $out.1 $out.2 $out.3
