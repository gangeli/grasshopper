#!/usr/bin/env python3
"""Summary table of large-area benchmark reports (JSON from scripts/large-area.ts)."""
import json
import sys

rows = []
for path in sys.argv[1:]:
    r = json.load(open(path))
    f = r["final"]
    fe_max = max(s["frameErrMax"] for s in r["samples"])
    rows.append(
        (
            f'{r["house"]["width"]}x{r["house"]["depth"]}',
            f["coverage"] * 100,
            f["coverageAll"] * 100,
            f["precision"] * 100,
            f["ghostM2"],
            f["falseFree"] * 100,
            f["frameErr"] * 100,
            fe_max * 100,
            r["retention"]["coverageDrop"] * 100,
            r["retention"]["worstCoverageDrop"] * 100,
            f["pathsColliding"] / max(1, f["pathsTested"]) * 100,
            f["memMB"],
            r["cpu"]["frame"]["mean"],
            r["cpu"]["frame"]["p95"],
            r["cpu"]["frame"]["max"],
            r["cpu"]["nav"]["mean"],
        )
    )
hdr = ("home", "cover%", "all%", "prec%", "ghostm2", "falseFree%", "frameErr", "fErrMax", "retDrop%", "worstDrop%", "pathColl%", "memMB", "cpu", "p95", "max", "nav")
print(" | ".join(h.rjust(8) for h in hdr))
for row in rows:
    print(" | ".join((f"{v:8.1f}" if isinstance(v, float) else str(v).rjust(8)) for v in row))
if rows:
    n = len(rows)
    avg = [sum(row[c] for row in rows) / n for c in range(1, len(hdr))]
    print(" | ".join(["mean".rjust(8)] + [f"{v:8.1f}" for v in avg]))
