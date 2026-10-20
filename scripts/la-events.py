#!/usr/bin/env python3
"""Per-run tracker events and anchor stats from large-area JSON reports.
Usage: la-events.py <dir> [group]"""
import glob
import json
import os
import sys

d = sys.argv[1]
grp = sys.argv[2] if len(sys.argv) > 2 else ''
for f in sorted(glob.glob(os.path.join(d, grp + '*.json'))):
    r = json.load(open(f))
    e = r['events']
    a = e.get('anchors') or {}
    ss = r['samples'][1:] or r['samples']
    print(f"{os.path.basename(f)[:-5]:28s} walked {r['walked']:5.0f} loops {e['loopClosures']:2d} losses {e['trackingLosses']:2d} jumps {e.get('lossJumps', 0)} "
          f"fe {r['final']['frameErr'] * 100:4.0f} local {sum(s['localPrecision'] for s in ss) / len(ss) * 100:5.1f} "
          + (f"anchors created {a.get('created')} failed {a.get('failed')} lost {a.get('lost')} corr {a.get('corrections')} missed {a.get('missed')} merges {a.get('merges')} warps {a.get('submapWarps')} moves {a.get('anchorMoves')}" if a else ''))
