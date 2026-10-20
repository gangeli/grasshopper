#!/bin/bash
# Freeze the code under test for a long benchmark batch: copies the working
# tree's src/ and scripts/ (or a git revision) into artifacts/snap/<name>, so
# editing the sources while a batch runs doesn't change the runs it starts.
# Usage: scripts/la-snap.sh <name> [git-rev]   (prints the snapshot dir)
# Then: (cd "$(scripts/la-snap.sh x)" && npx tsx scripts/large-area-batch.ts spec.json out 4)
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
name=${1:?name}
dir="$root/artifacts/snap/$name"
rm -rf "$dir"
mkdir -p "$dir"
if [ -n "$2" ]; then
  git -C "$root" archive "$2" src scripts package.json tsconfig.json | tar -x -C "$dir"
else
  cp -r "$root/src" "$root/scripts" "$root/package.json" "$root/tsconfig.json" "$dir/"
fi
ln -s "$root/node_modules" "$dir/node_modules"
echo "$dir"
