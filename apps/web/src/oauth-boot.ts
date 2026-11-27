import type { SyncCursorState } from '@flash/core';
import type {
  AuthSession,
  DeviceMeta,
  PlatformServices,
  SyncConfig,
  SyncProviderKind,
} from '@flash/platform';

/**
 * Completes an OAuth redirect. OneDrive and Dropbox each return null unless the callback matches
 * their own pending PKCE state, so they run before Google (which rejects a foreign state).
 */
async function handleOAuthRedirect(
  platform: PlatformServices,
): Promise<{ session: AuthSession | null; sessionProvider: SyncProviderKind }> {
  if (platform.oneDriveConfigured && platform.getOneDriveAuth) {
    const session = await (await platform.getOneDriveAuth()).handleRedirectCallback();
    if (session) return { session, sessionProvider: 'onedrive' };
  }
  if (platform.dropboxConfigured && platform.getDropboxAuth) {
    const session = await (await platform.getDropboxAuth()).handleRedirectCallback();
    if (session) return { session, sessionProvider: 'dropbox' };
  }
  const session = await (await platform.getGoogleAuth()).handleRedirectCallback();
  return { session, sessionProvider: 'google_drive' };
}

export interface OAuthBootState {
  syncConfig: SyncConfig | undefined;
  syncCursor: SyncCursorState | undefined;
  meta: DeviceMeta;
  initialOAuthError?: string;
}

/**
 * Boot step for a page load that is an OAuth redirect (`?code=` / `?error=`). Loaded only then, so
 * the sign-in providers stay out of the initial study chunk (§8).
 */
export async function completeOAuthRedirect(
  platform: PlatformServices,
  boot: OAuthBootState,
): Promise<OAuthBootState> {
  let { syncConfig, syncCursor, meta } = boot;
  try {
    const { session, sessionProvider } = await handleOAuthRedirect(platform);
    if (session) {
      // Only switch sync provider when sign-in was initiated for sync (or no provider was configured).
      // Signing in from Library Sources keeps an existing Local Folder Sync configuration intact.
      // A OneDrive picker sign-in (Files.Read for imports) never turns on OneDrive sync by itself.
      const preserveExistingSync =
        session.intent === 'sources' &&
        (sessionProvider === 'onedrive' ||
          sessionProvider === 'dropbox' ||
          (syncConfig?.provider !== undefined && syncConfig.provider !== 'none'));
      if (!preserveExistingSync) {
        const switchingProvider = syncConfig?.provider !== sessionProvider;
        syncConfig = { provider: sessionProvider, connectedAt: Date.now() };
        await platform.storage.setSyncConfig(syncConfig);
        if (switchingProvider) {
          const { createInitialSyncCursor } = await import('@flash/core/sync');
          syncCursor = createInitialSyncCursor();
          await platform.storage.setSyncCursor(syncCursor);
          if (meta.collectionId !== undefined) {
            const { collectionId: _dropped, ...restMeta } = meta;
            meta = restMeta;
            await platform.storage.setDeviceMeta(meta);
          }
        }
      }
    }
    return { syncConfig, syncCursor, meta };
  } catch (err) {
    return {
      syncConfig,
      syncCursor,
      meta,
      initialOAuthError: err instanceof Error ? err.message : String(err),
    };
  }
}
