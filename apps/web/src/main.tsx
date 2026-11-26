import {
  applyEvents,
  applyEventsWithDiff,
  createEmptyState,
  createEventFactory,
  createHlcState,
  uuidv7,
  type CollectionState,
} from '@flash/core';
import type { AuthSession, PlatformServices, SyncConfig, SyncProviderKind } from '@flash/platform';
import { createWebPlatform, resolveDeviceFromUrl } from '@flash/platform-web';
import { FlashcardsApp } from '@flash/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

// Public OAuth Web Client ID & stateless token-helper Worker URL (never secret)
const DEFAULT_GOOGLE_CLIENT_ID =
  '932735219487-p20rc5hu0gegb2bh43q8phe8lgi957v3.apps.googleusercontent.com';
const DEFAULT_TOKEN_HELPER_URL = 'https://flashcards-token-helper.yodc.workers.dev';

/**
 * Overrides for tests (S1). The Vite dev server reads them from the URL. A production build reads
 * them only from `window.__FLASH_TEST_QUERY__` (same `a=1&b=2` form), which only code already
 * running in the page can set, such as a Playwright init script. So a crafted link can't swap the
 * licence key, the starter catalogue or the OAuth client in a real build.
 */
function testOverrides(): URLSearchParams {
  const query = (window as unknown as { __FLASH_TEST_QUERY__?: unknown }).__FLASH_TEST_QUERY__;
  if (import.meta.env.DEV) return new URLSearchParams(window.location.search);
  return new URLSearchParams(typeof query === 'string' ? query : '');
}

type NativeRuntime = 'capacitor' | 'tauri' | null;

/** Detects the native shell without importing any native SDK into the initial chunk. */
function detectNativeRuntime(): NativeRuntime {
  const w = window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean };
    __TAURI_INTERNALS__?: unknown;
  };
  if (w.Capacitor?.isNativePlatform?.()) return 'capacitor';
  if (w.__TAURI_INTERNALS__ !== undefined) return 'tauri';
  return null;
}

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

