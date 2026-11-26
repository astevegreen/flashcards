import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
      'packages/**/tests/**/*.test.tsx',
      'apps/**/tests/**/*.test.ts',
      'tools/**/tests/**/*.test.ts',
      'scripts/tests/**/*.test.mjs',
    ],
    // Node by default; a UI render test opts into a DOM with `// @vitest-environment happy-dom`.
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**', 'tools/*/src/**'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      // About one point under the numbers measured on 2026-11-26 (64.4 / 55.7 / 55.4 / 65.5): open
      // branches and Node or V8 versions shift coverage a little. To adjust, run `pnpm coverage`
      // on main and set each to its measured number rounded down, minus 1.
      thresholds: { statements: 63, branches: 54, functions: 54, lines: 64 },
    },
  },
});
