import type { ICloudDocumentPlugin } from '@flash/platform-capacitor';

/**
 * `ICloudDocumentPlugin` for the macOS desktop app, over the app's own Tauri commands in
 * `apps/desktop/src-tauri/src/icloud.rs`. It opens the same iCloud container and file layout as
 * the iOS plugin, so `ICloudDriveSyncTransport` gives an iPhone and a Mac one shared collection.
 * On Windows and Linux the commands report iCloud as unavailable.
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

/**
 * True when iCloud Drive is usable on this machine (macOS, signed in, entitled build). Gives up
 * after `timeoutMs` and on any error, so a slow iCloud daemon never holds up the first screen.
 */
export async function probeICloudAvailable(
  plugin: ICloudDocumentPlugin,
  timeoutMs = 2000,
): Promise<boolean> {
  if (!plugin.isAvailable) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([plugin.isAvailable().catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
