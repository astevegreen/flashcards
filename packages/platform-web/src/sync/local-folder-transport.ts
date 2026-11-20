import { SyncTransportError } from '@flash/core';
import type { Storage, SyncFileInfo, SyncTransport } from '@flash/platform';

const LOCAL_FOLDER_HANDLE_KV_KEY = 'local_sync_folder_handle';

export type FsPermissionState = 'granted' | 'denied' | 'prompt';

export interface FileSystemWritableLike {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
}

export interface FileSystemFileHandleLike {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<{ size: number; lastModified: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<FileSystemWritableLike>;
}

export interface FileSystemDirectoryHandleLike {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandleLike>;
  entries(): AsyncIterable<[string, FileSystemFileHandleLike | FileSystemDirectoryHandleLike]>;
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<FsPermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<FsPermissionState>;
}

interface WindowWithDirectoryPicker {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }) => Promise<FileSystemDirectoryHandleLike>;
}

export function isLocalFolderSyncSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as WindowWithDirectoryPicker).showDirectoryPicker === 'function'
  );
}

/** Strictly validates logical relative sync paths against path traversal (§13). */
export function splitSafeRelativePath(path: string): string[] {
  if (!path || path.includes('\0') || path.includes('\\') || /^[a-zA-Z]:/.test(path)) {
    throw new SyncTransportError('UNKNOWN', `Unsafe sync path rejected: "${path}"`);
  }
  if (path.startsWith('/')) {
    throw new SyncTransportError('UNKNOWN', `Absolute sync path rejected: "${path}"`);
  }
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new SyncTransportError('UNKNOWN', `Empty sync path rejected.`);
  }
  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new SyncTransportError('UNKNOWN', `Path traversal rejected: "${path}"`);
    }
  }
  return parts;
}

function isFsNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'NotFoundError' || name === 'TypeMismatchError';
}

function isFsPermissionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'NotAllowedError' || name === 'SecurityError';
}

export async function ensureDirectoryPermission(
  handle: FileSystemDirectoryHandleLike,
  requestPermission = false,
): Promise<boolean> {
  if (typeof handle.queryPermission === 'function') {
    const state = await handle.queryPermission({ mode: 'readwrite' });
    if (state === 'granted') return true;
    if (requestPermission && typeof handle.requestPermission === 'function') {
      const requested = await handle.requestPermission({ mode: 'readwrite' });
      return requested === 'granted';
    }
    return false;
  }
  return true;
}

/**
 * PC Local Folder SyncTransport over the Browser File System Access API (§4.3).
 * Useful for local-only backups or desktop sync tools (Google Drive for Desktop, Syncthing, Dropbox).
 */
export class LocalFolderSyncTransport implements SyncTransport {
  private readonly root: FileSystemDirectoryHandleLike;

  constructor(root: FileSystemDirectoryHandleLike) {
    this.root = root;
  }

  get folderName(): string {
    return this.root.name;
  }

  private async assertReadWritePermission(): Promise<void> {
    const ok = await ensureDirectoryPermission(this.root, false);
    if (!ok) {
      throw new SyncTransportError(
        'PERMISSION_DENIED',
        `Permission needed to access local sync folder "${this.root.name}". Click Reconnect Folder in Settings.`,
      );
    }
  }

  private async resolveParentDirectory(
    dirParts: readonly string[],
    create: boolean,
  ): Promise<FileSystemDirectoryHandleLike> {
    let dir = this.root;
    for (const part of dirParts) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return dir;
  }

