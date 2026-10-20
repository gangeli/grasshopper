#!/usr/bin/env python3
"""Calibrate the loop-closure gate on la-loop-truth.ts output (ALL=1): for each
place estimate, its features (support share, uniqueness, constraint, base
share, size) next to whether it was right (error < 8cm at the camera), and
what a candidate gate would let through.
Usage: la-loop-gate.py <la-loop-truth outputs...>"""
import re
import sys

rx = re.compile(r"^([\d.]+) (\w+)\s+est \(([-\d.]+),([-\d.]+)\) true \(([-\d.]+),([-\d.]+)\) err (\d+)cm \|true\| (\d+)cm yaw ([-\d.]+) true ([-\d.]+) oldT (\d+) sup (\d+)/(\d+) base (-?\d+) truth (\S+) 2nd (\d+) uniq (\S+) c (\S+)(.*)$")
rows = []
for f in [a for a in sys.argv[1:] if not a.startswith("--")]:
    for line in open(f):
        m = rx.match(line.strip())
        if not m:
            continue
        g = m.groups()
        rows.append(dict(t=float(g[0]), kind=g[1], err=int(g[6]), true=int(g[7]), mag=(float(g[2]) ** 2 + float(g[3]) ** 2) ** 0.5, sup=int(g[11]) / max(1, int(g[12])), n=int(g[12]), base=int(g[13]) / max(1, int(g[12])),
                         uniq=float(g[16]) if g[16] not in ('undefined', 'NaN') else 0, c=float(g[17]) if g[17] not in ('undefined', 'NaN') else float('nan'), deg='DEG' in g[18], f=f))
print(f"{len(rows)} estimates, {sum(r['err'] < 8 for r in rows)} right (<8cm)")


def gate(r, sup, uniq, c, ratio):
    return (not r['deg']) and r['n'] >= 300 and r['sup'] >= sup and r['uniq'] >= uniq and (r['c'] != r['c'] or r['c'] >= c) and r['sup'] >= ratio * max(r['base'], 0.1) and r['mag'] >= 0.04


print('sup  uniq  c      ratio | pass right wrong (wrong: err cm)')
for sup in (0.1, 0.12, 0.15, 0.2, 0.3):
    for uniq in (1.1, 1.3, 1.6, 2.0):
        for c in (0.004, 0.008, 0.015):
            for ratio in (1.5, 2.0):
                p = [r for r in rows if gate(r, sup, uniq, c, ratio)]
                good = [r for r in p if r['err'] < 8]
                bad = [r for r in p if r['err'] >= 8]
                if not p:
                    continue
                print(f"{sup:.1f}  {uniq:.1f}  {c:.3f}  {ratio:.1f}   | {len(p):4d} {len(good):4d} {len(bad):4d} ({' '.join(str(b['err']) for b in sorted(bad, key=lambda x: -x['err'])[:8])})")

if '--list' in sys.argv or True:
    print('\nright estimates of real drift (err < 10cm, |true| >= 12cm):')
    for r in rows:
        if r['err'] < 10 and r['true'] >= 12:
            print(f"  {r['f'][-12:]} t {r['t']:6.1f} {r['kind']:4} err {r['err']:2d} true {r['true']:2d} sup {r['sup']:.2f} base {r['base']:.2f} uniq {r['uniq']:.2f} c {r['c']:.3f} n {r['n']} {'DEG' if r['deg'] else ''}")
