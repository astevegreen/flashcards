import type { GooglePickedFile, NativePickerBridge } from '@flash/platform';
import { pickerStateMatches } from '../native/deep-links.ts';

export interface SystemBrowserLauncher {
  /**
   * Opens `url` and resolves with the first `<callbackScheme>://picker-callback` deep link that
   * carries `state`; callbacks with no `state` or another one are ignored (S10).
   */
  openAndAwaitDeepLink(opts: {
    url: string;
    callbackScheme: string;
    state?: string;
  }): Promise<string>;
}

/** A fresh per-pick nonce: 128 random bits as hex. */
function pickerStateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Native Picker deep-link bridge (§11):
 * Google Picker is web-only, so native Capacitor/Tauri shells open the static `picker.html`
 * page on the app's HTTPS domain in the system browser and receive selected file IDs via
 * `flashcards://picker-callback?files=...`.
 */
export class CapacitorNativePickerBridge implements NativePickerBridge {
  private readonly launcher?: SystemBrowserLauncher;

  constructor(launcher?: SystemBrowserLauncher) {
    if (launcher) this.launcher = launcher;
  }

  async openSystemBrowserPicker(opts: {
    pickerPageUrl: string;
    accessToken: string;
    appId: string;
    apiKey: string;
    callbackScheme?: string;
    mode?: 'sheets_docs' | 'drive_files';
  }): Promise<GooglePickedFile[]> {
    if (!this.launcher) {
      throw new Error('Native system browser launcher is unavailable.');
    }
    const callbackScheme = opts.callbackScheme ?? 'flashcards';
    const url = new URL(opts.pickerPageUrl);
    // `picker.html` echoes `state` back, so a deep link that this pick did not start is refused.
    const state = pickerStateNonce();
    // Pass short-lived token & Picker config via URL fragment (never logged in server access logs)
    const frag = new URLSearchParams({
      access_token: opts.accessToken,
      app_id: opts.appId,
      api_key: opts.apiKey,
      callback: `${callbackScheme}://picker-callback`,
      state,
      // `picker.html` lists plain .csv/.tsv/.xlsx/.flashpkg files too; an older page ignores it.
      ...(opts.mode === 'drive_files' ? { mode: 'drive_files' } : {}),
    });
    url.hash = frag.toString();

    const callbackUrl = await this.launcher.openAndAwaitDeepLink({
      url: url.toString(),
      callbackScheme,
      state,
    });
    if (!pickerStateMatches(callbackUrl, state)) {
      throw new Error('Picker callback did not come from this request.');
    }
    return this.parseDeepLinkCallback(callbackUrl);
  }

  parseDeepLinkCallback(callbackUrl: string): GooglePickedFile[] {
    const parsed = new URL(callbackUrl);
    const err = parsed.searchParams.get('error');
    if (err) {
      throw new Error(`Picker bridge returned error: ${err}`);
    }
    const rawFiles = parsed.searchParams.get('files');
    if (!rawFiles) return [];
    const list = JSON.parse(rawFiles) as unknown;
    if (!Array.isArray(list)) return [];
    const out: GooglePickedFile[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj['id'] !== 'string' || typeof obj['name'] !== 'string') continue;
      out.push({
        id: obj['id'],
        name: obj['name'],
        mimeType:
          typeof obj['mimeType'] === 'string'
            ? obj['mimeType']
            : 'application/vnd.google-apps.spreadsheet',
        ...(typeof obj['url'] === 'string' ? { url: obj['url'] } : {}),
      });
    }
    return out;
  }
}
