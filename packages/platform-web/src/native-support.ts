import type {
  GoogleSourcesClient,
  HandwritingCandidate,
  HandwritingRecognizeOptions,
  HandwritingRecognizer,
  InkStroke,
  PackageSubscriptionFetcher,
  PlatformServices,
  SyncTransport,
} from '@flash/platform';

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
  | 'getDictionaryService';

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

/**
 * A `HandwritingRecognizer` that defers to a lazily created recognizer (e.g. the web
 * offline stroke matcher from `base.getHandwritingRecognizer`) so native shells can use it
 * as a fallback without loading its chunk at boot.
 */
export class LazyHandwritingRecognizer implements HandwritingRecognizer {
  readonly id = 'lazy-fallback';
  readonly isNative = false;
  private readonly load: () => Promise<HandwritingRecognizer>;
  private inner: Promise<HandwritingRecognizer> | null = null;

  constructor(load: () => Promise<HandwritingRecognizer>) {
    this.load = load;
  }

  private get(): Promise<HandwritingRecognizer> {
    this.inner ??= this.load();
    return this.inner;
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
