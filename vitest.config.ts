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
      // Just below the numbers measured on 2026-11-26 (rounded down to whole percent), so `pnpm
      // coverage` fails only when coverage drops. Raise them as tests are added.
      thresholds: { statements: 64, branches: 55, functions: 55, lines: 65 },
    },
  },
});
