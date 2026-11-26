# GCP & Cloudflare Setup Guide (Phase 0 Spikes & Phase 2 Sync)

This guide sets up the minimal cloud pieces required for **Spikes 0.1, 0.2, 0.3, and 0.7b** (and directly reused in Phase 2 Cloud Sync and Phase 3 Sheets/Docs Sources) using temporary `*.workers.dev` and `*.pages.dev` preview URLs.

> [!NOTE]
> Everything in Phase 0 and Phase 2 runs inside the **free tier**: GCP OAuth + Drive/Sheets/Docs APIs have zero monthly cost, and Cloudflare Workers/Pages free tier covers 100k requests/day. Your GCP bonus credits only matter if you optionally test Cloud TTS (Spike 0.7b) beyond its free tier.

---

## 1. Enable Required Google Cloud APIs

Sign in to `gcloud` and select your GCP project:

```powershell
gcloud auth login
gcloud config set project YOUR_GCP_PROJECT_ID
```

Enable the exact APIs used across Phases 2, 3, and 5:

```powershell
gcloud services enable `
  drive.googleapis.com `
  sheets.googleapis.com `
  docs.googleapis.com `
  picker.googleapis.com `
  texttospeech.googleapis.com
```

---

## 2. Configure Google OAuth Consent Screen & Credentials

In **Google Cloud Console → Google Auth Platform (APIs & Services → OAuth consent screen)**:

1. **Audience:** `External` (add your own Google account under **Test users** while in Testing mode; publish to Production before sharing with family so refresh tokens don't expire after 7 days).
2. **Data Access (Scopes):** Add **only** these two **non-restricted** scopes (no CASA security audit required):
   - `https://www.googleapis.com/auth/drive.appdata`
   - `https://www.googleapis.com/auth/drive.file`
3. **Create OAuth 2.0 Client ID (Web application):**
   - **Authorized JavaScript origins:**
     - `http://localhost:5173`
     - `https://flashcards-phase0-spike.pages.dev` (replace with your deployed Pages URL)
   - **Authorized redirect URIs:**
     - `http://localhost:5173/`
     - `https://flashcards-phase0-spike.pages.dev/`
   - Save the **Client ID** and **Client Secret**.
4. **Create Browser API Key (for Google Picker in Spike 0.3 & optional Cloud TTS in Spike 0.7b):**
   - Go to **APIs & Services → Credentials → Create credentials → API key**.
   - Under **Application restrictions**, select **Websites** and allow:
     - `http://localhost:5173/*`
     - `https://flashcards-phase0-spike.pages.dev/*`
   - Under **API restrictions**, restrict the key to **Google Picker API** (and optionally **Cloud Text-to-Speech API** for Spike 0.7b).

> [!NOTE]
> **Linking plain Drive files (`.csv` / `.tsv` / `.xlsx` / `.flashpkg`)** needs no new scope, API or console setting: it uses the same `drive.file` scope, the **Google Drive API** (already enabled for sync) for `files.get` metadata and `alt=media` downloads, and the same Picker API key. The Picker filters by MIME type in code (`GOOGLE_DRIVE_PICKER_MIME_TYPES` in `packages/platform-web/src/sources/google-drive-files.ts`, mirrored in `apps/web/public/picker.html`): Sheets, Docs, `text/csv`, `text/tab-separated-values`, `application/vnd.ms-excel` (how Windows often uploads `.csv`), the `.xlsx` type, and `application/octet-stream` / `application/zip` / `application/x-zip-compressed` (how Drive stores `.flashpkg`). The app checks the picked file's name before reading it. Native shells open `picker.html` from `VITE_PICKER_PAGE_URL` with `mode=drive_files`, so **redeploy the web app** (which carries the new `picker.html`) before testing Drive files in an Android/iOS/desktop build. `drive.file` grants are per Cloud project, so a file picked on one device opens on the user's other devices as long as all OAuth clients live in this project.

