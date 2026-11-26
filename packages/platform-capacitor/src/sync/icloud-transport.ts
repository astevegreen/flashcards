import { hasTraversalSegment, SyncTransportError, type SyncTransportErrorCode } from '@flash/core';
import type { SyncFileInfo, SyncTransport } from '@flash/platform';

/**
 * File I/O inside the app's iCloud container. The iOS implementation is the local Swift plugin
 * `apps/mobile/ios/App/App/ICloudDocumentsPlugin.swift`, adapted in `../native/plugins.ts`.
 * Failures should carry a `code` of `NOT_FOUND`, `ALREADY_EXISTS`, `AUTH_REQUIRED` or `NETWORK`.
 */
export interface ICloudDocumentPlugin {
  /** False when the user is signed out of iCloud or iCloud Drive is off for the app. */
  isAvailable?(): Promise<boolean>;
  listFiles(opts: {
    prefix: string;
  }): Promise<Array<{ path: string; size: number; updatedAt?: number }>>;
  readFile(opts: { path: string }): Promise<Uint8Array>;
  /** With `ifAbsent`, must fail with code `ALREADY_EXISTS` when the file is already there. */
  writeFile(opts: { path: string; data: Uint8Array; ifAbsent?: boolean }): Promise<void>;
}

const PASSTHROUGH_CODES = new Set<SyncTransportErrorCode>([
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'AUTH_REQUIRED',
  'PERMISSION_DENIED',
  'NETWORK',
]);

/** Turns a plugin rejection (Capacitor puts the native `code` on the error) into a `SyncTransportError`. */
function toSyncError(err: unknown): unknown {
  if (err instanceof SyncTransportError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && PASSTHROUGH_CODES.has(code as SyncTransportErrorCode)) {
    const message = err instanceof Error ? err.message : String(code);
    return new SyncTransportError(code as SyncTransportErrorCode, message);
  }
  return err;
}

function validateRelativeSyncPath(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || hasTraversalSegment(clean)) {
    throw new Error(`Unsafe iCloud Drive sync path "${path}".`);
  }
  return clean;
}

/**
 * Optional zero-login iCloud Drive `SyncTransport` for iOS Capacitor users (§4.3, §15 Phase 8).
 */
export class ICloudDriveSyncTransport implements SyncTransport {
  private readonly plugin: ICloudDocumentPlugin;

  constructor(plugin: ICloudDocumentPlugin) {
    this.plugin = plugin;
  }

  async list(prefix: string): Promise<SyncFileInfo[]> {
    const clean = validateRelativeSyncPath(prefix.replace(/\/+$/, '') || 'sync');
    const files = await this.plugin.listFiles({ prefix: clean }).catch((err: unknown) => {
      throw toSyncError(err);
    });
    return files
      .map((f) => ({
        path: f.path.replace(/^\/+/, ''),
        size: f.size,
        ...(f.updatedAt !== undefined ? { updatedAt: f.updatedAt } : {}),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async read(path: string): Promise<Uint8Array> {
    return this.plugin.readFile({ path: validateRelativeSyncPath(path) }).catch((err: unknown) => {
      throw toSyncError(err);
    });
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    await this.plugin
      .writeFile({
        path: validateRelativeSyncPath(path),
        data,
        ...(opts?.ifAbsent !== undefined ? { ifAbsent: opts.ifAbsent } : {}),
      })
      .catch((err: unknown) => {
        throw toSyncError(err);
      });
  }
}