  async list(prefix: string): Promise<SyncFileInfo[]> {
    await this.assertReadWritePermission();
    const out: SyncFileInfo[] = [];

    const walk = async (dir: FileSystemDirectoryHandleLike, currentPath: string): Promise<void> => {
      for await (const [name, handle] of dir.entries()) {
        const entryPath = currentPath ? `${currentPath}/${name}` : name;
        if (handle.kind === 'directory') {
          // Prune subtrees that cannot possibly match `prefix`
          if (
            !prefix ||
            entryPath.startsWith(prefix) ||
            prefix.startsWith(`${entryPath}/`) ||
            prefix === entryPath
          ) {
            await walk(handle, entryPath);
          }
        } else if (!prefix || entryPath.startsWith(prefix)) {
          const file = await handle.getFile();
          out.push({
            path: entryPath,
            size: file.size,
            updatedAt: file.lastModified,
          });
        }
      }
    };

    try {
      await walk(this.root, '');
    } catch (err) {
      if (isFsPermissionError(err)) {
        throw new SyncTransportError(
          'PERMISSION_DENIED',
          `Permission denied reading local sync folder "${this.root.name}".`,
        );
      }
      throw err;
    }

    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    await this.assertReadWritePermission();
    const parts = splitSafeRelativePath(path);
    const fileName = parts[parts.length - 1];
    if (!fileName) {
      throw new SyncTransportError('UNKNOWN', `Invalid sync file path: "${path}"`);
    }
    const dirParts = parts.slice(0, -1);

    try {
      const parent = await this.resolveParentDirectory(dirParts, false);
      const fh = await parent.getFileHandle(fileName, { create: false });
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      if (isFsNotFoundError(err)) {
        throw new SyncTransportError('NOT_FOUND', `Local sync file not found: "${path}"`);
      }
      if (isFsPermissionError(err)) {
        throw new SyncTransportError(
          'PERMISSION_DENIED',
          `Permission denied reading "${path}" in local sync folder.`,
        );
      }
      throw err;
    }
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    await this.assertReadWritePermission();
    const parts = splitSafeRelativePath(path);
    const fileName = parts[parts.length - 1];
    if (!fileName) {
      throw new SyncTransportError('UNKNOWN', `Invalid sync file path: "${path}"`);
    }
    const dirParts = parts.slice(0, -1);

    try {
      const parent = await this.resolveParentDirectory(dirParts, true);
      if (opts?.ifAbsent) {
        let exists = false;
        try {
          await parent.getFileHandle(fileName, { create: false });
          exists = true;
        } catch (checkErr) {
          if (!isFsNotFoundError(checkErr)) {
            throw checkErr;
          }
        }
        if (exists) {
          throw new SyncTransportError(
            'ALREADY_EXISTS',
            `Local sync write-once file already exists: "${path}"`,
          );
        }
      }

      const fh = await parent.getFileHandle(fileName, { create: true });
      const writable = await fh.createWritable();
      try {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        await writable.write(copy);
      } finally {
        await writable.close();
      }
    } catch (err) {
      if (err instanceof SyncTransportError) throw err;
      if (isFsPermissionError(err)) {
        throw new SyncTransportError(
          'PERMISSION_DENIED',
          `Permission denied writing "${path}" in local sync folder.`,
        );
      }
      throw err;
    }
  }
}

export async function pickAndSaveLocalSyncFolder(
  storage: Storage,
): Promise<{ name: string; transport: LocalFolderSyncTransport } | null> {
  if (!isLocalFolderSyncSupported()) {
    return null;
  }
  const picker = (window as unknown as WindowWithDirectoryPicker).showDirectoryPicker;
  if (!picker) return null;

  let handle: FileSystemDirectoryHandleLike;
  try {
    handle = await picker({ id: 'flashcards-sync', mode: 'readwrite' });
  } catch (err) {
    if (err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError') {
      return null;
    }
    throw err;
  }

  const ok = await ensureDirectoryPermission(handle, true);
  if (!ok) {
    throw new SyncTransportError(
      'PERMISSION_DENIED',
      `Read/write permission was not granted for folder "${handle.name}".`,
    );
  }

  await storage.setKv(LOCAL_FOLDER_HANDLE_KV_KEY, handle);
  return {
    name: handle.name,
    transport: new LocalFolderSyncTransport(handle),
  };
}

export async function restoreLocalSyncFolderHandle(
  storage: Storage,
  opts?: { requestPermission?: boolean },
): Promise<{ name: string; transport: LocalFolderSyncTransport } | null> {
  const handle = await storage.getKv<FileSystemDirectoryHandleLike>(LOCAL_FOLDER_HANDLE_KV_KEY);
  if (!handle) return null;

  const granted = await ensureDirectoryPermission(handle, Boolean(opts?.requestPermission));
  if (!granted) {
    throw new SyncTransportError(
      'PERMISSION_DENIED',
      `Permission needed to access local sync folder "${handle.name}".`,
    );
  }

  return {
    name: handle.name,
    transport: new LocalFolderSyncTransport(handle),
  };
}

export async function clearSavedLocalSyncFolder(storage: Storage): Promise<void> {
  await storage.deleteKv(LOCAL_FOLDER_HANDLE_KV_KEY);
}