> [!TIP]
> **Cross-client `appDataFolder` check (Spike 0.2):** Later in Phase 8 when adding Android/iOS Capacitor OAuth Client IDs, create them inside this **same GCP project** — Google scopes `appDataFolder` per GCP project, so Web, Android, and iOS clients share the identical hidden sync store automatically.

---

## 3. Deploy the Stateless Token Helper (`apps/token-helper`) to Cloudflare Workers

Authenticate `wrangler` once:

```powershell
pnpm --filter @flash/token-helper exec wrangler login
```

Set the 3 runtime secrets (stored encrypted by Cloudflare; never committed to Git):

```powershell
pnpm --filter @flash/token-helper exec wrangler secret put GOOGLE_CLIENT_ID
pnpm --filter @flash/token-helper exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm --filter @flash/token-helper exec wrangler secret put ALLOWED_ORIGINS
```

When prompted for `ALLOWED_ORIGINS`, enter a comma-separated list of exact origins (no trailing slash):

```text
http://localhost:5173,https://flashcards-phase0-spike.pages.dev
```

Deploy the Worker:

```powershell
pnpm --filter @flash/token-helper deploy
```

Note the printed `https://flashcards-token-helper.<subdomain>.workers.dev` URL and verify:

```powershell
curl https://flashcards-token-helper.<subdomain>.workers.dev/health
# Expected: {"ok":true,"stateless":true}
```

The token routes accept only requests whose `Origin` is in `ALLOWED_ORIGINS`, refuse bodies over 16 KiB, and allow 20 requests a minute per IP and route. The limit is the `[[ratelimits]]` block in `apps/token-helper/wrangler.toml`; a client over it gets `429` with `Retry-After: 60`.

The same Worker also serves the OneDrive storage connector's `/ms/exchange` and `/ms/refresh` routes. To turn OneDrive on, register a Microsoft Entra app and set `MS_CLIENT_ID` / `MS_CLIENT_SECRET` as described in [`setup-microsoft.md`](./setup-microsoft.md).

---

## 4. Phase 0 Spike Harness (retired)

The throwaway Phase 0 harness (`spikes/phase0/`) has been removed; do not deploy it. Its findings are recorded in [ADR 0001](./adr/0001-phase0-spike-results.md). Check sign-in, Drive sync, the Picker and audio on devices with the real PWA (`pnpm build`, then host `apps/web/dist`), using that host's URL wherever this guide shows `https://flashcards-phase0-spike.pages.dev`.

---

## 5. Content Security Policy for the Production PWA Host (WASM Workers)

The single source of truth is `apps/web/csp.ts`. `pnpm build` writes `PRODUCTION_CSP` into `dist/index.html` as a `<meta http-equiv="Content-Security-Policy">` tag; `apps/web/tests/csp.test.ts` checks that this section, the Tauri shell and the shared policy agree, and the `phase11-fsrs-optimizer.spec.ts` "production CSP header" e2e tests run the optimizer with these headers on every response.

**Why the host matters.** A meta-tag CSP applies to the document only. A dedicated Worker (the FSRS optimizer `fsrs-optimizer.worker-<hash>.js`, the replay and handwriting workers, and the Anki `.apkg` SQLite reader) does **not** inherit it: the browser applies the CSP **header of the Worker script's own response**, and nothing if there is none. The Worker compiles WebAssembly, which a CSP only allows with `'wasm-unsafe-eval'` in `script-src`. So:

- With **no CSP header** on `/assets/*.js` (a bare static host, `vite preview`), Workers are unrestricted and the optimizer works.
- With **any CSP header** on `/assets/*.js` (for example a blanket `/*` rule), that header must contain `script-src … 'wasm-unsafe-eval'` and `connect-src 'self'` (the Worker fetches its `.wasm` from the app origin), or the optimizer fails with "Optimization failed".

**What the host must send.**

