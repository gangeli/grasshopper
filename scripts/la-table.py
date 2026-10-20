#!/usr/bin/env python3
"""Mean metrics per run group over JSON reports of scripts/large-area.ts (file names <group>_<house>.json,
as large-area-batch.ts writes them). Usage: la-table.py <dir> [group...]   prints one markdown row per group."""
import glob
import json
import os
import sys

d = sys.argv[1]
groups = sys.argv[2:] or sorted({os.path.basename(f).split('_')[0] for f in glob.glob(os.path.join(d, '*.json'))})
print('| run | n | cover% | prec% | local% | ghost m² | falseFree% | frameErr cm (max) | pathColl% | resets | detach/reattach | loops | memMB | cpu mean/p95/max ms |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for p in groups:
    rows = []
    for f in sorted(glob.glob(os.path.join(d, p + '_*.json'))):
        r = json.load(open(f))
        fi = r['final']
        ss = r['samples'][1:] or r['samples']
        h = r['events']['health']
        ev = r['events']
        rows.append([fi['coverage'] * 100, fi['precision'] * 100, sum(s['localPrecision'] for s in ss) / len(ss) * 100, fi['ghostM2'], fi['falseFree'] * 100,
                     fi['frameErr'] * 100, max(s['frameErrMax'] for s in ss) * 100, fi['pathsColliding'] / max(1, fi['pathsTested']) * 100,
                     h.get('mapReset', 0) + h.get('mapContradictory', 0), ev.get('detaches', 0), ev.get('reattaches', 0), ev.get('loopsClosed', 0), fi['memMB'],
                     r['cpu']['frame']['mean'], r['cpu']['frame']['p95'], r['cpu']['frame']['max']])
    if not rows:
        continue
    m = [sum(r[i] for r in rows) / len(rows) for i in range(len(rows[0]))]
    print(f"| {p} | {len(rows)} | {m[0]:.1f} | {m[1]:.1f} | {m[2]:.1f} | {m[3]:.1f} | {m[4]:.1f} | {m[5]:.0f} ({m[6]:.0f}) | {m[7]:.1f} | {m[8]:.1f} | {m[9]:.1f}/{m[10]:.1f} | {m[11]:.1f} | {m[12]:.0f} | {m[13]:.1f}/{m[14]:.1f}/{m[15]:.0f} |")
