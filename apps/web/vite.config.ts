import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const DEFAULT_TOKEN_HELPER_URL = 'https://flashcards-token-helper.yodc.workers.dev';

function resolveTokenHelperOrigin(): string {
  const raw = process.env['VITE_TOKEN_HELPER_URL']?.trim() || DEFAULT_TOKEN_HELPER_URL;
  try {
    return new URL(raw).origin;
  } catch {
    return new URL(DEFAULT_TOKEN_HELPER_URL).origin;
  }
}

function productionCspPlugin(): Plugin {
  const tokenHelperOrigin = resolveTokenHelperOrigin();
  return {
    name: 'production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const connectSrc = [
        "'self'",
        'https://www.googleapis.com',
        'https://oauth2.googleapis.com',
        tokenHelperOrigin,
      ].join(' ');
      const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src ${connectSrc}; object-src 'none'; base-uri 'self'; form-action 'self'; worker-src 'self'; manifest-src 'self';`;
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
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        ignoreURLParametersMatching: [
          /^device$/,
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
  build: {
    target: 'es2023',
    sourcemap: false,
  },
});
