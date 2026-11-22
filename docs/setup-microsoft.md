# Microsoft Entra Setup Guide (OneDrive Storage Connector, Phase 12)

OneDrive is a **storage connector**, not an app account (see Phase 14 in
[`design_blueprint.md`](./design_blueprint.md)). The app never creates a Microsoft-backed user
profile. A Microsoft sign-in only grants access to:

- the app's own OneDrive folder, for sync (`/me/drive/special/approot`, `Files.ReadWrite.AppFolder`)
- read-only file access, for the optional file picker (`Files.Read`). The picker asks for this only
  when someone uses it.

The connector is off until a client ID is configured. Builds without `VITE_MS_CLIENT_ID` show no
OneDrive buttons, and none of the OneDrive code is downloaded.

> [!NOTE]
> Everything here is free: an Entra app registration costs nothing and Microsoft Graph has no
> per-call charge for OneDrive. The token-helper `/ms/*` routes run on the same Cloudflare Worker
> as the Google routes ([`setup-gcp-cloudflare.md`](./setup-gcp-cloudflare.md) §3).

---

## 1. Register the app in Microsoft Entra

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com) and go to **App registrations > New registration**.
   Any Microsoft account works; you don't need a paid Azure subscription.
2. **Name:** your app's store name, for example `Flashcards`. People see it on the consent screen.
3. **Supported account types:** choose **Personal Microsoft accounts only**.
   - This matches the default tenant `consumers`.
   - Work and school accounts often block `Files.ReadWrite.AppFolder` or need admin consent.
   - To support them, pick _Accounts in any organizational directory and personal Microsoft accounts_ and set the tenant to `common` (see §4).
4. Leave the redirect URI empty for now and click **Register**.
5. Copy the **Application (client) ID**. You need it for both the token-helper and the app build.

## 2. Add the redirect URIs

Go to **Authentication > Add a platform**. The app uses two platform types.

### 2.1 Web: the PWA, through the token-helper

Add a **Web** platform. Don't use "Single-page application". The token-helper redeems the code as a
confidential client, with a client secret. Microsoft limits SPA-registered clients to 24-hour
refresh tokens, so people would have to sign in again every day.

Enter each exact PWA origin with a trailing `/`. The app sends `origin + pathname`:

```text
http://localhost:5173/
https://<your-pages-project>.pages.dev/
https://<your-production-domain>/
```

Leave **Implicit grant and hybrid flows** unticked, because the app uses authorization code with PKCE.

### 2.2 Mobile and desktop: Tauri, Android and iOS

Add a **Mobile and desktop applications** platform with these custom redirect URIs:

| Shell                   | Redirect URI                   | Notes                                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tauri (Windows / macOS) | `http://localhost`             | Loopback PKCE (RFC 8252) through `tauri-plugin-oauth`, same as Google. Entra ignores the port for `localhost` on public clients, so the random port the plugin picks is accepted.                                                                                                  |
| Android / iOS           | `flashcards://oauth/microsoft` | `@capgo/capacitor-social-login` (generic `oauth2` provider) with PKCE. iOS already registers the `flashcards` scheme in `Info.plist`. On Android the plugin opens its own in-app sign-in view and catches the redirect there, so `AndroidManifest.xml` needs no new intent filter. |

These are public clients. They send no secret and get Microsoft's rolling refresh tokens.

- **Tauri** keeps the refresh token in the OS keychain (account `microsoft-refresh-token`).
- **Capacitor:** the social-login plugin keeps it in its own app storage (UserDefaults on iOS,
  SharedPreferences on Android), not in Keychain or Keystore.

Leave **Allow public client flows** set to **No**. That switch is only for device-code and
username/password flows, which the app doesn't use.

## 3. API permissions

Go to **API permissions > Add a permission > Microsoft Graph > Delegated permissions** and add:

| Permission                  | Why                                                                                                                          | Requested                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `Files.ReadWrite.AppFolder` | Sync: read and write only the app's own folder (`Apps/<app name>` in the user's OneDrive).                                   | On **Connect OneDrive** in Settings      |
| `offline_access`            | A refresh token, so sync keeps working without signing in again.                                                             | With the permission above                |
| `Files.Read` (optional)     | The Library > Sources **Import from OneDrive** picker: browse and download one `.csv` / `.tsv` / `.xlsx` / `.flashpkg` file. | Only when someone first opens the picker |

