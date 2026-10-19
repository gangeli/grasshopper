import sys, re
# Summarise a real-report / par-report room table.
rows = []
for line in open(sys.argv[1]):
    m = re.match(r'^(\S+)\s+(\d+)\(\s*(\d+)\)\s+\|\s+([\d.]+)\s+([\d.]+)\s+(\d+)%\s+(\d+)%\s+\|\s+(\d+)%\s+(\d+)%\s+\|\s+(\d+)\s+(\d+)\(([\d.]+)\)\s+(\d+)\s+\|\s+(\d+)\s+(\d+)\(([\d.]+)\)\s+(\d+)\s+(\d+)\s+\|\s+([\d.]+)', line)
    if m: rows.append(m.groups())
n = len(rows)
f = lambda i: [float(r[i]) for r in rows]
nodes = sum(f(9)); coll = sum(f(10))
print(f"{n} rooms | surfErr p95 {sum(f(4))/n:.1f}cm | falseFree {sum(f(7))/n:.1f}% (max {max(f(7)):.0f}%) | missedLow {sum(f(8))/n:.0f}% | nodes colliding {coll/max(1,nodes)*100:.2f}% | paths colliding {sum(c / max(1, t) for c, t in zip(f(14), f(13))) / n * 100:.1f}% (maxPen {max(f(15))*100:.0f}cm) | bad landings {int(sum(f(17)))}/{int(sum(f(16)))} | walkable {sum(f(18))/n:.1f} m² (min {min(f(18)):.1f})")
