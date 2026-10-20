/**
 * Resumable work: the persistence layer's heavy steps are generators that
 * yield between small pieces of work, so the app can spread them over frames
 * (a few ms each) while tests and tools run them straight through.
 */
export type Work<T> = Generator<void, T, void>;

/** Run a generator to completion. */
export function runToEnd<T>(g: Work<T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** A counter that says "yield now" every `every` calls. */
export function every(n: number): () => boolean {
  let k = 0;
  return () => ++k % n === 0;
}
