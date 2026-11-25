# Dropbox Setup Guide (App Folder Sync & Linked Sources)

Dropbox is a **storage connector**, not an app account (see §4.3 & §12 in
[`design_blueprint.md`](./design_blueprint.md)). The app never creates a Dropbox-backed user
profile. One Dropbox sign-in grants access only to the app's own **App Folder**
(`Dropbox › Apps › <your app name>`) and powers both:

- **Cloud Sync** (`Settings › Cloud Sync`): stores append-only event segments, snapshots, and media
  inside `sync/` and `media/` in the App Folder.
- **Linked Sources & Imports** (`Library › Linked Sources › Dropbox file…`): browses spreadsheets
  (`.csv`, `.tsv`, `.xlsx`) and `.flashpkg` files you place in `Dropbox › Apps › <your app name>`,
  hiding the internal `sync/` and `media/` folders.

Because Dropbox supports public PKCE clients with offline refresh tokens (`token_access_type=offline`)
directly from browsers and native shells, **no client secret and no token-helper Worker are needed**.
Builds without `VITE_DROPBOX_APP_KEY` hide all Dropbox buttons and never download the Dropbox code.

---

## 1. Create an App Folder app in the Dropbox App Console

1. Open the [Dropbox App Console](https://www.dropbox.com/developers/apps) and click **Create app**.
2. **Choose an API:** `Scoped access`.
3. **Choose the type of access you need:** **`App folder`** (access to a single folder created
   specifically for your app).
   - Do **not** choose _Full Dropbox_: App Folder keeps the app isolated to `Dropbox/Apps/<name>/`
     and avoids Dropbox's production review for full-drive access.
4. **Name your app:** e.g. `Flashcards` (must be globally unique on Dropbox; this also names the
   user's `Dropbox/Apps/<name>/` folder).
5. Click **Create app**. On the **Settings** tab, copy the **App key** (you do **not** need the
   App secret).

---

## 2. Configure Permissions (Scopes)

Open the **Permissions** tab and enable these **Individual Scopes**, then click **Submit**:

| Scope                 | Why                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `files.metadata.read` | List folders/files in the App Folder and check `content_hash` / `rev` before downloading. |
| `files.content.read`  | Download sync segments, media, and linked `.csv` / `.tsv` / `.xlsx` / `.flashpkg` files.  |
| `files.content.write` | Upload sync segments, snapshots, and media during Cloud Sync.                             |

> [!NOTE]
> If you previously configured Dropbox for sync only, verify `files.metadata.read` and
> `files.content.read` are enabled and click **Submit**. Existing signed-in devices may need to
> disconnect and reconnect once if their earlier token did not include `files.metadata.read`.

---

## 3. Add OAuth 2 Redirect URIs

On the **Settings** tab under **OAuth 2 › Redirect URIs**, add every exact URI your builds use.
Dropbox requires **exact string matching** (including trailing slashes and port numbers):

| Shell                     | Redirect URI                                                                         | Notes                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web (local dev)           | `http://localhost:5173/`                                                             | `origin + pathname` of the Vite dev server.                                                                                                                                                                                                                                                                                      |
| Web (production PWA)      | `https://<your-pages-project>.pages.dev/` and/or `https://<your-production-domain>/` | Add each hosted PWA origin with its trailing `/`.                                                                                                                                                                                                                                                                                |
| Android & iOS (Capacitor) | `flashcards://oauth/dropbox`                                                         | PKCE in Chrome Custom Tabs (Android) / `ASWebAuthenticationSession` (iOS) via `@capgo/capacitor-social-login`. Caught by the existing `flashcards://oauth` intent filter in `AndroidManifest.xml` and `flashcards` URL scheme in `Info.plist`. Refresh token is stored only in Keychain / Keystore (`dropbox_refresh_token_v1`). |
| Desktop (Tauri)           | `http://127.0.0.1:53682` (and optionally `http://127.0.0.1:53683`)                   | Loopback PKCE via `tauri-plugin-oauth`. Unlike Google/Microsoft, Dropbox does not allow dynamic ports on localhost, so the desktop shell binds to port `53682` (falling back to `53683`). Refresh token is stored in the OS keychain (`dropbox-refresh-token`).                                                                  |

---

## 4. Build the app with `VITE_DROPBOX_APP_KEY`

Set the public App Key when building `apps/web` (the same bundle is wrapped by Capacitor and Tauri):

```text
VITE_DROPBOX_APP_KEY=<your Dropbox App key>
```

For local testing only, the Vite dev server (`pnpm dev`) accepts `?dropboxAppKey=<key>`, and the
Playwright e2e suite sets `window.__FLASH_TEST_DROPBOX_APP_KEY__` from an init script. Production
and preview builds ignore the query parameter.

**Content Security Policy (`connect-src`):**

- `https://api.dropboxapi.com`
- `https://content.dropboxapi.com`
- Tauri already allows `https://api.dropboxapi.com/*` in `apps/desktop/src-tauri/capabilities/default.json`.

---

## 5. Using Dropbox Linked Sources

1. Put your `.csv`, `.tsv`, `.xlsx`, or `.flashpkg` files inside **`Dropbox › Apps › <your app name>`**
   (subfolders like `Decks/` work too).
2. In the app, open **Library › Linked Sources › Dropbox file…** and connect Dropbox (reuses the
   same sign-in if you already connected Dropbox Sync; connecting from Sources does not overwrite
   an existing sync provider).
3. Tap a file for a one-shot import, or tap **Link** on a `.csv` / `.tsv` / `.xlsx` file to map
   columns and link it as a live read-only source. Refreshing checks Dropbox's `content_hash`/`rev`
   first and skips downloading unchanged files.
