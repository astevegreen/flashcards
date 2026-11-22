import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
      'apps/**/tests/**/*.test.ts',
      'tools/**/tests/**/*.test.ts',
      'scripts/tests/**/*.test.mjs',
    ],
    environment: 'node',
    globals: false,
  },
});
