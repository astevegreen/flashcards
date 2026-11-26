/** Median wall time of `rounds` runs after one warm-up run, in ms. */
export function medianMs(run: () => void, rounds = 15): number {
  run();
  const times: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] ?? 0;
}
