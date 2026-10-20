"""Re-apply candidate acceptance rules to recorded trials (scripts/persist-trials.ts
output) without re-running the simulation. Edit RULES below to try variants.
  python3 scripts/rejudge.py files...
"""
import json
import sys

def judge(m, amb, P):
    if not m:
        return False, 'none'
    if m['fwdHit'] + m['fwdConf'] < P['minOverlap']:
        return False, 'overlap'
    if m['bwdHit'] + m['bwdConf'] < P['minOverlap'] * 0.5:
        return False, 'reverse overlap'
    if m['freeHit'] < 600 or (m['freeHit'] < 0.3 * m['freeSamples'] and m.get('bwdFreeHit', 0) < 0.3 * m.get('fragFreeSamples', 1)):
        return False, 'free overlap'
    if m['inlier'] < P['minInlier']:
        return False, 'inlier'
    if m['explained'] < P['minExplained']:
        return False, 'explained'
    if amb > P['maxAmb']:
        return False, 'ambiguous'
    lowN = m['lowN'] + m['bwdLowN']
    furn = (m['lowConf'] + m['bwdLowConf']) / max(1, lowN)
    if lowN >= P['furnMinN'] and furn > P['maxFurn']:
        return False, 'furniture disagrees'
    if m.get('wallWeak', 0) < P['minWallWeak']:
        lc = m['lowConf'] / max(1, m['lowN'])
        blc = m['bwdLowConf'] / max(1, m['bwdLowN'])
        if m['lowN'] < 150 or m.get('lowObjects', 99) < P['minObjects'] or lc > P['maxLowConf'] or blc > P['maxBwdLowConf']:
            return False, 'walls weak'
    return True, 'ok'

P = dict(minOverlap=300, minInlier=0.8, minExplained=0.5, maxAmb=0.7, furnMinN=100, maxFurn=0.35, minWallWeak=40, minObjects=3, maxLowConf=0.1, maxBwdLowConf=0.12)
for a in sys.argv[1:]:
    if '=' in a:
        k, v = a.split('=')
        P[k] = float(v)
files = [a for a in sys.argv[1:] if '=' not in a]
rows = [json.loads(l) for f in files for l in open(f) if l.startswith('{')]
def correct(r):
    return r['same'] and r['errCm'] is not None and r['errCm'] < 15 and r['errDeg'] < 3
tp = fp = 0
reasons = {}
fps = []
for r in rows:
    ok, why = judge(r.get('best'), r['amb'], P)
    if ok and correct(r):
        tp += 1
    elif ok:
        fp += 1
        fps.append(r)
    if correct(r) and not ok:
        reasons[why] = reasons.get(why, 0) + 1
good = sum(1 for r in rows if correct(r))
print(f"{P}\nattempts {len(rows)} correct-best {good} accepted-correct {tp} FALSE {fp}  rejected-correct by: {reasons}")
for r in fps:
    m = r['best']
    print('  FP seed', r['seed'], 't', r['t'], 'moved', r['moved'], 'err', r['errCm'], r['errDeg'], 'inl', round(m['inlier'], 2), 'furn', m['lowN'], m['lowConf'], m['bwdLowN'], m['bwdLowConf'], 'wallWeak', round(m.get('wallWeak', 0)), 'objects', m.get('lowObjects'), 'amb', r['amb'])

# Session level: a restore needs two consecutive accepted attempts that agree
# (same placement: here, both correct or both the same error).
by = {}
for r in rows:
    by.setdefault(r['seed'], []).append(r)
sfp = stp = 0
for seed, rs in by.items():
    rs.sort(key=lambda r: r['t'])
    acc = [judge(r.get('best'), r['amb'], P)[0] for r in rs]
    for k in range(1, len(rs)):
        if acc[k] and acc[k - 1]:
            a, b = rs[k - 1], rs[k]
            same = a['errCm'] is not None and b['errCm'] is not None and abs(a['errCm'] - b['errCm']) < 10 and abs(a['errDeg'] - b['errDeg']) < 2
            if not same:
                continue
            if correct(b):
                stp += 1
            else:
                sfp += 1
                print('  SESSION FP seed', seed, 't', b['t'], 'err', b['errCm'], b['errDeg'])
            break
print(f"session level: restores {stp + sfp} (correct {stp}, WRONG {sfp}) of {len(by)} sessions ({sum(1 for rs in by.values() if rs[0]['same'])} same-room)")
