import type {
  LocalFolderSourcesAdapter,
  ScannedLocalFileDescriptor,
  Storage,
  SyncFileInfo,
  SyncTransport,
} from '@flash/platform';

export interface TauriFsDirEntry {
  relativePath: string;
  name: string;
  size: number;
  lastModified: number;
}

export interface TauriFsBridge {
  pickDirectory(): Promise<{ path: string; name: string } | null>;
  listDirectoryFiles(rootPath: string): Promise<TauriFsDirEntry[]>;
  readFileBytes(absPath: string, maxBytes?: number): Promise<Uint8Array>;
  writeFileBytes(absPath: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void>;
  moveFile(fromPath: string, toPath: string): Promise<void>;
  /** True when `absPath` exists. Without it, `Inbox/imported/` is listed to find a free name. */
  pathExists?(absPath: string): Promise<boolean>;
  watchDirectory?(rootPath: string, onChange: (changedPaths: string[]) => void): () => void;
}

const REGISTRY_FOLDERS_KEY = 'tauri_linked_folders_v1';

function joinSafeRelative(root: string, rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.includes('..') || norm.includes('\0') || /^[a-zA-Z]:/.test(norm)) {
    throw new Error(`Unsafe relative path "${rel}".`);
  }
  const cleanRoot = root.replace(/[/\\]+$/, '');
  return `${cleanRoot}/${norm}`;
}

function classifyKind(name: string): ScannedLocalFileDescriptor['kind'] | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.tsv')) return 'tsv';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.md')) return 'md';
  if (lower.endsWith('.flashpkg')) return 'flashpkg';
  return null;
}

function guessMediaMime(ext: string): string | null {
  switch (ext.toLowerCase().replace(/^\./, '')) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
      return 'audio/ogg';
    case 'wav':
      return 'audio/wav';
    case 'm4a':
      return 'audio/mp4';
    default:
      return null;
  }
}

/**
 * Native Tauri desktop filesystem scanner + directory watcher for linked local folders
 * (Google Drive / Dropbox desktop folders) and `Inbox/` auto-import (§3.2, §10.3, §15 Phase 8).
 */
export class TauriLocalFolderWatcher implements LocalFolderSourcesAdapter {
  private readonly bridge?: TauriFsBridge;
  private readonly storage: Storage;
  private readonly xlsxParser?: (bytes: Uint8Array) => Promise<string[][]>;

  constructor(options: {
    storage: Storage;
    bridge?: TauriFsBridge;
    xlsxParser?: (bytes: Uint8Array) => Promise<string[][]>;
  }) {
    this.storage = options.storage;
    if (options.bridge) this.bridge = options.bridge;
    if (options.xlsxParser) this.xlsxParser = options.xlsxParser;
  }

  isSupported(): boolean {
    return Boolean(this.bridge);
  }

  private async getFolders(): Promise<Record<string, { path: string; name: string }>> {
    return (
      (await this.storage.getKv<Record<string, { path: string; name: string }>>(
        REGISTRY_FOLDERS_KEY,
      )) ?? {}
    );
  }

  async pickFolder(): Promise<{ id: string; name: string } | null> {
    if (!this.bridge) return null;
    const picked = await this.bridge.pickDirectory();
    if (!picked) return null;
    const id = `tauri-folder:${picked.path}`;
    const map = await this.getFolders();
    map[id] = { path: picked.path, name: picked.name };
    await this.storage.setKv(REGISTRY_FOLDERS_KEY, map);
    return { id, name: picked.name };
  }

  async removeFolder(folderId: string): Promise<void> {
    const map = await this.getFolders();
    const nextMap = Object.fromEntries(Object.entries(map).filter(([k]) => k !== folderId));
    await this.storage.setKv(REGISTRY_FOLDERS_KEY, nextMap);
  }

  async ensurePermission(folderId: string): Promise<boolean> {
    const map = await this.getFolders();
    return Boolean(this.bridge && map[folderId]);
  }

  async listFolderFiles(folderId: string): Promise<ScannedLocalFileDescriptor[]> {
    if (!this.bridge) return [];
    const map = await this.getFolders();
    const entry = map[folderId];
    if (!entry) return [];

    const raw = await this.bridge.listDirectoryFiles(entry.path);
    const out: ScannedLocalFileDescriptor[] = [];
    for (const item of raw) {
      const rel = item.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
      const lower = rel.toLowerCase();
      if (lower.startsWith('inbox/imported/') || lower.includes('/.')) continue;
      const kind = classifyKind(item.name);
      if (!kind) continue;
      out.push({
        relativePath: rel,
        name: item.name,
        kind,
        isInbox: lower.startsWith('inbox/') && !lower.slice('inbox/'.length).includes('/'),
        size: item.size,
        lastModified: item.lastModified,
      });
    }
    return out.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  }

  async readFileBytes(
    folderId: string,
    relativePath: string,
    maxBytes?: number,
  ): Promise<Uint8Array> {
    if (!this.bridge) throw new Error('Tauri filesystem bridge unavailable.');
    const map = await this.getFolders();
    const entry = map[folderId];
    if (!entry) throw new Error(`Unknown folder "${folderId}".`);
    return this.bridge.readFileBytes(joinSafeRelative(entry.path, relativePath), maxBytes);
  }

