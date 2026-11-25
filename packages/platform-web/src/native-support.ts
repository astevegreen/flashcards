import type {
  Auth,
  DropboxFilePicker,
  GoogleSourcesClient,
  OneDriveFilePicker,
  HandwritingCandidate,
  HandwritingRecognizeOptions,
  HandwritingRecognizer,
  InkStroke,
  PackageSubscriptionFetcher,
  PlatformServices,
  SyncTransport,
} from '@flash/platform';
import { loadOnceUntilFailure } from './load-once.ts';

export { ONEDRIVE_NATIVE_SESSION_KV_KEY } from './auth/microsoft-native-session-key.ts';
export { DROPBOX_NATIVE_SESSION_KV_KEY } from './auth/dropbox-native-session-key.ts';

/**
 * Helpers shared by the Capacitor and Tauri native shells (§10.1, §15 Phase 8).
 *
 * Native shells run the identical `apps/web/dist` bundle inside a system WebView, so the
 * browser-API services (Drive/Sheets REST clients, pack/stroke/dictionary stores, media
 * processing, TTS, replay worker) are reused as-is. Only storage, auth, files, the picker
 * bridge, handwriting and purchases are swapped for native plugins.
 */

type OptionalServiceKey =
  | 'audioPlayer'
  | 'deviceSpeech'
  | 'createReplayWorker'
  | 'processImage'
  | 'fetchAndCacheHttpsImage'
  | 'createTtsProvider'
  | 'processAudio'
  | 'fetchAndCacheHttpsAudio'
  | 'getPackManager'
  | 'getStrokeDataProvider'
  | 'getHandwritingRecognizer'
  | 'getDictionaryService'
  | 'getFsrsOptimizer'
  | 'getAnkiPackageReader';

const BORROWED_KEYS: readonly OptionalServiceKey[] = [
  'audioPlayer',
  'deviceSpeech',
  'createReplayWorker',
  'processImage',
  'fetchAndCacheHttpsImage',
  'createTtsProvider',
  'processAudio',
  'fetchAndCacheHttpsAudio',
  'getPackManager',
  'getStrokeDataProvider',
  'getHandwritingRecognizer',
  'getDictionaryService',
  'getFsrsOptimizer',
  'getAnkiPackageReader',
];

/**
 * Merges a native `PlatformServices` bundle with the browser services from `base`
 * (normally `createWebPlatform()`): native members win, missing optional services are
 * borrowed from `base`, and Google Drive / Sheets / package fetching are re-bound to the
 * native `Auth` so they use native tokens.
 */
export function composeNativePlatform(
  native: PlatformServices,
  base: PlatformServices,
): PlatformServices {
  const borrowed: Partial<Pick<PlatformServices, OptionalServiceKey>> = {};
  for (const key of BORROWED_KEYS) {
    const value = native[key] ?? base[key];
    if (value !== undefined) {
      (borrowed as Record<string, unknown>)[key] = value;
    }
  }

  let driveTransport: SyncTransport | null = null;
  let sourcesClient: GoogleSourcesClient | null = null;
  let packageFetcher: PackageSubscriptionFetcher | null = null;

  return {
    ...native,
    ...borrowed,
    createGoogleDriveTransport: async () => {
      if (!driveTransport) {
        const { GoogleDriveAppDataTransport } = await import('./sync/google-drive-transport.ts');
        driveTransport = new GoogleDriveAppDataTransport({ auth: await native.getGoogleAuth() });
      }
      return driveTransport;
    },
    getGoogleSourcesClient: async () => {
      if (!sourcesClient) {
        const { WebGoogleSourcesClient } = await import('./sources/google-sheets-docs.ts');
        sourcesClient = new WebGoogleSourcesClient({ auth: await native.getGoogleAuth() });
      }
      return sourcesClient;
    },
    getPackageFetcher: async () => {
      if (!packageFetcher) {
        const { WebPackageSubscriptionFetcher } = await import('./sources/package-subscription.ts');
        packageFetcher = new WebPackageSubscriptionFetcher();
      }
      return packageFetcher;
    },
  };
}

/** The OneDrive members of `PlatformServices`, all backed by one lazily created bundle. */
export type OneDrivePlatformFields = Pick<
  PlatformServices,
  'oneDriveConfigured' | 'getOneDriveAuth' | 'createOneDriveTransport' | 'getOneDrivePicker'
>;

/**
 * Wires the OneDrive storage connector into a native shell (§15 Phase 12). `load` runs on first
 * use only (when the user opens Settings > Sync or the picker), so neither the OneDrive code nor
 * the sign-in plugin initialization touches app start.
 */
export function lazyOneDriveFields(
  load: () => Promise<{ auth: Auth; transport: SyncTransport; picker: OneDriveFilePicker }>,
): OneDrivePlatformFields {
  const get = loadOnceUntilFailure(load);
  return {
    oneDriveConfigured: true,
    getOneDriveAuth: async () => (await get()).auth,
    createOneDriveTransport: async () => (await get()).transport,
    getOneDrivePicker: async () => (await get()).picker,
  };
}

/** The Dropbox members of `PlatformServices`, all backed by one lazily created bundle. */
export type DropboxPlatformFields = Pick<
  PlatformServices,
  'dropboxConfigured' | 'getDropboxAuth' | 'createDropboxTransport' | 'getDropboxPicker'
>;

/**
 * Wires the Dropbox App Folder connector into a native shell. `load` runs on first use only
 * (Settings > Sync or Library > Sources), keeping Dropbox code and sign-in setup out of boot.
 */
export function lazyDropboxFields(
  load: () => Promise<{ auth: Auth; transport: SyncTransport; picker: DropboxFilePicker }>,
): DropboxPlatformFields {
  const get = loadOnceUntilFailure(load);
  return {
    dropboxConfigured: true,
    getDropboxAuth: async () => (await get()).auth,
    createDropboxTransport: async () => (await get()).transport,
    getDropboxPicker: async () => (await get()).picker,
  };
}

/**
 * A `HandwritingRecognizer` that defers to a lazily created recognizer (e.g. the web
 * offline stroke matcher from `base.getHandwritingRecognizer`) so native shells can use it
 * as a fallback without loading its chunk at boot.
 */
export class LazyHandwritingRecognizer implements HandwritingRecognizer {
  readonly id = 'lazy-fallback';
  readonly isNative = false;
  private readonly get: () => Promise<HandwritingRecognizer>;

  constructor(load: () => Promise<HandwritingRecognizer>) {
    this.get = loadOnceUntilFailure(load);
  }

  async isReady(lang?: string): Promise<boolean> {
    return (await this.get()).isReady(lang);
  }

  async recognize(
    strokes: readonly InkStroke[],
    options?: HandwritingRecognizeOptions,
  ): Promise<HandwritingCandidate[]> {
    return (await this.get()).recognize(strokes, options);
  }
}
