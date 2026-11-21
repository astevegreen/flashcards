import { SyncTransportError, uuidv7 } from '@flash/core';
import { isSafeRelativeMediaPath } from '@flash/core/sources';
import type {
  LocalFolderSourcesAdapter,
  ScannedLocalFileDescriptor,
  Storage,
} from '@flash/platform';
import type {
  FileSystemDirectoryHandleLike,
  FileSystemFileHandleLike,
  FsPermissionState,
} from '../sync/local-folder-transport.ts';

const FOLDER_HANDLE_PREFIX = 'local_source_folder_handle:';
const MAX_SCANNED_FILES = 2_000;
const MAX_DEFAULT_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_MEDIA_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const SAFE_MEDIA_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
};

export interface SourceDirectoryHandleLike extends FileSystemDirectoryHandleLike {
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
}

interface WindowWithDirectoryPicker {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }) => Promise<SourceDirectoryHandleLike>;
}

export interface WebLocalFolderSourcesOptions {
  storage: Storage;
  pickDirectoryImpl?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }) => Promise<SourceDirectoryHandleLike>;
}

function classifySourceFile(fileName: string): ScannedLocalFileDescriptor['kind'] | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.tsv')) return 'tsv';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.md')) return 'md';
  if (lower.endsWith('.flashpkg')) return 'flashpkg';
  return null;
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

function splitRelativeSegments(relativePath: string): string[] {
  if (
    !relativePath ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/') ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    throw new SyncTransportError('UNKNOWN', `Unsafe local relative path: "${relativePath}"`);
  }
  const parts = relativePath.split('/').filter((p) => p.length > 0 && p !== '.');
  for (const p of parts) {
    if (p === '..') {
      throw new SyncTransportError('UNKNOWN', `Path traversal rejected: "${relativePath}"`);
    }
  }
  if (parts.length === 0) {
    throw new SyncTransportError('UNKNOWN', `Empty relative path rejected.`);
  }
  return parts;
}

async function checkOrRequestHandlePermission(
  handle: SourceDirectoryHandleLike,
  mode: 'read' | 'readwrite',
  requestPermission: boolean,
): Promise<boolean> {
  if (typeof handle.queryPermission === 'function') {
    const current: FsPermissionState = await handle.queryPermission({ mode });
    if (current === 'granted') return true;
    if (requestPermission && typeof handle.requestPermission === 'function') {
      const requested = await handle.requestPermission({ mode });
      return requested === 'granted';
    }
    return false;
  }
  return true;
}

function xlsxCellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime()) ? '' : cell.toISOString().slice(0, 10);
  }
  return String(cell);
}

/**
 * PC Linked Local Folders adapter over the File System Access API (§3.2, §10.3).
 * - Persists multiple `FileSystemDirectoryHandle`s in IndexedDB `kv`
 * - Lazily imports `read-excel-file/universal` only when `.xlsx` files are encountered
 * - Resolves safe relative media, writes back CSV/TSV `Card ID`s with permission,
 *   and moves `Inbox/*.flashpkg` to `Inbox/imported/`
 */
export class WebLocalFolderSources implements LocalFolderSourcesAdapter {
  private readonly storage: Storage;
  private readonly pickDirectoryImpl:
    | ((options?: {
        id?: string;
        mode?: 'read' | 'readwrite';
      }) => Promise<SourceDirectoryHandleLike>)
    | undefined;

  constructor(options: WebLocalFolderSourcesOptions) {
    this.storage = options.storage;
    this.pickDirectoryImpl = options.pickDirectoryImpl;
  }

  isSupported(): boolean {
    if (this.pickDirectoryImpl) return true;
    return (
      typeof window !== 'undefined' &&
      typeof (window as unknown as WindowWithDirectoryPicker).showDirectoryPicker === 'function'
    );
  }

  private async getHandle(folderId: string): Promise<SourceDirectoryHandleLike> {
    const handle = await this.storage.getKv<SourceDirectoryHandleLike>(
      `${FOLDER_HANDLE_PREFIX}${folderId}`,
    );
    if (!handle) {
      throw new SyncTransportError(
        'NOT_FOUND',
        `Saved local folder handle "${folderId}" was not found. Re-link the folder in Library.`,
      );
    }
    return handle;
  }

