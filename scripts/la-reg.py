#!/usr/bin/env python3
"""Local re-registration estimates (WorldModel.localReg) scored against the truth.

Usage: la-reg.py <json files...>
Reads events.localReg.regs of large-area reports: per estimate, `need` (how far
the matched old structure really is from where it belongs, 1.5 m around the
camera), `got` (how far the estimate moves it) and `err` (where it ends up vs
where it belongs). An estimate helps when err < need. Prints acceptance
reasons, and for accepted estimates the share that help / hurt, by inlier
count and gain.
"""
import json
import sys

regs = []
why = {}
for f in sys.argv[1:]:
    j = json.load(open(f))
    L = j['events'].get('localReg')
    if not L:
        continue
    regs += L['regs']
    for k, v in L['why'].items():
        why[k] = why.get(k, 0) + v
print('rejections/reasons:', dict(sorted(why.items(), key=lambda x: -x[1])))
print(f'{len(regs)} scored estimates')


def summ(rs, label):
    if not rs:
        return
    helps = sum(1 for r in rs if r['err'] < r['need'] - 0.01)
    hurts = sum(1 for r in rs if r['err'] > r['need'] + 0.01)
    big = sum(1 for r in rs if r['err'] > r['need'] + 0.05)
    mn = sum(r['need'] for r in rs) / len(rs)
    me = sum(r['err'] for r in rs) / len(rs)
    print(f'  {label:28s} n {len(rs):5d} need {mn*100:5.1f}cm err {me*100:5.1f}cm helps {helps/len(rs)*100:5.1f}% hurts {hurts/len(rs)*100:5.1f}% (>5cm worse {big/len(rs)*100:4.1f}%)')


summ([r for r in regs if r['ok']], 'accepted')
for lo, hi in [(0, 30), (30, 60), (60, 100), (100, 200), (200, 10000)]:
    summ([r for r in regs if r['ok'] and lo <= r['inl'] < hi], f'accepted inl {lo}-{hi}')
for lo, hi in [(0, 1.3), (1.3, 2), (2, 4), (4, 1e9)]:
    summ([r for r in regs if r['ok'] and lo <= r['inl'] / max(1, r['inl0'] + 5) < hi], f'accepted gain {lo}-{hi}')
for lo, hi in [(0, 0.05), (0.05, 0.1), (0.1, 0.2), (0.2, 0.4), (0.4, 9)]:
    summ([r for r in regs if r['ok'] and lo <= r['got'] < hi], f'accepted move {lo}-{hi}')
for w in sorted(set(r['why'] for r in regs)):
    summ([r for r in regs if r['why'] == w], 'why ' + w)
