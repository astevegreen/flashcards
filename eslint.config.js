import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// The React Compiler checks in react-hooks' recommended set already fired in these packages/ui/src
// files when the full set was turned on (review finding T3, 25 Nov 2026). Each listed rule is off
// in that file only; new files and every other rule are checked in full. Fixing a file means
// deleting its rule (or its line) here; never add a file or a rule to this list.
// tools/eslint-baseline.test.mjs pins every entry, so it can only shrink.
export const REACT_COMPILER_BASELINE = {
  'FlashcardsApp.tsx': ['refs'],
  'backups/AutoBackupRuntime.tsx': ['refs'],
  'backups/BackupsPanel.tsx': ['refs', 'set-state-in-effect'],
  'browse/DuplicateFinderPanel.tsx': ['purity'],
  'browse/FindReplacePanel.tsx': ['set-state-in-effect'],
  'browse/NoteDetailPane.tsx': ['purity'],
  'check/CheckPanel.tsx': ['refs'],
  'components/CoursesPanel.tsx': ['purity'],
  'components/MediaImage.tsx': ['set-state-in-effect'],
  'components/NoteEditDialog.tsx': ['refs', 'set-state-in-effect'],
  'components/SourcesPanel.tsx': ['set-state-in-effect'],
  'dictionary/DictionaryPanel.tsx': ['purity', 'set-state-in-effect'],
  'drawing/DrawLookupPanel.tsx': ['refs', 'set-state-in-effect'],
  'drawing/DrawQuizPanel.tsx': ['refs', 'set-state-in-effect'],
  'drawing/PointerInkCanvas.tsx': ['refs'],
  'import/AnkiImportPanel.tsx': ['refs'],
  'layout/ShellNotices.tsx': ['purity'],
  'library/DeckOrganizationPanel.tsx': ['set-state-in-effect'],
  'library/ImportExportPanel.tsx': ['set-state-in-effect'],
  'packs/PackManagerPanel.tsx': ['set-state-in-effect'],
  'pages/PageViewer.tsx': ['purity'],
  'screens/BrowseScreen.tsx': ['incompatible-library'],
  'screens/LibraryScreen.tsx': ['purity', 'set-state-in-effect'],
  'screens/SettingsScreen.tsx': ['set-state-in-effect'],
  'screens/StatsScreen.tsx': ['purity'],
  'screens/StudyScreen.tsx': ['purity', 'set-state-in-effect'],
  'sources/CloudFilePickerPanel.tsx': ['set-state-in-effect'],
  'sources/GoogleDriveFileLinkPanel.tsx': ['set-state-in-effect'],
  'state/AppContext.tsx': ['refs'],
  'study/CustomStudySection.tsx': ['purity'],
  'study/StudyFilterPanel.tsx': ['purity'],
  'study/StudySetsSection.tsx': ['purity'],
  'study/answerModes/ChoiceMode.tsx': ['set-state-in-effect'],
  'study/answerModes/ClozeMode.tsx': ['set-state-in-effect'],
  'study/answerModes/DrawMode.tsx': ['set-state-in-effect'],
  'study/answerModes/TypedAnswerPanel.tsx': ['set-state-in-effect'],
};

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
  // expected. Each file is typed by the tsconfig that typechecks it (src, tests, e2e). A new
  // TypeScript file must sit inside one of these tsconfigs' `include`, or lint fails to parse it.
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
  // Baseline for the React Compiler checks above (see REACT_COMPILER_BASELINE).
  ...Object.entries(REACT_COMPILER_BASELINE).map(([file, rules]) => ({
    files: [`packages/ui/src/${file}`],
    rules: Object.fromEntries(rules.map((rule) => [`react-hooks/${rule}`, 'off'])),
  })),
  // Node scripts, Cloudflare Worker, and config files
  {
    files: [
      'scripts/**/*.{js,mjs}',
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
);
