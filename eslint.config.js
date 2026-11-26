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
  // Type-aware promise rules for every TypeScript file: a promise must be awaited, handled, or
  // marked fire-and-forget with `void`, and never passed where a void callback or a condition is
  // expected. Each file is typed by the tsconfig that typechecks it (src, tests, e2e).
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: [
          './apps/*/tsconfig.json',
          './apps/*/tsconfig.test.json',
          './packages/*/tsconfig.json',
          './packages/*/tsconfig.test.json',
          './tools/*/tsconfig.json',
          './tools/*/tsconfig.test.json',
          './tsconfig.e2e.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
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
    // The plugin's full recommended set (rules of hooks plus the React Compiler checks), with
    // exhaustive-deps kept at its recommended warn.
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // Baseline for the React Compiler checks above: each rule is off only in the files where it
  // already fired when the full set was turned on (review finding T3, 25 Nov 2026), so new files
  // and every other rule are checked in full. Fixing a file means deleting it from its list here;
  // never add a file to these lists.
  {
    files: ['packages/ui/src/screens/BrowseScreen.tsx'],
    rules: { 'react-hooks/incompatible-library': 'off' },
  },
  {
    files: ['packages/ui/src/screens/StudyScreen.tsx'],
    rules: { 'react-hooks/preserve-manual-memoization': 'off' },
  },
  {
    files: [
      'packages/ui/src/browse/DuplicateFinderPanel.tsx',
      'packages/ui/src/browse/NoteDetailPane.tsx',
      'packages/ui/src/components/CoursesPanel.tsx',
      'packages/ui/src/dictionary/DictionaryPanel.tsx',
      'packages/ui/src/layout/ShellNotices.tsx',
      'packages/ui/src/pages/PageViewer.tsx',
      'packages/ui/src/screens/LibraryScreen.tsx',
      'packages/ui/src/screens/StatsScreen.tsx',
      'packages/ui/src/screens/StudyScreen.tsx',
      'packages/ui/src/study/CustomStudySection.tsx',
      'packages/ui/src/study/StudyFilterPanel.tsx',
      'packages/ui/src/study/StudySetsSection.tsx',
    ],
    rules: { 'react-hooks/purity': 'off' },
  },
  {
    files: [
      'packages/ui/src/FlashcardsApp.tsx',
      'packages/ui/src/backups/AutoBackupRuntime.tsx',
      'packages/ui/src/backups/BackupsPanel.tsx',
      'packages/ui/src/check/CheckPanel.tsx',
      'packages/ui/src/components/NoteEditDialog.tsx',
      'packages/ui/src/drawing/DrawLookupPanel.tsx',
      'packages/ui/src/drawing/DrawQuizPanel.tsx',
      'packages/ui/src/drawing/PointerInkCanvas.tsx',
      'packages/ui/src/import/AnkiImportPanel.tsx',
      'packages/ui/src/state/AppContext.tsx',
      'packages/ui/src/state/useSyncController.ts',
    ],
    rules: { 'react-hooks/refs': 'off' },
  },
  {
    files: [
      'packages/ui/src/backups/BackupsPanel.tsx',
      'packages/ui/src/browse/FindReplacePanel.tsx',
      'packages/ui/src/components/MediaImage.tsx',
      'packages/ui/src/components/NoteEditDialog.tsx',
      'packages/ui/src/components/SourcesPanel.tsx',
      'packages/ui/src/dictionary/DictionaryPanel.tsx',
      'packages/ui/src/drawing/DrawLookupPanel.tsx',
      'packages/ui/src/drawing/DrawQuizPanel.tsx',
      'packages/ui/src/library/DeckOrganizationPanel.tsx',
      'packages/ui/src/library/ImportExportPanel.tsx',
      'packages/ui/src/packs/PackManagerPanel.tsx',
      'packages/ui/src/screens/LibraryScreen.tsx',
      'packages/ui/src/screens/SettingsScreen.tsx',
      'packages/ui/src/screens/StudyScreen.tsx',
      'packages/ui/src/sources/CloudFilePickerPanel.tsx',
      'packages/ui/src/sources/GoogleDriveFileLinkPanel.tsx',
      'packages/ui/src/study/answerModes/ChoiceMode.tsx',
      'packages/ui/src/study/answerModes/ClozeMode.tsx',
      'packages/ui/src/study/answerModes/DrawMode.tsx',
      'packages/ui/src/study/answerModes/TypedAnswerPanel.tsx',
    ],
    rules: { 'react-hooks/set-state-in-effect': 'off' },
  },
  // Node scripts, Cloudflare Worker, and config files
  {
    files: [
      'scripts/**/*.{js,mjs}',
      'spikes/phase0/scripts/**/*.{js,mjs}',
      'tools/**/*.{ts,js,mjs}',
      '*.config.{js,ts}',
      'tests/**/*.ts',
      'apps/token-helper/tests/**/*.ts',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  // The token helper itself runs as a Cloudflare Worker (no Node globals); its tests run in Node.
  {
    files: ['apps/token-helper/src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
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
