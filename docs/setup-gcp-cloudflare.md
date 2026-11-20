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

---

## 4. Deploy the Phase 0 Spike PWA Harness (`spikes/phase0/`) to Cloudflare Pages

Deploy the static throwaway harness (HTTPS required for iOS Home-Screen PWA & Google OAuth):

```powershell
pnpm --filter @flash/token-helper exec wrangler pages deploy spikes/phase0 --project-name flashcards-phase0-spike
```

_(If your deployed Pages URL differs from `https://flashcards-phase0-spike.pages.dev`, update both the GCP OAuth authorized redirect URI and the Worker's `ALLOWED_ORIGINS` secret.)_

---

## 5. Run the Interactive Device Verification Checklist

1. **Windows Chrome/Edge (Spike 0.4 + 0.2 + 0.3 + 0.6 + 0.7):**
   - Open your deployed Pages URL (or `pnpm dlx vite spikes/phase0 --port 5173`), install it as a PWA, and run:
     - **Spike 0.4:** Pick a folder under `G:\My Drive\...`, close and reopen the installed PWA, click **Restore Handle & Check Permission**, then **Request Permission & Scan Files**.
     - **Spike 0.2:** Paste your Web Client ID + Worker URL → **Ping Worker /health** → **Sign In (Redirect + PKCE)** → **Test `/auth/refresh`** → **Test `appDataFolder` CRUD**.
     - **Spike 0.3:** Paste your Browser API Key → **Open Google Picker (Multi-Select)** → select a test Sheet & Doc → test **Read Selected Sheet (FORMULA)**, **Test Guarded Card ID batchUpdate**, and **Export Selected Doc as Markdown**.
     - **Spike 0.6:** Open **Drawing Quiz Spike** and complete a stroke quiz on `食` (Japanese KanjiVG 9 strokes) vs. `食` (Simplified Chinese).
     - **Spike 0.7:** Test browser CORS fetch + optional BYO Cloud TTS playback.
2. **iOS Safari Home-Screen PWA (Spikes 0.1 & 0.2):**
   - Open the Pages URL in iOS Safari → **Share → Add to Home Screen** → launch from Home Screen.
   - Run **Inspect PWA / Safe Areas** (`STANDALONE PWA` badge), **Request Storage Persist & IDB Test**, flip the hardware **Silent Switch ON**, tap **Unlock & Play 1.0×** and **Play 0.75× (Slow)**.
   - Enable **Airplane Mode**, force-quit & relaunch the Home-Screen PWA, verify offline load + offline chime playback + persisted IndexedDB sentinel.
   - Disable Airplane Mode and run **Spike 0.2 Sign In (Redirect + PKCE)** from the Home-Screen PWA to confirm whether iOS returns directly into standalone mode (or note if Safari fallback handling is needed for Phase 2).
