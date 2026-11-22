/**
 * Content Security Policy for every shell (§13), in one place so the PWA meta tag, the documented
 * hosting headers (docs/setup-gcp-cloudflare.md §6), the Tauri shell and the CSP tests agree.
 *
 * Strict posture: no 'unsafe-eval', no inline scripts, no wildcards on script-src.
 *
 * - `'wasm-unsafe-eval'` (script-src) allows compiling WebAssembly, and nothing else (no `eval`).
 *   The FSRS optimizer (`fsrs-browser`) and the Anki `.apkg` SQLite reader compile WASM. A
 *   dedicated Worker does not inherit the page's meta-tag CSP: it is governed by the CSP header of
 *   its own script response (none from `vite preview`, Capacitor or a bare static host), so the
 *   keyword must also be in any CSP header a host sends for `/assets/*.js` (see the docs).
 * - `worker-src 'self'`: Workers load from same-origin files only (Vite emits
 *   `new Worker(new URL('./x.worker.ts', import.meta.url))` as `/assets/x.worker-<hash>.js`).
 *   `blob:` workers (e.g. Vite `?worker&inline`) are deliberately not allowed.
 * - OneDrive (Phase 12) needs no `frame-src`, `form-action` or `script-src` entry: its file
 *   picker is built into the app on Microsoft Graph (`connect-src https:`), and sign-in is a
 *   top-level navigation. The hosted OneDrive File Picker v8 (`https://onedrive.live.com/picker`,
 *   an iframe or popup fed by a form POST) is NOT allowed; adopting it means first verifying,
 *   under this policy, every host its frame and form POST redirect through (Chrome checks
 *   `frame-src` / `form-action` on redirects too), then pinning those exact hosts, no wildcards.
 */

export type CspDirectives = ReadonlyArray<readonly [name: string, sources: readonly string[]]>;

const GOOGLE_SCRIPT_SOURCES = ['https://apis.google.com', 'https://www.gstatic.com'] as const;
const PICKER_FRAME_SOURCES = ['https://docs.google.com', 'https://accounts.google.com'] as const;

/** The PWA policy: the `index.html` meta tag, and the header a host may send for every file. */
export const PRODUCTION_CSP_DIRECTIVES: CspDirectives = [
  ['default-src', ["'self'"]],
  [
    'script-src',
    [
      "'self'",
      "'wasm-unsafe-eval'",
      ...GOOGLE_SCRIPT_SOURCES,
      'https://accounts.google.com/gsi/client',
    ],
  ],
  ['style-src', ["'self'", "'unsafe-inline'"]],
  ['img-src', ["'self'", 'blob:', 'data:']],
  ['media-src', ["'self'", 'blob:']],
  ['font-src', ["'self'"]],
  ['frame-src', ["'self'", ...PICKER_FRAME_SOURCES]],
  ['connect-src', ["'self'", 'https:', 'ipc:', 'http://ipc.localhost']],
  ['object-src', ["'none'"]],
  ['base-uri', ["'self'"]],
  ['form-action', ["'self'"]],
  ['worker-src', ["'self'"]],
  ['manifest-src', ["'self'"]],
];

/**
 * The Tauri desktop policy (`apps/desktop/src-tauri/tauri.conf.json` `app.security.csp`). Tauri
 * adds its own IPC sources and script hashes; desktop sign-in uses loopback OAuth, so Google
 * Identity Services and form posts to Google are not needed.
 */
export const TAURI_CSP_DIRECTIVES: CspDirectives = [
  ['default-src', ["'self'"]],
  ['script-src', ["'self'", "'wasm-unsafe-eval'", ...GOOGLE_SCRIPT_SOURCES]],
  ['style-src', ["'self'", "'unsafe-inline'"]],
  ['img-src', ["'self'", 'blob:', 'data:']],
  ['media-src', ["'self'", 'blob:']],
  ['font-src', ["'self'"]],
  ['frame-src', ["'self'", ...PICKER_FRAME_SOURCES]],
  ['connect-src', ["'self'", 'https:', 'ipc:', 'http://ipc.localhost']],
  ['object-src', ["'none'"]],
  ['base-uri', ["'self'"]],
  ['form-action', ["'self'"]],
  ['worker-src', ["'self'"]],
];

export function serializeCsp(directives: CspDirectives): string {
  return directives.map(([name, sources]) => [name, ...sources].join(' ')).join('; ') + ';';
}

/** Parses a policy string into `directive -> sources` (lowercased directive names). */
export function parseCsp(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), sources);
  }
  return out;
}

export const PRODUCTION_CSP = serializeCsp(PRODUCTION_CSP_DIRECTIVES);
export const TAURI_CSP = serializeCsp(TAURI_CSP_DIRECTIVES);
