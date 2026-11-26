/**
 * Real Tauri v2 plugin adapters for the injected interfaces in `@flash/platform-tauri`
 * (§10.1, §11, §15 Phase 8). Only imported from `./boot.ts`, which `apps/web` loads lazily
 * when it detects the Tauri runtime, so none of this reaches the PWA's initial chunk.
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  exists,
  mkdir,
  readDir,
  readFile,
  rename,
  stat,
  watch,
  writeFile,
} from '@tauri-apps/plugin-fs';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import {
  isPermissionGranted,
  requestPermission as requestNotificationPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { openUrl } from '@tauri-apps/plugin-opener';
import Database from '@tauri-apps/plugin-sql';
import type { Files, PickedFile } from '@flash/platform';
import { isPickerCallback, type SystemBrowserLauncher } from '@flash/platform-capacitor';
import type { SecureSecretBackend } from '../auth/refresh-token-store.ts';
import type { TauriLoopbackOAuthPlugin } from '../auth/tauri-google-auth.ts';
import type { DesktopNotificationBridge } from '../reminders/desktop-reminders.ts';
import { createAddDeviceUrlSourceFrom } from './add-device-url.ts';
import { runLoopbackSignIn } from './loopback-sign-in.ts';
import { watchDirectoryWith } from './watch-directory.ts';
import {
  awaitBrowserCallback,
  createLatestAttempt,
  PICKER_CALLBACK_TIMEOUT_MS,
} from './browser-callback.ts';
import { openTauriSaveStream } from '../files/tauri-stream.ts';
import type { TauriFsBridge, TauriFsDirEntry } from '../sources/tauri-fs-watcher.ts';
import type { TauriSqlPluginDatabase } from '../storage/tauri-sqlite-storage.ts';
import { resolveTauriICloudOptions, type TauriICloudOptions } from '../sync/tauri-icloud-bridge.ts';

// ---------------------------------------------------------------------------
// SQLite (tauri-plugin-sql, `sqlite:flashcards.db` in the app config dir)
// ---------------------------------------------------------------------------

export async function openTauriDatabase(path = 'sqlite:flashcards.db'): Promise<Database> {
  return Database.load(path);
}

export function asSqlPluginDatabase(db: Database): TauriSqlPluginDatabase {
  return {
    execute: async (query, bindValues) => {
      const res = await db.execute(query, bindValues);
      return { rowsAffected: res.rowsAffected };
    },
    select: async <T = Record<string, unknown>>(query: string, bindValues?: unknown[]) =>
      db.select<T[]>(query, bindValues),
    // App command over the plugin's pool (apps/desktop/src-tauri/src/sql_batch.rs).
    executeBatch: async (statements) => {
      await invoke('sql_execute_batch', {
        db: db.path,
        statements: statements.map((s) => ({ sql: s.sql, params: [...s.params] })),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// OS keychain (app commands in apps/desktop/src-tauri/src/secure_store.rs)
// ---------------------------------------------------------------------------

export function createSecureSecretBackend(): SecureSecretBackend {
  return {
    isAvailable: () => invoke<boolean>('secure_store_available'),
    get: async (account) =>
      (await invoke<string | null>('secure_store_get', { account })) ?? undefined,
    set: async (account, secret) => {
      await invoke('secure_store_set', { account, secret });
    },
    delete: async (account) => {
      await invoke('secure_store_delete', { account });
    },
  };
}

// ---------------------------------------------------------------------------
// iCloud Drive (app commands in apps/desktop/src-tauri/src/icloud.rs; macOS only)
// ---------------------------------------------------------------------------

/** The iCloud plugin on entitled macOS builds and whether iCloud was available at launch. */
export function createICloudOptions(): Promise<TauriICloudOptions> {
  return resolveTauriICloudOptions(invoke);
}

// ---------------------------------------------------------------------------
// Study reminders (tauri-plugin-notification)
// ---------------------------------------------------------------------------

export function createDesktopNotificationBridge(): DesktopNotificationBridge {
  return {
    isPermissionGranted: () => isPermissionGranted(),
    requestPermission: () => requestNotificationPermission(),
    notify: ({ title, body }) => sendNotification({ title, body }),
  };
}

