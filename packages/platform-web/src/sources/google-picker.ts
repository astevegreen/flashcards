import { SyncTransportError } from '@flash/core';
import type { Auth, GooglePickedFile, GooglePickerAdapter } from '@flash/platform';

const GOOGLE_API_SCRIPT_SRC = 'https://apis.google.com/js/api.js';
const SCRIPT_LOAD_TIMEOUT_MS = 15_000;

interface GooglePickerDoc {
  id?: string;
  name?: string;
  mimeType?: string;
  url?: string;
}

interface GooglePickerCallbackData {
  action?: string;
  docs?: GooglePickerDoc[];
}

interface GooglePickerBuilderLike {
  enableFeature(feature: string): GooglePickerBuilderLike;
  setOAuthToken(token: string): GooglePickerBuilderLike;
  setDeveloperKey(apiKey: string): GooglePickerBuilderLike;
  setAppId(appId: string): GooglePickerBuilderLike;
  setOrigin(origin: string): GooglePickerBuilderLike;
  addView(view: unknown): GooglePickerBuilderLike;
  setCallback(cb: (data: GooglePickerCallbackData) => void): GooglePickerBuilderLike;
  build(): { setVisible(visible: boolean): void };
}

export interface GooglePickerGlobals {
  gapi?: {
    load(api: string, callback: () => void): void;
  };
  google?: {
    picker?: {
      ViewId: { SPREADSHEETS: string; DOCUMENTS: string };
      Feature: { MULTISELECT_ENABLED: string };
      Action: { PICKED: string; CANCEL: string };
      DocsView: new (viewId: string) => unknown;
      PickerBuilder: new () => GooglePickerBuilderLike;
    };
  };
  location?: { origin?: string };
}

export interface WebGooglePickerOptions {
  auth: Auth;
  apiKey: string;
  clientId?: string;
  loadPickerScript?: () => Promise<void>;
  globals?: GooglePickerGlobals;
}

let scriptLoadPromise: Promise<void> | null = null;

function defaultLoadPickerApi(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(
      new SyncTransportError('UNKNOWN', 'Browser DOM is unavailable for Google Picker.'),
    );
  }
  const win = window as unknown as GooglePickerGlobals;
  if (win.google?.picker) {
    return Promise.resolve();
  }
  if (scriptLoadPromise) {
    return scriptLoadPromise;
  }

  scriptLoadPromise = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      scriptLoadPromise = null;
      reject(new SyncTransportError('NETWORK', 'Timed out loading Google Picker script.'));
    }, SCRIPT_LOAD_TIMEOUT_MS);

    const finishLoad = () => {
      if (!win.gapi?.load) {
        window.clearTimeout(timer);
        scriptLoadPromise = null;
        reject(new SyncTransportError('UNKNOWN', 'Google API loader did not initialize gapi.'));
        return;
      }
      win.gapi.load('picker', () => {
        window.clearTimeout(timer);
        if (win.google?.picker) {
          resolve();
        } else {
          scriptLoadPromise = null;
          reject(new SyncTransportError('UNKNOWN', 'Google Picker API failed to load.'));
        }
      });
    };

    if (win.gapi?.load) {
      finishLoad();
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_API_SCRIPT_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener('load', finishLoad, { once: true });
      existing.addEventListener(
        'error',
        () => {
          window.clearTimeout(timer);
          scriptLoadPromise = null;
          reject(new SyncTransportError('NETWORK', 'Failed to load Google Picker script.'));
        },
        { once: true },
      );
      return;
    }

    const script = document.createElement('script');
    script.src = GOOGLE_API_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = finishLoad;
    script.onerror = () => {
      window.clearTimeout(timer);
      scriptLoadPromise = null;
      reject(new SyncTransportError('NETWORK', 'Failed to load Google Picker script.'));
    };
    document.head.appendChild(script);
  });

  return scriptLoadPromise;
}

/** Extracts GCP numeric project number (App ID) from an OAuth Client ID (`<projectNumber>-...`). */
export function extractGoogleAppId(clientId?: string): string | undefined {
  if (!clientId) return undefined;
  const match = /^(\d+)-/.exec(clientId.trim());
  return match?.[1];
}

/**
 * Lazy-loaded Google Picker multi-select adapter for `drive.file` Sheets & Docs (§3.1).
 */
export class WebGooglePicker implements GooglePickerAdapter {
  private readonly auth: Auth;
  private readonly apiKey: string;
  private readonly appId: string | undefined;
  private readonly loadPickerScript: () => Promise<void>;
  private readonly globals: GooglePickerGlobals | undefined;

  constructor(options: WebGooglePickerOptions) {
    this.auth = options.auth;
    this.apiKey = options.apiKey.trim();
    this.appId = extractGoogleAppId(options.clientId);
    this.loadPickerScript = options.loadPickerScript ?? defaultLoadPickerApi;
    this.globals = options.globals;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.auth.isConfigured());
  }

  async pickSheetsAndDocs(): Promise<GooglePickedFile[]> {
    if (!this.apiKey) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'Google Picker API key (VITE_GOOGLE_API_KEY) is not configured.',
      );
    }

    const accessToken = await this.auth.getValidAccessToken();
    await this.loadPickerScript();

    const g =
      this.globals ??
      (typeof window !== 'undefined' ? (window as unknown as GooglePickerGlobals) : undefined);
    const pickerApi = g?.google?.picker;
    if (!pickerApi) {
      throw new SyncTransportError('UNKNOWN', 'Google Picker API is unavailable.');
    }

    return new Promise<GooglePickedFile[]>((resolve) => {
      const sheetsView = new pickerApi.DocsView(pickerApi.ViewId.SPREADSHEETS);
      const docsView = new pickerApi.DocsView(pickerApi.ViewId.DOCUMENTS);

      let builder = new pickerApi.PickerBuilder()
        .enableFeature(pickerApi.Feature.MULTISELECT_ENABLED)
        .setOAuthToken(accessToken)
        .setDeveloperKey(this.apiKey)
        .addView(sheetsView)
        .addView(docsView);

      if (this.appId) {
        builder = builder.setAppId(this.appId);
      }
      if (g?.location?.origin) {
        builder = builder.setOrigin(g.location.origin);
      }

      const picker = builder
        .setCallback((data) => {
          if (data.action === pickerApi.Action.PICKED) {
            const docs: GooglePickedFile[] = [];
            for (const item of data.docs ?? []) {
              if (!item.id || !item.mimeType) continue;
              docs.push({
                id: item.id,
                name: item.name ?? item.id,
                mimeType: item.mimeType,
                ...(item.url !== undefined ? { url: item.url } : {}),
              });
            }
            resolve(docs);
          } else if (data.action === pickerApi.Action.CANCEL) {
            resolve([]);
          }
        })
        .build();

      picker.setVisible(true);
    });
  }
}
