import 'fake-indexeddb/auto';
import { encodeUtf8 } from '@flash/core';
import { describe, expect, it } from 'vitest';
import {
  WebLocalFolderSources,
  type SourceDirectoryHandleLike,
} from '../src/sources/local-folder-sources.ts';
import { DexieStorage } from '../src/storage/dexie-storage.ts';
import type {
  FileSystemDirectoryHandleLike,
  FileSystemFileHandleLike,
  FsPermissionState,
} from '../src/sync/local-folder-transport.ts';

class MemoryFileHandle implements FileSystemFileHandleLike {
  readonly kind = 'file' as const;
  readonly name: string;
  bytes: Uint8Array;
  lastModified: number;

  constructor(name: string, bytes: Uint8Array, lastModified = 1000) {
    this.name = name;
    this.bytes = bytes;
    this.lastModified = lastModified;
  }

  async getFile() {
    const copy = new Uint8Array(this.bytes.byteLength);
    copy.set(this.bytes);
    return {
      size: copy.byteLength,
      lastModified: this.lastModified,
      arrayBuffer: async () => copy.buffer,
    };
  }

  async createWritable() {
    const chunks: Uint8Array[] = [];
    return {
      write: async (data: BufferSource | Blob | string) => {
        if (typeof data === 'string') {
          chunks.push(encodeUtf8(data));
        } else if (data instanceof Uint8Array) {
          chunks.push(new Uint8Array(data));
        } else if (data instanceof ArrayBuffer) {
          chunks.push(new Uint8Array(data));
        } else if (ArrayBuffer.isView(data)) {
          chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        }
      },
      close: async () => {
        const total = chunks.reduce((s, c) => s + c.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.byteLength;
        }
        this.bytes = out;
        this.lastModified += 1000;
      },
    };
  }
}

class MemoryDirHandle implements SourceDirectoryHandleLike {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly children = new Map<string, MemoryDirHandle | MemoryFileHandle>();
  readPerm: FsPermissionState;
  writePerm: FsPermissionState;

  constructor(
    name: string,
    opts?: { readPerm?: FsPermissionState; writePerm?: FsPermissionState },
  ) {
    this.name = name;
    this.readPerm = opts?.readPerm ?? 'granted';
    this.writePerm = opts?.writePerm ?? 'granted';
  }

  async queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<FsPermissionState> {
    return descriptor?.mode === 'readwrite' ? this.writePerm : this.readPerm;
  }

  async requestPermission(descriptor?: {
    mode?: 'read' | 'readwrite';
  }): Promise<FsPermissionState> {
    return descriptor?.mode === 'readwrite' ? this.writePerm : this.readPerm;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandleLike> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory') {
        const err = new Error('Type mismatch');
        err.name = 'TypeMismatchError';
        throw err;
      }
      return existing;
    }
    if (!options?.create) {
      const err = new Error(`Not found: ${name}`);
      err.name = 'NotFoundError';
      throw err;
    }
    const dir = new MemoryDirHandle(name, { readPerm: this.readPerm, writePerm: this.writePerm });
    this.children.set(name, dir);
    return dir;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandleLike> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') {
        const err = new Error('Type mismatch');
        err.name = 'TypeMismatchError';
        throw err;
      }
      return existing;
    }
    if (!options?.create) {
      const err = new Error(`Not found: ${name}`);
      err.name = 'NotFoundError';
      throw err;
    }
    const fh = new MemoryFileHandle(name, new Uint8Array(0));
    this.children.set(name, fh);
    return fh;
  }

  async removeEntry(name: string): Promise<void> {
    this.children.delete(name);
  }

  async *entries(): AsyncIterable<
    [string, FileSystemFileHandleLike | FileSystemDirectoryHandleLike]
  > {
    for (const entry of this.children.entries()) {
      yield entry;
    }
  }
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i] ?? 0;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal uncompressed (STORE) ZIP builder for test `.xlsx` fixtures with zero extra deps. */
function buildStoredZip(files: Record<string, Uint8Array>): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const [name, data] of Object.entries(files)) {
    const nameBytes = encodeUtf8(name);
    const crc = crc32(data);

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    localParts.push(lh, data);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centralParts.push(ch);

    offset += lh.length + data.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  const count = Object.keys(files).length;
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...localParts, ...centralParts, eocd];
  const total = all.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of all) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** Builds a minimal valid OOXML `.xlsx` archive with inline strings so `read-excel-file` parses real bytes. */
