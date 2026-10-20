"""Aggregate the JSON lines of persist-bench runs.
  python3 scripts/bench-summary.py logs...
"""
import json
import sys

homes = []
for path in sys.argv[1:]:
    for line in open(path):
        if line.startswith('JSON '):
            homes.append(json.loads(line[5:]))
if not homes:
    print('no results')
    sys.exit(0)

def mean(a):
    return sum(a) / len(a) if a else float('nan')

def pct(a, q):
    a = sorted(a)
    return a[min(len(a) - 1, int(q * len(a)))] if a else float('nan')

known = sum(h['known'] for h in homes)
ok = sum(h['ok'] for h in homes)
wrong = sum(h['wrong'] for h in homes)
kept = sum(h['wrongKept'] for h in homes)
restores = sum(h['restores'] for h in homes)
ttr = [t for h in homes for t in h['ttr']]
err = [e for h in homes for e in h['err']]
deg = [e for h in homes for e in h['deg']]
q = [x for h in homes for x in h['quality']]
print(f"homes {len(homes)}  relocalized {ok}/{known} sessions ({100 * ok / max(1, known):.0f}%)  WRONG restores {wrong} (kept {kept}) of {restores}  undos {sum(h['undos'] for h in homes)}")
print(f"time to relocalize: mean {mean(ttr):.1f}s median {pct(ttr, 0.5):.1f}s p90 {pct(ttr, 0.9):.1f}s")
print(f"alignment error: mean {mean(err):.1f}cm / {mean(deg):.2f}°, p90 {pct(err, 0.9):.1f}cm, max {max(err) if err else float('nan'):.1f}cm")
print(f"fragments per home {mean([h['fragments'] for h in homes]):.1f}, storage {mean([h['bytes'] for h in homes]) / 1024:.0f}KB, coverage (largest fragment) {100 * mean([h['coverage'] for h in homes]):.0f}%")
print(f"map quality: precision {mean([x['precision'] for x in q]):.3f}, walls {mean([x['wallPrecision'] for x in q]):.3f}, falseFree {mean([x['falseFree'] for x in q]):.3f}, ghosts {mean([x['ghosts'] for x in q]):.0f} (walls {mean([x['wallGhosts'] for x in q]):.0f})")
print(f"save {mean([s for h in homes for s in h['saveMs']]):.0f}ms, load {mean([s for h in homes for s in h['loadMs']]):.0f}ms, busy per session {mean([s for h in homes for s in h['busyMs']]) / 1000:.1f}s, longest slice {max(h['maxStep'] for h in homes):.1f}ms")
