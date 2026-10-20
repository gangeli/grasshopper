"""Summarize relocalization trial JSONL (scripts/persist-trials.ts): per attempt,
whether the best candidate was correct (close to truth), and the metrics that
separate correct from wrong placements.
  python3 scripts/analyze-trials.py trials*.jsonl
"""
import json
import sys

rows = []
for path in sys.argv[1:]:
    for line in open(path):
        line = line.strip()
        if line.startswith('{'):
            rows.append(json.loads(line))

def correct(r):
    return r['same'] and r['errCm'] is not None and r['errCm'] < 15 and r['errDeg'] < 3

tp = sum(1 for r in rows if r['accepted'] and correct(r))
fp = [r for r in rows if r['accepted'] and not correct(r)]
same = [r for r in rows if r['same']]
print(f"attempts {len(rows)}  same {len(same)}  accepted-correct {tp}  FALSE ACCEPTS {len(fp)}")
print(f"best-correct among same: {sum(1 for r in same if correct(r))}/{len(same)}")
for r in fp:
    print('FP', r['seed'], r['t'], r['moved'], r['errCm'], r['errDeg'], r['amb'], json.dumps(r['best']))

def feats(r):
    b = r.get('best') or {}
    if not b:
        return None
    conf = b['fwdConf'] + b['bwdConf'] + b['freeConf']
    hits = b['fwdHit'] + b['bwdHit']
    low = b.get('lowN', 0)
    return dict(
        overlap=b['fwdHit'] + b['fwdConf'],
        bwd=b['bwdHit'] + b['bwdConf'],
        inlier=b['inlier'],
        explained=b['explained'],
        confRate=conf / max(1, hits + conf),
        lowN=low,
        lowHit=b.get('lowHit', 0) / max(1, low),
        lowConf=b.get('lowConf', 0) / max(1, low),
        bwdLowN=b.get('bwdLowN', 0),
        bwdLowHit=b.get('bwdLowHit', 0) / max(1, b.get('bwdLowN', 0)),
        bwdLowConf=b.get('bwdLowConf', 0) / max(1, b.get('bwdLowN', 0)),
        freeHit=b.get('freeHit', 0),
        amb=r['amb'],
    )

print('\nkind     seed t  moved  err     ' + ' '.join(f"{k:>9}" for k in ['overlap', 'bwd', 'inlier', 'explained', 'confRate', 'lowN', 'lowHit', 'lowConf', 'bwdLowN', 'bwdLowHit', 'bwdLowConf', 'freeHit', 'amb']) + '  acc reason')
for r in sorted(rows, key=lambda r: (not correct(r), r['seed'], r['t'])):
    f = feats(r)
    if not f:
        continue
    kind = 'GOOD ' if correct(r) else ('WRONG' if r['same'] else 'OTHER')
    print(f"{kind} {r['seed']:4d} {r['t']:3d} {str(r['moved'])[0]}  {str(r['errCm']):>6} " + ' '.join(f"{v:9.2f}" if isinstance(v, float) else f"{v:9d}" for v in f.values()) + f"  {str(r['accepted'])[0]} {r['reason']}")