// ---------------------------------------------------------------------------
// Filesystem + watcher (tauri-plugin-fs `watch` feature + tauri-plugin-dialog)
// ---------------------------------------------------------------------------

function parentDir(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx > 0 ? norm.slice(0, idx) : norm;
}

function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return norm.slice(norm.lastIndexOf('/') + 1) || norm;
}

export function createFsBridge(): TauriFsBridge {
  const listRecursive = async (root: string, rel: string, out: TauriFsDirEntry[]) => {
    const dir = rel ? `${root}/${rel}` : root;
    for (const entry of await readDir(dir)) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await listRecursive(root, childRel, out);
      } else if (entry.isFile) {
        const info = await stat(`${root}/${childRel}`);
        out.push({
          relativePath: childRel,
          name: entry.name,
          size: info.size,
          lastModified: info.mtime ? info.mtime.getTime() : 0,
        });
      }
    }
  };

  return {
    pickDirectory: async () => {
      // tauri-plugin-dialog adds the picked folder to the fs scope; tauri-plugin-persisted-scope
      // keeps it allowed across restarts so `restoreLocalSyncFolder` works.
      const picked = await openDialog({ directory: true, multiple: false, recursive: true });
      if (typeof picked !== 'string') return null;
      return { path: picked.replace(/\\/g, '/'), name: baseName(picked) };
    },
    listDirectoryFiles: async (rootPath) => {
      const out: TauriFsDirEntry[] = [];
      await listRecursive(rootPath.replace(/[/\\]+$/, ''), '', out);
      return out;
    },
    readFileBytes: async (absPath, maxBytes) => {
      if (maxBytes !== undefined) {
        const info = await stat(absPath);
        if (info.size > maxBytes) {
          throw new Error(`File exceeds ${maxBytes} bytes: ${absPath}`);
        }
      }
      return readFile(absPath);
    },
    writeFileBytes: async (absPath, data, opts) => {
      await mkdir(parentDir(absPath), { recursive: true });
      if (opts?.ifAbsent) {
        if (await exists(absPath)) {
          throw new Error(`File already exists: ${absPath}`);
        }
        await writeFile(absPath, data, { createNew: true });
        return;
      }
      await writeFile(absPath, data);
    },
    moveFile: async (fromPath, toPath) => {
      await mkdir(parentDir(toPath), { recursive: true });
      await rename(fromPath, toPath);
    },
    pathExists: (absPath) => exists(absPath),
    watchDirectory: (rootPath, onChange) => watchDirectoryWith(watch, rootPath, onChange),
  };
}

export function createDesktopFiles(fsBridge: TauriFsBridge): Files {
  return {
    pickFile: async (options): Promise<PickedFile | null> => {
      const extensions = (options?.accept ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('.'))
        .map((s) => s.slice(1));
      const picked = await openDialog({
        multiple: false,
        directory: false,
        ...(extensions.length > 0 ? { filters: [{ name: 'Supported files', extensions }] } : {}),
      });
      if (typeof picked !== 'string') return null;
      const name = baseName(picked);
      if (options?.maxBytes !== undefined) {
        const { size } = await stat(picked);
        if (size > options.maxBytes)
          return { name, bytes: new Uint8Array(0), size, tooLarge: true };
      }
      return { name, bytes: await readFile(picked) };
    },
    downloadFile: async (filename, data) => {
      const target = await saveDialog({ defaultPath: filename });
      if (!target) return;
      await writeFile(target, data);
    },
    saveStream: (filename) =>
      openTauriSaveStream(
        {
          save: (o) => saveDialog(o),
          writeFile: (path, data, o) => writeFile(path, data, o),
        },
        filename,
      ),
    pickDirectory: async () => fsBridge.pickDirectory(),
  };
}

// ---------------------------------------------------------------------------
// System browser + `flashcards://picker-callback` (tauri-plugin-opener + tauri-plugin-deep-link)
// ---------------------------------------------------------------------------