function buildMinimalXlsx(rows: string[][]): Uint8Array {
  const rowXml = rows
    .map((cells, rIdx) => {
      const cellXml = cells
        .map((val, cIdx) => {
          const col = String.fromCharCode(65 + cIdx);
          const escaped = val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<c r="${col}${rIdx + 1}" t="inlineStr"><is><t>${escaped}</t></is></c>`;
        })
        .join('');
      return `<row r="${rIdx + 1}">${cellXml}</row>`;
    })
    .join('');

  return buildStoredZip({
    '[Content_Types].xml': encodeUtf8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `</Types>`,
    ),
    '_rels/.rels': encodeUtf8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    ),
    'xl/workbook.xml': encodeUtf8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>` +
        `</workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': encodeUtf8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `</Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': encodeUtf8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<sheetData>${rowXml}</sheetData>` +
        `</worksheet>`,
    ),
  });
}

describe('WebLocalFolderSources', () => {
  it('scans .csv, .xlsx (via lazy read-excel-file), .md, relative media, and moves Inbox/*.flashpkg to Inbox/imported/', async () => {
    const storage = new DexieStorage(`local-src-${Date.now()}`);
    // Note: in-memory kv store avoids structured-clone issues with class instances in fake-indexeddb
    const kvMap = new Map<string, unknown>();
    const wrappedStorage = Object.assign(Object.create(Object.getPrototypeOf(storage)), storage, {
      getKv: async <T = unknown>(k: string) => kvMap.get(k) as T | undefined,
      setKv: async (k: string, v: unknown) => {
        kvMap.set(k, v);
      },
      deleteKv: async (k: string) => {
        kvMap.delete(k);
      },
    });

    const root = new MemoryDirHandle('Flashcards');
    root.children.set(
      'korean.csv',
      new MemoryFileHandle(
        'korean.csv',
        encodeUtf8('Word,Meaning,Image\n사과,apple,img/apple.png\n'),
      ),
    );
    const imgDir = new MemoryDirHandle('img');
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    imgDir.children.set('apple.png', new MemoryFileHandle('apple.png', pngBytes));
    root.children.set('img', imgDir);

    const xlsxBytes = buildMinimalXlsx([
      ['Word', 'Reading', 'Meaning'],
      ['食べる', 'たべる', 'to eat'],
    ]);
    root.children.set('japanese.xlsx', new MemoryFileHandle('japanese.xlsx', xlsxBytes));
    root.children.set(
      'grammar.md',
      new MemoryFileHandle('grammar.md', encodeUtf8('# Particles\nHello')),
    );

    // Should be skipped: sync/v1/* and Inbox/imported/*
    const syncDir = new MemoryDirHandle('sync');
    syncDir.children.set('manifest.json', new MemoryFileHandle('manifest.json', encodeUtf8('{}')));
    root.children.set('sync', syncDir);

    const inboxDir = new MemoryDirHandle('Inbox');
    inboxDir.children.set(
      'ai-deck.flashpkg',
      new MemoryFileHandle('ai-deck.flashpkg', new Uint8Array([1, 2, 3])),
    );
    const importedDir = new MemoryDirHandle('imported');
    importedDir.children.set(
      'old.flashpkg',
      new MemoryFileHandle('old.flashpkg', new Uint8Array([4, 5])),
    );
    inboxDir.children.set('imported', importedDir);
    root.children.set('Inbox', inboxDir);

    const adapter = new WebLocalFolderSources({
      storage: wrappedStorage,
      pickDirectoryImpl: async () => root,
    });

    const picked = await adapter.pickFolder();
    expect(picked?.name).toBe('Flashcards');
    if (!picked) return;

    const files = await adapter.listFolderFiles(picked.id);
    expect(files.map((f) => f.relativePath)).toEqual([
      'Inbox/ai-deck.flashpkg',
      'grammar.md',
      'japanese.xlsx',
      'korean.csv',
    ]);
    expect(files[0]?.isInbox).toBe(true);

    // Parse real .xlsx via lazy read-excel-file/universal
    const readXlsx = await adapter.readFileBytes(picked.id, 'japanese.xlsx');
    const parsedGrid = await adapter.parseXlsxBytes(readXlsx);
    expect(parsedGrid).toEqual([
      ['Word', 'Reading', 'Meaning'],
      ['食べる', 'たべる', 'to eat'],
    ]);

    // Read relative media and block traversal
    const media = await adapter.readRelativeMedia(picked.id, 'korean.csv', 'img/apple.png');
    expect(media?.mime).toBe('image/png');
    expect(media?.bytes).toEqual(pngBytes);
    expect(
      await adapter.readRelativeMedia(picked.id, 'korean.csv', '../etc/passwd.png'),
    ).toBeNull();

    // Write back CSV Card ID
    await adapter.writeFileText(
      picked.id,
      'korean.csv',
      'Word,Meaning,Card ID\n사과,apple,cid-1\n',
    );
    const updatedCsv = new TextDecoder().decode(
      await adapter.readFileBytes(picked.id, 'korean.csv'),
    );
    expect(updatedCsv).toContain('cid-1');

    // Move Inbox/ai-deck.flashpkg -> Inbox/imported/ai-deck.flashpkg
    const moved = await adapter.moveInboxFileToImported(picked.id, 'ai-deck.flashpkg');
    expect(moved).toBe(true);
    expect(inboxDir.children.has('ai-deck.flashpkg')).toBe(false);
    expect(importedDir.children.has('ai-deck.flashpkg')).toBe(true);

    storage.close();
  });
});