  async pickFolder(): Promise<{ id: string; name: string } | null> {
    const picker =
      this.pickDirectoryImpl ??
      (typeof window !== 'undefined'
        ? (window as unknown as WindowWithDirectoryPicker).showDirectoryPicker
        : undefined);
    if (!picker) return null;

    let handle: SourceDirectoryHandleLike;
    try {
      handle = await picker({ id: 'flashcards-sources', mode: 'readwrite' });
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError') {
        return null;
      }
      // Fallback to read-only if browser denies readwrite picker
      try {
        handle = await picker({ id: 'flashcards-sources', mode: 'read' });
      } catch (err2) {
        if (
          err2 &&
          typeof err2 === 'object' &&
          (err2 as { name?: unknown }).name === 'AbortError'
        ) {
          return null;
        }
        throw err2;
      }
    }

    const canRead = await checkOrRequestHandlePermission(handle, 'read', true);
    if (!canRead) {
      throw new SyncTransportError(
        'PERMISSION_DENIED',
        `Read permission was not granted for folder "${handle.name}".`,
      );
    }

    const id = `folder-${uuidv7()}`;
    await this.storage.setKv(`${FOLDER_HANDLE_PREFIX}${id}`, handle);
    return { id, name: handle.name };
  }

  async removeFolder(folderId: string): Promise<void> {
    await this.storage.deleteKv(`${FOLDER_HANDLE_PREFIX}${folderId}`);
  }

  async ensurePermission(
    folderId: string,
    mode: 'read' | 'readwrite',
    requestPermission: boolean,
  ): Promise<boolean> {
    const handle = await this.getHandle(folderId);
    return checkOrRequestHandlePermission(handle, mode, requestPermission);
  }

  async listFolderFiles(folderId: string): Promise<ScannedLocalFileDescriptor[]> {
    const root = await this.getHandle(folderId);
    const canRead = await checkOrRequestHandlePermission(root, 'read', false);
    if (!canRead) {
      throw new SyncTransportError(
        'PERMISSION_DENIED',
        `Permission needed to read local folder "${root.name}". Click Reconnect in Library.`,
      );
    }

    const results: ScannedLocalFileDescriptor[] = [];

    const walk = async (
      dir: FileSystemDirectoryHandleLike,
      currentPath: string,
      inInboxRoot: boolean,
    ): Promise<void> => {
      for await (const [name, entry] of dir.entries()) {
        if (results.length >= MAX_SCANNED_FILES) return;
        // Skip hidden files/folders (e.g. .git, .DS_Store, ~temp Excel lock files)
        if (name.startsWith('.') || name.startsWith('~$')) continue;

        const relPath = currentPath ? `${currentPath}/${name}` : name;
        const lowerName = name.toLowerCase();

        if (entry.kind === 'directory') {
          // Never scan sync store internals if user linked the same folder as Local Sync
          if (currentPath === '' && lowerName === 'sync') continue;
          // Never re-scan Inbox/imported/ archive
          if (inInboxRoot && lowerName === 'imported') continue;
          const isChildInbox = currentPath === '' && lowerName === 'inbox';
          await walk(entry, relPath, isChildInbox);
        } else {
          const kind = classifySourceFile(name);
          if (!kind) continue;
          const file = await entry.getFile();
          const isInbox = inInboxRoot && kind === 'flashpkg';
          results.push({
            relativePath: relPath,
            name,
            kind,
            isInbox,
            size: file.size,
            lastModified: file.lastModified,
          });
        }
      }
    };

    try {
      await walk(root, '', false);
    } catch (err) {
      if (isFsPermissionError(err)) {
        throw new SyncTransportError(
          'PERMISSION_DENIED',
          `Permission denied scanning local folder "${root.name}".`,
        );
      }
      throw err;
    }

    results.sort((a, b) =>
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
    );
    return results;
  }

  private async resolveFileHandle(
    root: SourceDirectoryHandleLike,
    relativePath: string,
    create: boolean,
  ): Promise<FileSystemFileHandleLike> {
    const parts = splitRelativeSegments(relativePath);
    const fileName = parts[parts.length - 1];
    if (!fileName) {
      throw new SyncTransportError('UNKNOWN', `Invalid relative path "${relativePath}".`);
    }
    let dir: FileSystemDirectoryHandleLike = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!seg) continue;
      dir = await dir.getDirectoryHandle(seg, { create });
    }
    return dir.getFileHandle(fileName, { create });
  }

  async readFileBytes(
    folderId: string,
    relativePath: string,
    maxBytes: number = MAX_DEFAULT_FILE_BYTES,
  ): Promise<Uint8Array> {
    const root = await this.getHandle(folderId);
    const canRead = await checkOrRequestHandlePermission(root, 'read', false);
    if (!canRead) {
      throw new SyncTransportError(
        'PERMISSION_DENIED',
        `Permission needed to read "${relativePath}" in "${root.name}".`,
      );
    }

    try {
      const fh = await this.resolveFileHandle(root, relativePath, false);
      const file = await fh.getFile();
      if (file.size > maxBytes) {
        throw new SyncTransportError(
          'UNKNOWN',
          `File "${relativePath}" exceeds safety size cap (${maxBytes} bytes).`,
        );
      }
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      if (err instanceof SyncTransportError) throw err;
      if (isFsNotFoundError(err)) {
        throw new SyncTransportError('NOT_FOUND', `Local file not found: "${relativePath}"`);
      }
      if (isFsPermissionError(err)) {
        throw new SyncTransportError(
          'PERMISSION_DENIED',
          `Permission denied reading "${relativePath}".`,
        );
      }
      throw err;
    }
  }

  async parseXlsxBytes(bytes: Uint8Array): Promise<string[][]> {
    // Strictly lazy-loaded so `read-excel-file` never enters the initial study-screen bundle (§8)
    const { readSheet } = await import('read-excel-file/universal');
    const rows = await readSheet(bytes);
    return rows.map((row) => row.map(xlsxCellToString));
  }

  async readRelativeMedia(
    folderId: string,
    baseFileRelativePath: string,
    mediaRelativePath: string,
  ): Promise<{ bytes: Uint8Array; mime: string; ext: string } | null> {
    const cleanMedia = mediaRelativePath.trim();
    if (!isSafeRelativeMediaPath(cleanMedia)) return null;

    const extMatch = /\.([a-z0-9]{1,8})$/i.exec(cleanMedia);
    const ext = extMatch?.[1]?.toLowerCase() ?? '';
    const mime = SAFE_MEDIA_MIME_BY_EXT[ext];
    if (!mime) return null;

    const baseParts = splitRelativeSegments(baseFileRelativePath);
    const baseDirParts = baseParts.slice(0, -1);
    const combinedPath = [...baseDirParts, ...splitRelativeSegments(cleanMedia)].join('/');

    try {
      const bytes = await this.readFileBytes(folderId, combinedPath, MAX_MEDIA_FILE_BYTES);
      return { bytes, mime, ext };
    } catch {
      return null;
    }
  }

  async writeFileText(folderId: string, relativePath: string, text: string): Promise<void> {
    const root = await this.getHandle(folderId);
    const canWrite = await checkOrRequestHandlePermission(root, 'readwrite', false);
    if (!canWrite) {
      throw new SyncTransportError(
        'PERMISSION_DENIED',
        `Write permission not granted for folder "${root.name}".`,
      );
    }

    const fh = await this.resolveFileHandle(root, relativePath, true);
    const writable = await fh.createWritable();
    try {
      await writable.write(text);
    } finally {
      await writable.close();
    }
  }

  async moveInboxFileToImported(folderId: string, fileName: string): Promise<boolean> {
    const root = await this.getHandle(folderId);
    const canWrite = await checkOrRequestHandlePermission(root, 'readwrite', false);
    if (!canWrite) return false;

    // Locate the Inbox directory case-insensitively at root
    let inboxDir: SourceDirectoryHandleLike | null = null;
    for await (const [name, entry] of root.entries()) {
      if (entry.kind === 'directory' && name.toLowerCase() === 'inbox') {
        inboxDir = entry as SourceDirectoryHandleLike;
        break;
      }
    }
    if (!inboxDir) return false;

    try {
      const srcHandle = await inboxDir.getFileHandle(fileName, { create: false });
      const srcFile = await srcHandle.getFile();
      const bytes = new Uint8Array(await srcFile.arrayBuffer());

      const importedDir = await inboxDir.getDirectoryHandle('imported', { create: true });

      // Avoid overwriting an existing file in Inbox/imported/
      let destName = fileName;
      let suffix = 1;
      while (suffix < 100) {
        try {
          await importedDir.getFileHandle(destName, { create: false });
          const dotIdx = fileName.lastIndexOf('.');
          destName =
            dotIdx > 0
              ? `${fileName.slice(0, dotIdx)}-${suffix}${fileName.slice(dotIdx)}`
              : `${fileName}-${suffix}`;
          suffix += 1;
        } catch (err) {
          if (isFsNotFoundError(err)) break;
          throw err;
        }
      }

      const destHandle = await importedDir.getFileHandle(destName, { create: true });
      const writable = await destHandle.createWritable();
      try {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        await writable.write(copy);
      } finally {
        await writable.close();
      }

      if (typeof inboxDir.removeEntry === 'function') {
        await inboxDir.removeEntry(fileName);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}
