#!/usr/bin/env python3
"""Round-3 table: mean metrics per run group over JSON reports of scripts/large-area.ts
(file names <group>_<house>.json, as large-area-batch.ts writes them), with the
pet-safety metrics measured through the current frame, and paired differences
(per home, mean ± standard error) against a reference group.

Usage: la-table3.py <dir> [more dirs] [--ref group] [--homes 10x12s1,12x15s2] [group...]
Columns: cover% prec% local% ghost m² | falseFree% (map=truth frame) localFF% (live map, current frame)
| frameErr cm (max) | pathColl% (80 paths, final map, truth frame) locPath% (paths near the player,
current frame) locNode% (nav nodes near the player inside furniture) hideBad% (hide spots the game
would pick, inside furniture) | resets detach/reattach | cpu mean/p95/max ms
"""
import glob
import json
import math
import os
import sys

args = sys.argv[1:]
d = args.pop(0)
ref = None
if '--ref' in args:
    i = args.index('--ref')
    ref = args[i + 1]
    del args[i:i + 2]
homes = None
if '--homes' in args:
    i = args.index('--homes')
    homes = set(args[i + 1].split(','))
    del args[i:i + 2]
dirs = [d] + [a for a in args if os.path.isdir(a)]
args = [a for a in args if not os.path.isdir(a)]
files = [f for dd in dirs for f in glob.glob(os.path.join(dd, '*.json'))]
groups = args or sorted({os.path.basename(f).split('_')[0] for f in files})
COLS = ['cover', 'nav3', 'prec', 'local', 'win', 'ghost', 'fFree', 'locFF', 'fErr', 'fErrMx', 'pathC', 'locPath', 'locNode', 'deep', 'hideBad', 'resets', 'detach', 'reatt', 'mem', 'cpu', 'p95', 'max']


def row(r):
    fi = r['final']
    ss = r['samples'][1:] or r['samples']
    h = r['events']['health']
    ev = r['events']
    mean = lambda k: sum(s.get(k, 0) for s in ss) / len(ss)
    ht = sum(s.get('hideTested', 0) for s in r['samples'])
    hb = sum(s.get('hideBad', 0) for s in r['samples'])
    return {
        'cover': fi['coverage'] * 100, 'nav3': mean('localNavM2') if 'localNavM2' in ss[0] else float('nan'), 'prec': fi['precision'] * 100, 'local': mean('localPrecision') * 100, 'win': mean('windowPrecision') * 100 if 'windowPrecision' in ss[0] else float('nan'), 'ghost': fi['ghostM2'],
        'fFree': fi['falseFree'] * 100, 'locFF': mean('localFalseFree') * 100, 'fErr': fi['frameErr'] * 100,
        'fErrMx': max(s['frameErrMax'] for s in ss) * 100, 'pathC': fi['pathsColliding'] / max(1, fi['pathsTested']) * 100,
        'locPath': mean('localPathColl') * 100, 'locNode': mean('localNodeColl') * 100, 'deep': mean('localNodeDeep') * 100, 'hideBad': hb / max(1, ht) * 100,
        'resets': h.get('mapReset', 0) + h.get('mapContradictory', 0), 'detach': ev.get('detaches', 0), 'reatt': ev.get('reattaches', 0),
        'mem': fi['memMB'], 'cpu': r['cpu']['frame']['mean'], 'p95': r['cpu']['frame']['p95'], 'max': r['cpu']['frame']['max'],
    }


data = {}
for p in groups:
    for f in sorted(glob.glob(os.path.join(d, p + '_*.json'))) + [f for dd in dirs[1:] for f in sorted(glob.glob(os.path.join(dd, p + '_*.json')))]:
        home = os.path.basename(f)[len(p) + 1:-5]
        if homes and home not in homes:
            continue
        data.setdefault(p, {})[home] = row(json.load(open(f)))

print('| run | n | cover% | nav3m m² | prec% | local% | win% | ghost m² | falseFree% | localFF% | frameErr cm (max) | pathColl% | locPath% | locNode% (deep) | hideBad% | resets | detach/reatt | cpu mean/p95/max ms |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for p in groups:
    rows = list(data.get(p, {}).values())
    if not rows:
        continue
    m = {c: sum(r[c] for r in rows) / len(rows) for c in COLS}
    print(f"| {p} | {len(rows)} | {m['cover']:.1f} | {m['nav3']:.1f} | {m['prec']:.1f} | {m['local']:.1f} | {m['win']:.1f} | {m['ghost']:.1f} | {m['fFree']:.1f} | {m['locFF']:.1f} | {m['fErr']:.0f} ({m['fErrMx']:.0f}) | {m['pathC']:.1f} | {m['locPath']:.1f} | {m['locNode']:.1f} ({m['deep']:.2f}) | {m['hideBad']:.1f} | {m['resets']:.1f} | {m['detach']:.1f}/{m['reatt']:.1f} | {m['cpu']:.1f}/{m['p95']:.1f}/{m['max']:.0f} |")

if ref and ref in data:
    print(f'\npaired differences vs {ref} (mean ± s.e. over common homes):')
    for p in groups:
        if p == ref or p not in data:
            continue
        common = sorted(set(data[p]) & set(data[ref]))
        if len(common) < 2:
            continue
        out = []
        for c in ['cover', 'nav3', 'prec', 'local', 'win', 'fFree', 'locFF', 'fErr', 'pathC', 'locPath', 'locNode', 'deep', 'hideBad']:
            ds = [data[p][h][c] - data[ref][h][c] for h in common]
            mu = sum(ds) / len(ds)
            se = math.sqrt(sum((x - mu) ** 2 for x in ds) / (len(ds) - 1) / len(ds))
            out.append(f"{c} {mu:+.1f}±{se:.1f}")
        print(f"  {p} (n={len(common)}): " + ', '.join(out))
