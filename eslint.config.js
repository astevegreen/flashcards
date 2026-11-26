import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
      // Generated native projects (copies of apps/web/dist, Rust target, Gradle/Xcode output)
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
      'apps/desktop/src-tauri/target/**',
      'apps/desktop/src-tauri/gen/**',
      '.cache/**',
      'dist-packs/**',
      // Agent worktrees (full repo copies checked out under .claude/worktrees)
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  // Hard architectural boundary: packages/core must be 100% pure TypeScript
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              message: 'packages/core must remain 100% pure TypeScript (no React).',
            },
            {
              name: 'react-dom',
              message: 'packages/core must remain 100% pure TypeScript (no React DOM).',
            },
            { name: 'dexie', message: 'packages/core must not depend on IndexedDB/Dexie.' },
            {
              name: '@flash/platform-web',
              message: 'packages/core must not depend on platform-web.',
            },
            { name: '@flash/ui', message: 'packages/core must not depend on UI.' },
          ],
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'crypto', 'os', 'http', 'https', 'stream', 'buffer'],
              message: 'packages/core must not import Node built-ins.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'packages/core must not access DOM globals.' },
        { name: 'document', message: 'packages/core must not access DOM globals.' },
        { name: 'navigator', message: 'packages/core must not access browser globals.' },
        { name: 'localStorage', message: 'packages/core must not access browser storage.' },
        { name: 'indexedDB', message: 'packages/core must not access IndexedDB.' },
      ],
    },
  },
  // Pure interface boundary for packages/platform
  {
    files: ['packages/platform/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'packages/platform must be pure interfaces.' },
            { name: 'dexie', message: 'packages/platform must not depend on concrete adapters.' },
          ],
          patterns: [
            { group: ['node:*'], message: 'packages/platform must not import Node built-ins.' },
          ],
        },
      ],
    },
  },
  // Browser + React rules for UI and web app
  {
    files: [
      'packages/ui/src/**/*.{ts,tsx}',
      'apps/web/src/**/*.{ts,tsx}',
      'packages/platform-web/src/**/*.ts',
      'packages/platform-capacitor/src/**/*.ts',
      'packages/platform-tauri/src/**/*.ts',
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // Node scripts, Cloudflare Worker, and config files
  {
    files: [
      'scripts/**/*.{js,mjs}',
      'spikes/phase0/scripts/**/*.{js,mjs}',
      'tools/**/*.{ts,js,mjs}',
      '*.config.{js,ts}',
      'tests/**/*.ts',
      'apps/token-helper/**/*.ts',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  // Throwaway browser spike harness
  {
    files: ['spikes/phase0/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
  },
);
