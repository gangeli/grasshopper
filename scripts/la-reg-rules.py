#!/usr/bin/env python3
"""Acceptance rules for local re-registration, tried offline on dry-run estimates
(WorldModel.localRegApply=false, everything accepted): for each rule, how many
estimates pass and the mean change of the old structure's share on real
structure (on-real post - pre, weighted by its size), and how many make it worse.

Usage: la-reg-rules.py <json files...>
"""
import itertools
import json
import sys

R = []
for f in sys.argv[1:]:
    L = json.load(open(f))['events'].get('localReg')
    if L:
        R += [r for r in L['regs'] if 'see0' in r and r['why'] in ('ok', 'dry run')]
print(len(R), 'estimates; mean pre on-real', sum(r['pre'] for r in R) / len(R))


def evaluate(rule):
    acc = [r for r in R if rule(r)]
    if not acc:
        return 0, 0, 0, 0
    gain = sum((r['post'] - r['pre']) * r['rw'] for r in acc) / max(1, sum(r['rw'] for r in R))
    worse = sum(1 for r in acc if r['post'] < r['pre'] - 0.03)
    better = sum(1 for r in acc if r['post'] > r['pre'] + 0.03)
    return len(acc), gain * 100, better, worse


rows = []
for minSee, seeGain, minInl, share, gain in itertools.product([0, 0.002, 0.004, 0.008, 0.016], [0.5, 0.7, 0.9, 99], [0, 20, 40], [0, 0.4, 0.6], [0, 1.2, 1.5]):
    def rule(r):
        return r['see0'] >= minSee and r['see1'] <= seeGain * r['see0'] and r['inl'] >= minInl and r['inl'] >= share * r['m'] and r['inl'] >= gain * r['inl0']
    n, g, b, w = evaluate(rule)
    rows.append((g, n, b, w, minSee, seeGain, minInl, share, gain))
rows.sort(reverse=True)
print('gain(pts of all ref)  n  better worse | minSee seeGain minInl share gain')
for row in rows[:25]:
    print(f'{row[0]:7.3f} {row[1]:5d} {row[2]:5d} {row[3]:5d} | {row[4]} {row[5]} {row[6]} {row[7]} {row[8]}')
n, g, b, w = evaluate(lambda r: True)
print(f'all: {g:.3f} {n} {b} {w}')
