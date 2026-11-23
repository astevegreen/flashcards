import type { ICloudDocumentPlugin } from '@flash/platform-capacitor';

/**
 * `ICloudDocumentPlugin` for the macOS desktop app, over the app's own Tauri commands in
 * `apps/desktop/src-tauri/src/icloud.rs`. It opens the same iCloud container and file layout as
 * the iOS plugin, so `ICloudDriveSyncTransport` gives an iPhone and a Mac one shared collection.
 * On Windows, Linux and unsigned Mac builds `icloud_supported` is false and nothing is offered.
 */

/** `invoke` from `@tauri-apps/api/core` (injected so tests can fake it). */
export type TauriInvoke = <T>(
  cmd: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: { headers: Record<string, string> },
) => Promise<T>;

interface RustFileEntry {
  path: string;
  size: number;
  updatedAt?: number;
}

/** Rust rejects with `{ code, message }`; give it an `Error` so `toSyncError` keeps the code. */
function toError(err: unknown): unknown {
  if (err instanceof Error) return err;
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
    const { code, message } = err as { code: string; message?: unknown };
    return Object.assign(new Error(typeof message === 'string' ? message : code), { code });
  }
  return new Error(String(err));
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // Older IPC paths fall back to a JSON number array.
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new TypeError('icloud_read_file returned no bytes.');
}

export function createTauriICloudDocumentPlugin(invoke: TauriInvoke): ICloudDocumentPlugin {
  const call = async <T>(...args: Parameters<TauriInvoke>): Promise<T> => {
    try {
      return await invoke<T>(...args);
    } catch (err: unknown) {
      throw toError(err);
    }
  };
  return {
    isAvailable: async () => (await call<boolean>('icloud_available')) === true,
    listFiles: ({ prefix }) => call<RustFileEntry[]>('icloud_list_files', { prefix }),
    readFile: async ({ path }) => toBytes(await call<unknown>('icloud_read_file', { path })),
    writeFile: async ({ path, data, ifAbsent }) => {
      // Raw bytes as the body (no JSON number array); the path travels URI-encoded in a header.
      await call<null>('icloud_write_file', data, {
        headers: {
          'x-icloud-path': encodeURIComponent(path),
          ...(ifAbsent ? { 'x-icloud-if-absent': '1' } : {}),
        },
      });
    },
  };
}

export interface TauriICloudOptions {
  iCloudPlugin?: ICloudDocumentPlugin;
  iCloudAvailableAtLaunch?: boolean;
  /** True only when the launch probe answered in time that iCloud Drive is off. */
  iCloudOffAtLaunch?: boolean;
}

/**
 * What the desktop boot passes to `createTauriPlatform` for iCloud. Nothing unless
 * `icloud_supported` says this build has the iCloud entitlement (unsigned Mac builds and Windows /
 * Linux do not, so they never offer iCloud and its sign-in error cannot appear). On an entitled
 * Mac the plugin is always passed, so a Mac already syncing with iCloud keeps its transport even when the launch probe is
 * slow or iCloud is briefly signed out (the transport checks availability on each connect, like
 * iOS). The probe only decides whether iCloud is the "Sync my devices" default.
 */
export async function resolveTauriICloudOptions(
  invoke: TauriInvoke,
  timeoutMs = 2000,
): Promise<TauriICloudOptions> {
  const supported = await invoke<boolean>('icloud_supported').catch(() => false);
  if (supported !== true) return {};
  const iCloudPlugin = createTauriICloudDocumentPlugin(invoke);
  const availability = await probeICloudAvailability(iCloudPlugin, timeoutMs);
  return {
    iCloudPlugin,
    iCloudAvailableAtLaunch: availability === 'available',
    ...(availability === 'off' ? { iCloudOffAtLaunch: true } : {}),
  };
}

/**
 * What the launch probe learned: `available`, `off` (iCloud answered in time that it is not
 * usable: signed out or iCloud Drive off), or `unknown` (no answer within `timeoutMs`, or an
 * error). Only `off` earns the "turn on iCloud Drive" hint, so a slow iCloud daemon never shows it.
 */
export async function probeICloudAvailability(
  plugin: ICloudDocumentPlugin,
  timeoutMs = 2000,
): Promise<'available' | 'off' | 'unknown'> {
  if (!plugin.isAvailable) return 'available';
  const isAvailable = plugin.isAvailable.bind(plugin);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'unknown'>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), timeoutMs);
  });
  try {
    return await Promise.race([
      isAvailable().then(
        (available): 'available' | 'off' => (available ? 'available' : 'off'),
        (): 'unknown' => 'unknown',
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when iCloud Drive is usable on this machine (macOS, signed in, entitled build). Gives up
 * after `timeoutMs` and on any error, so a slow iCloud daemon never holds up the first screen.
 */
export async function probeICloudAvailable(
  plugin: ICloudDocumentPlugin,
  timeoutMs = 2000,
): Promise<boolean> {
  return (await probeICloudAvailability(plugin, timeoutMs)) === 'available';
}