  canParseXlsx(): boolean {
    return this.xlsxParser !== undefined;
  }

  async parseXlsxBytes(bytes: Uint8Array): Promise<string[][]> {
    if (this.xlsxParser) return this.xlsxParser(bytes);
    throw new Error('Inject an XLSX parser for desktop Excel sheets.');
  }

  async readRelativeMedia(
    folderId: string,
    baseFileRelativePath: string,
    mediaRelativePath: string,
  ): Promise<{ bytes: Uint8Array; mime: string; ext: string } | null> {
    const cleanRel = mediaRelativePath.trim().replace(/\\/g, '/');
    if (!cleanRel || cleanRel.includes('..') || /^[a-zA-Z]+:/.test(cleanRel)) return null;
    const baseParts = baseFileRelativePath.replace(/\\/g, '/').split('/');
    baseParts.pop();
    const joined = [...baseParts, cleanRel].filter(Boolean).join('/');
    const dot = cleanRel.lastIndexOf('.');
    const ext = dot >= 0 ? cleanRel.slice(dot + 1).toLowerCase() : '';
    const mime = guessMediaMime(ext);
    if (!mime) return null;
    try {
      const bytes = await this.readFileBytes(folderId, joined, 25 * 1024 * 1024);
      return { bytes, mime, ext };
    } catch {
      return null;
    }
  }

  async writeFileText(folderId: string, relativePath: string, text: string): Promise<void> {
    if (!this.bridge) throw new Error('Tauri filesystem bridge unavailable.');
    const map = await this.getFolders();
    const entry = map[folderId];
    if (!entry) throw new Error(`Unknown folder "${folderId}".`);
    await this.bridge.writeFileBytes(
      joinSafeRelative(entry.path, relativePath),
      new TextEncoder().encode(text),
    );
  }

  async moveInboxFileToImported(folderId: string, fileName: string): Promise<boolean> {
    if (!this.bridge) return false;
    const map = await this.getFolders();
    const entry = map[folderId];
    if (!entry) return false;
    const cleanName = fileName.replace(/^Inbox\//i, '');
    const destName = await this.freeImportedName(entry.path, cleanName);
    if (!destName) return false;
    await this.bridge.moveFile(
      joinSafeRelative(entry.path, `Inbox/${cleanName}`),
      joinSafeRelative(entry.path, `Inbox/imported/${destName}`),
    );
    return true;
  }

  /**
   * A name in `Inbox/imported/` that no earlier import uses (N8): `name.csv`, then `name-1.csv`,
   * `name-2.csv`, … as the web Local Folder adapter does. `undefined` after 99 tries.
   */
  private async freeImportedName(root: string, fileName: string): Promise<string | undefined> {
    const bridge = this.bridge;
    if (!bridge) return undefined;
    let taken: (name: string) => Promise<boolean>;
    if (bridge.pathExists) {
      const pathExists = bridge.pathExists.bind(bridge);
      taken = (name) => pathExists(joinSafeRelative(root, `Inbox/imported/${name}`));
    } else {
      const existing = new Set(
        (await bridge.listDirectoryFiles(root))
          .map((f) => f.relativePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase())
          .filter((rel) => rel.startsWith('inbox/imported/')),
      );
      taken = async (name) => existing.has(`inbox/imported/${name}`.toLowerCase());
    }
    const dot = fileName.lastIndexOf('.');
    for (let suffix = 0; suffix < 100; suffix++) {
      let candidate = fileName;
      if (suffix > 0) {
        candidate =
          dot > 0
            ? `${fileName.slice(0, dot)}-${suffix}${fileName.slice(dot)}`
            : `${fileName}-${suffix}`;
      }
      if (!(await taken(candidate))) return candidate;
    }
    return undefined;
  }

  async watchFolder(
    folderId: string,
    onChange: (changedPaths: string[]) => void,
  ): Promise<() => void> {
    if (!this.bridge?.watchDirectory) return () => undefined;
    const map = await this.getFolders();
    const entry = map[folderId];
    if (!entry) return () => undefined;
    return this.bridge.watchDirectory(entry.path, onChange);
  }
}

/**
 * Native desktop folder `SyncTransport` for Tauri PC shells (Dropbox/Drive/Syncthing folder sync, §4.3).
 */
export class TauriFolderSyncTransport implements SyncTransport {
  private readonly rootPath: string;
  private readonly bridge: TauriFsBridge;

  constructor(rootPath: string, bridge: TauriFsBridge) {
    this.rootPath = rootPath;
    this.bridge = bridge;
  }

  async list(prefix: string): Promise<SyncFileInfo[]> {
    const cleanPrefix = prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const entries = await this.bridge.listDirectoryFiles(this.rootPath);
    return entries
      .map((e) => ({
        path: e.relativePath.replace(/\\/g, '/').replace(/^\/+/, ''),
        size: e.size,
        updatedAt: e.lastModified,
      }))
      .filter((e) => !cleanPrefix || e.path.startsWith(`${cleanPrefix}/`) || e.path === cleanPrefix)
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async read(path: string): Promise<Uint8Array> {
    return this.bridge.readFileBytes(joinSafeRelative(this.rootPath, path));
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    await this.bridge.writeFileBytes(joinSafeRelative(this.rootPath, path), data, opts);
  }
}
