import type { SyncFileInfo, SyncTransport } from '@flash/platform';

export interface ICloudDocumentPlugin {
  listFiles(opts: {
    prefix: string;
  }): Promise<Array<{ path: string; size: number; updatedAt?: number }>>;
  readFile(opts: { path: string }): Promise<Uint8Array>;
  writeFile(opts: { path: string; data: Uint8Array; ifAbsent?: boolean }): Promise<void>;
}

function validateRelativeSyncPath(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..') || clean.includes('\0')) {
    throw new Error(`Unsafe iCloud Drive sync path "${path}".`);
  }
  return clean;
}

/**
 * Optional zero-login iCloud Drive `SyncTransport` for iOS/macOS Capacitor users (§4.3, §15 Phase 8).
 */
export class ICloudDriveSyncTransport implements SyncTransport {
  private readonly plugin: ICloudDocumentPlugin;

  constructor(plugin: ICloudDocumentPlugin) {
    this.plugin = plugin;
  }

  async list(prefix: string): Promise<SyncFileInfo[]> {
    const clean = validateRelativeSyncPath(prefix.replace(/\/+$/, '') || 'sync');
    const files = await this.plugin.listFiles({ prefix: clean });
    return files
      .map((f) => ({
        path: f.path.replace(/^\/+/, ''),
        size: f.size,
        ...(f.updatedAt !== undefined ? { updatedAt: f.updatedAt } : {}),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async read(path: string): Promise<Uint8Array> {
    return this.plugin.readFile({ path: validateRelativeSyncPath(path) });
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    await this.plugin.writeFile({
      path: validateRelativeSyncPath(path),
      data,
      ...(opts?.ifAbsent !== undefined ? { ifAbsent: opts.ifAbsent } : {}),
    });
  }
}
