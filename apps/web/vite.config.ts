import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { PRODUCTION_CSP } from './csp.ts';

function productionCspPlugin(): Plugin {
  return {
    name: 'production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      // The §13 policy lives in ./csp.ts (shared with the Tauri shell, the hosting docs and the
      // CSP tests): script-src pinned to 'self' + 'wasm-unsafe-eval' (WASM only, never eval) +
      // Google Picker / Identity loaders, frame-src pinned to the Google Picker origins,
      // connect-src 'self' + https:, worker-src 'self', img-src 'self' blob: data:.
      const csp = PRODUCTION_CSP;
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    productionCspPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Flashcards',
        short_name: 'Flashcards',
        description: 'Local-first offline foreign language flashcard app',
        start_url: '/',
        display: 'standalone',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // `wasm`: the lazy FSRS optimizer (Phase 11) must work offline like everything else.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm}'],
        globIgnores: ['packs/**', 'picker.html'],
        ignoreURLParametersMatching: [
          /^device$/,
          /^starterCatalog$/,
          /^licenseGate$/,
          /^licensePubKey$/,
          /^code$/,
          /^state$/,
          /^scope$/,
          /^authuser$/,
          /^prompt$/,
          /^error$/,
        ],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
  // fsrs-browser resolves its `.wasm` via `import.meta.url`; pre-bundling would break that in dev.
  optimizeDeps: { exclude: ['fsrs-browser'] },
  build: {
    target: 'es2023',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const norm = id.replace(/\\/g, '/');
          // Consolidate initial study-screen core & shared runtime modules into a single
          // core-runtime chunk to avoid 13 fragmented micro-chunks and improve gzip density (§8).
          if (
            norm.includes('/node_modules/ts-fsrs/') ||
            norm.includes('/packages/core/src/ids.ts') ||
            norm.includes('/packages/core/src/hlc.ts') ||
            norm.includes('/packages/core/src/model/') ||
            norm.includes('/packages/core/src/events/types.ts') ||
            norm.includes('/packages/core/src/events/replay.ts') ||
            norm.includes('/packages/core/src/fsrs/') ||
            norm.includes('/packages/core/src/study/queue.ts') ||
            norm.includes('/packages/core/src/parsers/') ||
            norm.includes('/packages/core/src/audio/tts.ts') ||
            norm.includes('/packages/core/src/sources/hash.ts') ||
            norm.includes('/packages/core/src/sync/types.ts') ||
            norm.includes('/packages/ui/src/components/RichText.tsx') ||
            norm.includes('/packages/ui/src/state/AppContext.tsx') ||
            norm.includes('/packages/ui/src/state/useAudioController.ts') ||
            norm.includes('/packages/ui/src/state/useSyncController.ts')
          ) {
            return 'core-runtime';
          }
          return undefined;
        },
      },
    },
  },
});