async function boot(): Promise<void> {
  const resolved = resolveDeviceFromUrl();
  const isDevMode = import.meta.env.DEV || Boolean(resolved.slug);
  const googleClientId =
    (import.meta.env['VITE_GOOGLE_CLIENT_ID'] as string | undefined)?.trim() ||
    DEFAULT_GOOGLE_CLIENT_ID;
  const tokenHelperUrl =
    (import.meta.env['VITE_TOKEN_HELPER_URL'] as string | undefined)?.trim() ||
    DEFAULT_TOKEN_HELPER_URL;
  const googleApiKey = (import.meta.env['VITE_GOOGLE_API_KEY'] as string | undefined)?.trim() || '';
  const searchParams = new URLSearchParams(window.location.search);
  const overrides = testOverrides();
  const dropboxAppKey =
    overrides.get('dropboxAppKey')?.trim() ||
    (import.meta.env['VITE_DROPBOX_APP_KEY'] as string | undefined)?.trim() ||
    '';
  // OneDrive (Microsoft Entra) client ID, from the build env (or a test override, see above), so
  // a crafted link cannot send users to the consent screen of another Entra app.
  const microsoftClientId =
    overrides.get('msClientId')?.trim() ||
    (import.meta.env['VITE_MS_CLIENT_ID'] as string | undefined)?.trim() ||
    '';
  const microsoftTenant = (import.meta.env['VITE_MS_TENANT'] as string | undefined)?.trim() || '';
  const envPackCatalogUrl =
    (import.meta.env['VITE_PACK_CATALOG_URL'] as string | undefined)?.trim() || '';
  const envStarterCatalogUrl =
    (import.meta.env['VITE_STARTER_CATALOG_URL'] as string | undefined)?.trim() || '';
  const starterCatalogUrl = overrides.get('starterCatalog')?.trim() || envStarterCatalogUrl;
  const enableLicenseGate =
    (import.meta.env['VITE_ENABLE_LICENSE_GATE'] as string | undefined)?.trim() === 'true' ||
    overrides.get('licenseGate') === '1';
  const licensePublicKeyHex =
    overrides.get('licensePubKey')?.trim() ||
    (import.meta.env['VITE_LICENSE_PUBLIC_KEY'] as string | undefined)?.trim() ||
    '';

  const webPlatform = createWebPlatform({
    isDevMode,
    googleClientId,
    tokenHelperUrl,
    googleApiKey,
    ...(dropboxAppKey ? { dropboxAppKey } : {}),
    ...(microsoftClientId ? { microsoftClientId } : {}),
    ...(microsoftTenant ? { microsoftTenant } : {}),
    ...(envPackCatalogUrl ? { packCatalogUrl: envPackCatalogUrl } : {}),
    ...(starterCatalogUrl ? { starterCatalogUrl } : {}),
    isPersonalBuild: !enableLicenseGate,
    ...(licensePublicKeyHex ? { licensePublicKeyHex } : {}),
  });

  // Native shells (Capacitor / Tauri) run this identical bundle; swap in native services lazily (§10.1).
  const nativeRuntime = detectNativeRuntime();
  if ('serviceWorker' in navigator) {
    if (nativeRuntime !== null) {
      // Unregister any leftover SW from older native builds so WebView updates take effect cleanly.
      void navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .catch(() => undefined);
    } else if (!import.meta.env.DEV) {
      const registerSw = () => {
        void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
      };
      if (document.readyState === 'complete') registerSw();
      else window.addEventListener('load', registerSw, { once: true });
    }
  }
  const platform: PlatformServices = nativeRuntime
    ? await (
        await import('./native-boot.ts')
      ).bootNativePlatform(nativeRuntime, webPlatform, {
        googleClientId,
        googleApiKey,
        isPersonalBuild: !enableLicenseGate,
        licensePublicKeyHex,
        microsoftClientId,
        microsoftTenant,
        dropboxAppKey,
        packCatalogUrl: envPackCatalogUrl,
        starterCatalogUrl,
      })
    : webPlatform;

  // Zero-overhead OAuth redirect callback check (only lazy-loads GoogleAuth if `?code=` / `?error=` is present)
  let initialOAuthError: string | undefined;
  let syncConfig: SyncConfig | undefined = await platform.storage.getSyncConfig();
  let syncCursor = await platform.storage.getSyncCursor();

  let meta = await platform.storage.getDeviceMeta();
  if (!meta) {
    // Real production installs must each receive a unique persistent device ID (§4.2 single-writer invariant).
    // Only `?device=<slug>` dev/test sessions use deterministic slug IDs (`device-a`, `device-b`).
    const uniqueDeviceId = platform.hasDeviceSlug
      ? platform.deviceId
      : `web-${uuidv7().slice(0, 12)}`;
    meta = {
      deviceId: uniqueDeviceId,
      seq: 0,
      hlc: createHlcState(uniqueDeviceId, 0),
    };
    await platform.storage.setDeviceMeta(meta);
  }
  // Events are stored before the meta that counts them; a session killed in between left the meta
  // behind, and its next events would reuse those seq numbers (D11). Normally finds nothing.
  const ownTail = await platform.storage.getDeviceEventsAfterSeq(meta.deviceId, meta.seq);
  if (ownTail.length > 0) {
    const { advanceClockPastOwnEvents } = await import('@flash/core/sync');
    meta = { ...meta, ...advanceClockPastOwnEvents(meta, ownTail) };
    await platform.storage.setDeviceMeta(meta);
  }

  if (nativeRuntime === null && (searchParams.has('code') || searchParams.has('error'))) {
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
              void _dropped;
              meta = restMeta;
              await platform.storage.setDeviceMeta(meta);
            }
          }
        }
      }
    } catch (err) {
      initialOAuthError = err instanceof Error ? err.message : String(err);
    }
  }

  // Fast cold-start hydration: load local snapshot + only incremental delta events when available
  let initialState: CollectionState;
  let localSnapshot = await platform.storage.getLocalSnapshot();
  // A snapshot from a build before media removal lacks the media add registers. When the log has
  // every event it covers, replay the log instead, so this device agrees with the others.
  let replayedLog: Awaited<ReturnType<typeof platform.storage.getAllEvents>> | undefined;
  // Such a snapshot whose log is incomplete is kept, and saved again in the current format below,
  // so later launches don't read the whole log again before first paint.
  let resaveSnapshot = false;
  if (localSnapshot) {
    const { snapshotLacksMediaRecords } = await import('@flash/core/snapshot');
    if (snapshotLacksMediaRecords(localSnapshot.snapshot)) {
      resaveSnapshot = true;
      const [{ checkLogCoverage }, all] = await Promise.all([
        import('@flash/core/check'),
        platform.storage.getAllEvents(),
      ]);
      const watermarks = new Map(Object.entries(localSnapshot.snapshot.watermarks));
      if (checkLogCoverage(all, watermarks).complete) {
        localSnapshot = undefined;
        replayedLog = all;
      }
    }
  }

  if (localSnapshot) {
    const { deserializeCollectionState, serializeCollectionState } =
      await import('@flash/core/snapshot');
    initialState = deserializeCollectionState(localSnapshot.snapshot);
    const delta = await platform.storage.getEventsAfterLocalSeq(localSnapshot.localSeq);
    if (delta.events.length > 0) {
      applyEventsWithDiff(initialState, delta.events);
    }
    if (resaveSnapshot) {
      void platform.storage.setLocalSnapshot({
        snapshot: serializeCollectionState(initialState, {
          [meta.deviceId]: meta.seq,
          ...(syncCursor?.remoteWatermarks ?? {}),
        }),
        localSeq: Math.max(localSnapshot.localSeq, delta.maxLocalSeq),
        savedAt: Date.now(),
      });
    }
  } else {
    let events = replayedLog ?? (await platform.storage.getAllEvents());

    // Agent-friendly no-login dev mode (§10.2): auto-seed sample decks at fixed baseline epoch
    if (events.length === 0 && isDevMode && !meta.seeded) {
      const { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } = await import('@flash/core/samples');
      const factory = createEventFactory(meta.deviceId, meta.seq, meta.hlc);
      const seedEvents = buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS);
      await platform.storage.appendEvents(seedEvents);
      meta = {
        ...meta,
        seq: factory.getSeq(),
        hlc: factory.getHlc(),
        seeded: true,
      };
      await platform.storage.setDeviceMeta(meta);
      events = seedEvents;
    }

    initialState = applyEvents(createEmptyState(), events);

    // Save a local snapshot so later cold starts replay only the events after it
    if (events.length > 0) {
      if (events.length >= 200 || replayedLog !== undefined) {
        // Capture maxLocalSeq synchronously before rendering so post-render mutations cannot race ahead
        const [maxLocalSeq, { serializeCollectionState }] = await Promise.all([
          platform.storage.getMaxLocalSeq(),
          import('@flash/core/snapshot'),
        ]);
        const snapPayload = serializeCollectionState(initialState, {
          [meta.deviceId]: meta.seq,
          ...(syncCursor?.remoteWatermarks ?? {}),
        });
        void platform.storage.setLocalSnapshot({
          snapshot: snapPayload,
          localSeq: maxLocalSeq,
          savedAt: Date.now(),
        });
      }
    }
  }

  const rootEl = document.getElementById('root');
  if (!rootEl) {
    throw new Error('Root element #root not found');
  }

  createRoot(rootEl).render(
    <StrictMode>
      <FlashcardsApp
        platform={platform}
        initialState={initialState}
        initialMeta={meta}
        {...(syncConfig !== undefined ? { initialSyncConfig: syncConfig } : {})}
        {...(syncCursor !== undefined ? { initialSyncCursor: syncCursor } : {})}
        {...(initialOAuthError !== undefined ? { initialOAuthError } : {})}
      />
    </StrictMode>,
  );
}

void boot();
