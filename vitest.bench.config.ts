import { defineConfig } from 'vitest/config';

/**
 * Timings kept out of `pnpm test` (they replay 20k-card collections): `pnpm bench`. Each file logs
 * medians and asserts only that the work ran.
 */
export default defineConfig({
  test: {
    include: ['packages/**/bench/**/*.perf.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 120_000,
    // The timings are the point: show them for passing tests too.
    silent: false,
  },
});