export function createSystemBrowserLauncher(): SystemBrowserLauncher {
  // Opening the picker again while an earlier one is still waiting replaces the earlier one (N6).
  const latestAttempt = createLatestAttempt();
  return {
    openAndAwaitDeepLink: ({ url, callbackScheme, state }) =>
      latestAttempt((signal) => {
        return awaitBrowserCallback({
          subscribe: (cb) => onOpenUrl((urls) => urls.forEach(cb)),
          open: () => openUrl(url),
          // Exact host, not a prefix (`picker-callback.evil`), and this pick's `state` (S10).
          accept: (u) => isPickerCallback(u, callbackScheme, state),
          timeoutMs: PICKER_CALLBACK_TIMEOUT_MS,
          signal,
          label: 'Choosing files in Google Drive',
        });
      }),
  };
}

// ---------------------------------------------------------------------------
// `flashcards://add-device?...` (tauri-plugin-deep-link; the scheme is registered for every host)
// ---------------------------------------------------------------------------

/** Every `flashcards://add-device` URL the OS opens the app with (see `add-device-url.ts`). */
export function createAddDeviceUrlSource(): (handler: (url: string) => void) => () => void {
  return createAddDeviceUrlSourceFrom({ getCurrent, onOpenUrl });
}

// ---------------------------------------------------------------------------
// Loopback Google OAuth (tauri-plugin-oauth + PKCE, RFC 8252)
// ---------------------------------------------------------------------------

export interface LoopbackOAuthConfig {
  /** Google OAuth client of type "Desktop app". */
  clientId: string;
  /**
   * Google issues a client secret to Desktop-app clients and requires it at the token
   * endpoint; it is not confidential for installed apps (RFC 8252 §8.5).
   */
  clientSecret?: string;
  /** Where the refresh token is kept (the OS keychain, or SQLite when none is available). */
  tokenStore: {
    get(): Promise<string | undefined>;
    set(token: string): Promise<void>;
    delete(): Promise<void>;
  };
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

const SUCCESS_HTML =
  '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
  '<body style="font-family:system-ui;padding:2rem">Signed in. You can close this tab and return to Flashcards.</body>';

export function createLoopbackOAuthPlugin(config: LoopbackOAuthConfig): TauriLoopbackOAuthPlugin {
  const tokenRequest = async (body: Record<string, string>): Promise<GoogleTokenResponse> => {
    // tauri-plugin-http performs the request from Rust (no WebView CORS restrictions).
    const res = await tauriFetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
        ...body,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Google token endpoint returned ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as GoogleTokenResponse;
  };

  // A second sign-in while the first browser tab is still open replaces the first attempt (N6).
  const latestAttempt = createLatestAttempt();

  return {
    authorizeWithSystemBrowser: ({ scopes }) =>
      latestAttempt((signal) =>
        runLoopbackSignIn(
          {
            provider: 'Google',
            successHtml: SUCCESS_HTML,
            signal,
            buildAuthUrl: ({ redirectUri, challenge, state }) => {
              const authUrl = new URL(GOOGLE_AUTH_URL);
              authUrl.search = new URLSearchParams({
                client_id: config.clientId,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: scopes.join(' '),
                code_challenge: challenge,
                code_challenge_method: 'S256',
                state,
                access_type: 'offline',
                prompt: 'consent',
              }).toString();
              return authUrl.toString();
            },
          },
          async ({ code, verifier, redirectUri }) => {
            const tokens = await tokenRequest({
              grant_type: 'authorization_code',
              code,
              code_verifier: verifier,
              redirect_uri: redirectUri,
            });
            // Never keep an older refresh token (possibly another account) past a new sign-in.
            if (tokens.refresh_token) await config.tokenStore.set(tokens.refresh_token);
            else await config.tokenStore.delete();
            return {
              accessToken: tokens.access_token,
              expiresInSeconds: tokens.expires_in,
              ...(tokens.scope ? { scope: tokens.scope } : {}),
            };
          },
        ),
      ),
    refreshAccessToken: async () => {
      const refreshToken = await config.tokenStore.get();
      if (!refreshToken) throw new Error('Not signed in to Google.');
      const tokens = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      if (tokens.refresh_token) await config.tokenStore.set(tokens.refresh_token);
      return { accessToken: tokens.access_token, expiresInSeconds: tokens.expires_in };
    },
    revokeSession: async () => {
      const refreshToken = await config.tokenStore.get();
      await config.tokenStore.delete();
      if (refreshToken) {
        await tauriFetch(GOOGLE_REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refreshToken }).toString(),
        }).catch(() => undefined);
      }
    },
  };
}