Remove the default `User.Read` permission if you like; the app never reads the profile. None of
these permissions need admin consent for personal accounts.

## 4. Client secret and token-helper secrets

1. Go to **Certificates & secrets > Client secrets > New client secret** and pick an expiry (24 months
   at most). Copy the secret **Value** (not the Secret ID) right away; it is shown only once.
2. Set the Worker secrets. They are stored encrypted by Cloudflare and never committed:

   ```powershell
   pnpm --filter @flash/token-helper exec wrangler secret put MS_CLIENT_ID
   pnpm --filter @flash/token-helper exec wrangler secret put MS_CLIENT_SECRET
   ```

3. Optionally set the tenant. It defaults to `consumers`. Use `common` for personal plus work/school
   accounts, or a tenant ID or domain for a single organization:

   ```powershell
   pnpm --filter @flash/token-helper exec wrangler secret put MS_TENANT
   ```

4. Redeploy and check:

   ```powershell
   pnpm --filter @flash/token-helper deploy
   ```

The `/ms/exchange` and `/ms/refresh` routes follow the same rules as the Google ones:

- stateless, with no storage and no logging of tokens
- `ALLOWED_ORIGINS` is enforced
- they accept only the scope allowlist (`Files.ReadWrite.AppFolder`, `Files.Read`, `offline_access`, plus `openid` / `profile` / `User.Read`)

Until `MS_CLIENT_ID` and `MS_CLIENT_SECRET` are set, both routes answer `500 server_misconfigured`.
The Google routes are unaffected.

> [!IMPORTANT]
> Client secrets expire. Put a calendar reminder before the expiry date, create the new secret,
> `wrangler secret put MS_CLIENT_SECRET`, then delete the old one. When the secret is expired,
> connecting and refreshing OneDrive fail on the web only. Native shells don't use the secret.

## 5. Build the app with the client ID

Set these when building `apps/web`. The same bundle is used by the Tauri and Capacitor shells:

```text
VITE_MS_CLIENT_ID=<Application (client) ID>
# Optional, must match MS_TENANT on the token-helper (default: consumers)
VITE_MS_TENANT=consumers
```

On the web, OneDrive also needs the token-helper URL (`VITE_TOKEN_HELPER_URL`, or the built-in
default). Builds always use `VITE_MS_CLIENT_ID`. For testing only, the Vite dev server (`pnpm dev`)
accepts a `?msClientId=<id>` override, and the e2e suite sets `window.__FLASH_TEST_MS_CLIENT_ID__`
from a Playwright init script. Production and preview builds ignore the query parameter, so a link
cannot point the app at a different Entra app.

**Content Security Policy:**

- The app calls these origins:
  - `https://graph.microsoft.com`
  - `https://login.microsoftonline.com` (native token requests)
  - the OneDrive download and upload hosts (`*.files.1drv.com`, `*.1drv.com`, `*.sharepoint.com`,
    `api.onedrive.com`, and `*.microsoftpersonalcontent.com`, which recent personal-account
    download URLs use; not checked against live Graph)
- Sign-in is a top-level navigation, and the picker is built into the app (no Microsoft iframe or script).
- If your deployment narrows `connect-src`, allow those origins.
- The Tauri shell already allows `https://login.microsoftonline.com/*` in `capabilities/default.json`.

## 6. Verify

1. **Settings > Sync > Connect OneDrive.** Sign in with a personal Microsoft account and accept the
   _"access its own folder"_ consent. The status should reach **Synced**, and an `Apps/<app name>`
   folder appears in OneDrive on the web.
2. On a second device or browser, connect the same account. Reviews converge after **Sync now**.
3. **Library > Sources > Import from OneDrive.** Allow read-only file access once, then pick a `.csv`.
   Picker access doesn't turn on OneDrive sync.
4. To revoke access, go to [account.live.com/consent/Manage](https://account.live.com/consent/Manage).
   The app then shows **Reconnect OneDrive**.