| Response                                 | Header                    | Value                                                                                             | Required?                                                                                                                                             |
| ---------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html` and the SPA fallback        | `Content-Security-Policy` | the policy below, byte-for-byte (a header and the meta tag are both enforced, so they must agree) | Optional (the meta tag already applies); recommended                                                                                                  |
| `/assets/*.js` (Worker scripts included) | `Content-Security-Policy` | the same policy                                                                                   | Required **only if** the host sends any CSP header on these files                                                                                     |
| `/sw.js`, `/workbox-*.js`                | `Content-Security-Policy` | the same policy, or none                                                                          | As above                                                                                                                                              |
| `/assets/*.wasm`                         | `Content-Type`            | `application/wasm`                                                                                | Required for streaming compile (`fsrs-browser` falls back to a slower non-streaming compile otherwise); no CSP header is needed on the `.wasm` itself |
| every response                           | `X-Content-Type-Options`  | `nosniff`                                                                                         | Recommended                                                                                                                                           |

Do **not** send `Cross-Origin-Embedder-Policy` / `Cross-Origin-Opener-Policy`: the optimizer runs single-threaded and needs no cross-origin isolation, and COOP would break the Google sign-in and Picker popups.

The policy (identical for the meta tag and every header):

```text
default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://apis.google.com https://www.gstatic.com https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; frame-src 'self' https://docs.google.com https://accounts.google.com; connect-src 'self' https: ipc: http://ipc.localhost; object-src 'none'; base-uri 'self'; form-action 'self'; worker-src 'self'; manifest-src 'self';
```

On **Cloudflare Pages** this is the committed `apps/web/public/_headers` file, which the build copies to `dist/`. `apps/web/tests/headers.test.ts` fails if it differs from `PRODUCTION_HEADER_CSP` (the policy above plus `frame-ancestors 'none'`) or from the block below, if the `.wasm` or `nosniff` rule is missing, or if a COOP/COEP header appears. It contains:

```text
/*
  Content-Security-Policy: <the policy above, on one line> frame-ancestors 'none';
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff

/assets/*.wasm
  Content-Type: application/wasm
```

`frame-ancestors 'none'` is header-only (the meta tag cannot carry it), so no site can frame the app; `X-Frame-Options: DENY` covers browsers without `frame-ancestors`. Keep every other directive identical.

**Native shells.**

- **Tauri (desktop):** `apps/desktop/src-tauri/tauri.conf.json` `app.security.csp` is `TAURI_CSP` from `apps/web/csp.ts` (with `'wasm-unsafe-eval'` and `worker-src 'self'`). Tauri adds it to the HTML it serves; if a Tauri version also attaches it to script responses, the Worker gets the same policy, which allows WASM.
- **Capacitor (Android/iOS):** Capacitor has no CSP setting and sends no CSP headers; the meta tag in `index.html` governs the document and Workers run under no CSP. Nothing to configure. `'wasm-unsafe-eval'` needs Chromium 97+ / Safari 16+ WebViews; older WebViews ignore it, which only matters for WASM compiled on the main thread.

**Policy notes for upcoming features.** `'wasm-unsafe-eval'` also covers the Anki `.apkg` SQLite (and any zstd) WASM, in a Worker or on the main thread. Workers must be same-origin files (`new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`); `blob:` workers (Vite `?worker&inline`) are blocked by `worker-src 'self'`. Microsoft Graph calls, OneDrive download/upload URLs (`*.files.1drv.com`, `*.sharepoint.com`, `api.onedrive.com`, `*.microsoftpersonalcontent.com`) and native token requests go through `connect-src https:`. OneDrive needs no `frame-src` or `form-action` entry: the app's OneDrive picker is built on Graph, and Microsoft sign-in is a top-level navigation. The hosted OneDrive File Picker v8 (`https://onedrive.live.com/picker`, an iframe or popup opened by a form POST) is **not** allowed; adopting it later means first running its flow under this policy to find every host its frame and form POST redirect through (browsers check `frame-src` and `form-action` on redirects), then pinning those exact hosts, never a wildcard. If a deployment narrows `connect-src` below `https:`, allow the Graph, login and download hosts listed above.
