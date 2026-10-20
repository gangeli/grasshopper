#!/usr/bin/env python3
"""Self-time per function from a V8 .cpuprofile (node --cpu-prof). Usage: cpuprofile-top.py file [n]"""
import json
import sys
from collections import defaultdict

p = json.load(open(sys.argv[1]))
n = int(sys.argv[2]) if len(sys.argv) > 2 else 25
nodes = {x["id"]: x for x in p["nodes"]}
self_t = defaultdict(float)
deltas = p["timeDeltas"]
for sid, dt in zip(p["samples"], deltas):
    cf = nodes[sid]["callFrame"]
    key = f'{cf["functionName"] or "(anon)"} {cf["url"].split("/")[-1]}:{cf["lineNumber"] + 1}'
    self_t[key] += dt / 1000
tot = sum(self_t.values())
for k, v in sorted(self_t.items(), key=lambda kv: -kv[1])[:n]:
    print(f"{v:9.1f}ms {100 * v / tot:5.1f}%  {k}")
