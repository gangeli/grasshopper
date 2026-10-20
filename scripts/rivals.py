"""Print best vs rival metrics for chosen seeds of a trials JSONL.
  python3 scripts/rivals.py "31,48" files...
"""
import json
import sys

seeds = {int(s) for s in sys.argv[1].split(',')}
keys = ['fwdHit', 'fwdConf', 'freeN', 'freeHit', 'freeConf', 'lowN', 'lowHit', 'lowConf', 'bwdN', 'bwdHit', 'bwdConf', 'bwdLowN', 'bwdLowHit', 'bwdLowConf', 'score']
print('seed  t  who   err/dist ' + ' '.join(f"{k[:9]:>9}" for k in keys))
for path in sys.argv[2:]:
    for line in open(path):
        if not line.startswith('{'):
            continue
        r = json.loads(line)
        if r['seed'] not in seeds:
            continue
        for who, m, d in [('best', r.get('best'), r['errCm']), ('rival', r.get('rival'), r.get('rivalDist'))]:
            if not m:
                continue
            print(f"{r['seed']:4d} {r['t']:3d} {who:5s} {str(d):>8} " + ' '.join(f"{m.get(k, 0):9.0f}" for k in keys))
