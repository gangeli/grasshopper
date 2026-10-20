#!/bin/bash
# Like la-snap.sh for the working tree only (no revision): freeze src/ and
# scripts/ into artifacts/snap/<name> so a long batch isn't affected by edits.
# Usage: scripts/snap.sh <name>   (prints the snapshot dir)
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
name=${1:?name}
dir="$root/artifacts/snap/$name"
rm -rf "$dir"
mkdir -p "$dir"
cp -r "$root/src" "$root/scripts" "$root/package.json" "$root/tsconfig.json" "$dir/"
ln -s "$root/node_modules" "$dir/node_modules"
echo "$dir"
