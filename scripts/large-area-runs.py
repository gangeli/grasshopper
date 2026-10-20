#!/usr/bin/env python3
"""One line per benchmark run (JSON reports from scripts/large-area.ts). Usage: large-area-runs.py <dir-or-files...> [--filter prefix]"""
import glob
import json
import os
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
flt = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--filter=")), "")
files = []
for a in args:
    files += sorted(glob.glob(os.path.join(a, "*.json"))) if os.path.isdir(a) else [a]
for f in files:
    name = os.path.basename(f)[:-5]
    if flt and not name.startswith(flt):
        continue
    r = json.load(open(f))
    fi, ss = r["final"], r["samples"][1:] or r["samples"]
    lp = sum(s["localPrecision"] for s in ss) / len(ss)
    lpc = sum(s.get("localPathColl", 0) for s in ss) / len(ss)
    h = r["events"]["health"]
    print(
        f"{name:26} cov {fi['coverage']*100:3.0f} prec {fi['precision']*100:3.0f} loc {lp*100:3.0f} locPC {lpc*100:3.0f} ghost {fi['ghostM2']:5.1f} "
        f"ff {fi['falseFree']*100:4.1f} ferr {fi['frameErr']*100:3.0f}/{max(s['frameErrMax'] for s in ss)*100:3.0f} "
        f"resets {h.get('mapReset', 0) + h.get('mapContradictory', 0)} loops {r['events'].get('loopsClosed', 0)} mem {fi['memMB']:.0f}"
    )
