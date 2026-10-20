/**
 * Crude method profiler for node benchmarks: wraps every method of the
 * given prototypes and records call counts, total and max time (inclusive).
 */
export class MethodProfiler {
  readonly stats = new Map<string, { n: number; total: number; max: number }>();
  private restore: (() => void)[] = [];

  wrap(name: string, proto: object, skip: string[] = []): void {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || skip.includes(key)) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (!desc || typeof desc.value !== 'function') continue;
      const orig = desc.value as (...a: unknown[]) => unknown;
      // Generators: time only the creation (their work happens on next()).
      if (orig.constructor.name === 'GeneratorFunction') continue;
      const label = `${name}.${key}`;
      const stats = this.stats;
      (proto as Record<string, unknown>)[key] = function (this: unknown, ...args: unknown[]) {
        const t0 = performance.now();
        try {
          return orig.apply(this, args);
        } finally {
          const dt = performance.now() - t0;
          let s = stats.get(label);
          if (!s) stats.set(label, (s = { n: 0, total: 0, max: 0 }));
          s.n++;
          s.total += dt;
          if (dt > s.max) s.max = dt;
        }
      };
      this.restore.push(() => ((proto as Record<string, unknown>)[key] = orig));
    }
  }

  unwrap(): void {
    for (const r of this.restore) r();
    this.restore = [];
  }

  report(top = 20): string {
    const rows = [...this.stats.entries()].sort((a, b) => b[1].max - a[1].max).slice(0, top);
    return rows.map(([k, s]) => `${k.padEnd(40)} n ${String(s.n).padStart(7)} total ${s.total.toFixed(0).padStart(7)}ms mean ${(s.total / s.n).toFixed(2).padStart(7)}ms max ${s.max.toFixed(1).padStart(7)}ms`).join('\n');
  }
}
