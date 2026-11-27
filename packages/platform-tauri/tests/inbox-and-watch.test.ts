import { afterEach, describe, expect, it, vi } from 'vitest';
import { TauriLocalFolderWatcher, TauriSqliteStorage, type TauriFsBridge } from '../src/index.ts';
import { watchDirectoryWith } from '../src/native/watch-directory.ts';
import { memoryTauriDb } from './support/memory-tauri-db.ts';

function memoryBridge(files: Map<string, Uint8Array>, withExists: boolean): TauriFsBridge {
  return {
    pickDirectory: async () => ({ path: '/notes', name: 'Notes' }),
    listDirectoryFiles: async (root) =>
      [...files.keys()]
        .filter((k) => k.startsWith(`${root}/`))
        .map((abs) => {
          const rel = abs.slice(root.length + 1);
          return { relativePath: rel, name: rel.split('/').pop() ?? rel, size: 1, lastModified: 1 };
        }),
    readFileBytes: async (abs) => files.get(abs) ?? new Uint8Array(),
    writeFileBytes: async (abs, data) => {
      files.set(abs, data);
    },
    // Like `rename`, this replaces an existing target.
    moveFile: async (from, to) => {
      const b = files.get(from);
      if (b) {
        files.delete(from);
        files.set(to, b);
      }
    },
    ...(withExists ? { pathExists: async (abs: string) => files.has(abs) } : {}),
  };
}

const text = (s: string) => new TextEncoder().encode(s);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Inbox move keeps earlier imports (N8)', () => {
  for (const withExists of [true, false]) {
    it(`never overwrites a same-name file in Inbox/imported/ (pathExists: ${withExists})`, async () => {
      const files = new Map([
        ['/notes/Inbox/imported/words.csv', text('first')],
        ['/notes/Inbox/imported/words-1.csv', text('second')],
        ['/notes/Inbox/words.csv', text('third')],
      ]);
      const watcher = new TauriLocalFolderWatcher({
        storage: new TauriSqliteStorage(memoryTauriDb()),
        bridge: memoryBridge(files, withExists),
      });
      const picked = await watcher.pickFolder();
      expect(await watcher.moveInboxFileToImported(picked?.id ?? '', 'words.csv')).toBe(true);
      const decode = (k: string) => new TextDecoder().decode(files.get(k));
      expect(decode('/notes/Inbox/imported/words.csv')).toBe('first');
      expect(decode('/notes/Inbox/imported/words-1.csv')).toBe('second');
      expect(decode('/notes/Inbox/imported/words-2.csv')).toBe('third');
      expect(files.has('/notes/Inbox/words.csv')).toBe(false);
    });
  }
});

describe('folder watcher start failure (N8)', () => {
  it('logs a watch that fails to start instead of leaving an unhandled rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const stop = watchDirectoryWith(
        () => Promise.reject(new Error('forbidden path')),
        '/notes',
        () => undefined,
      );
      await new Promise((r) => setTimeout(r, 10));
      stop();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('reports changed paths relative to the root and unwatches', async () => {
    let emit: ((e: { paths: string[] }) => void) | undefined;
    const unwatch = vi.fn();
    const seen: string[][] = [];
    const stop = watchDirectoryWith(
      async (_p, cb) => {
        emit = cb;
        return unwatch;
      },
      'C:\\notes\\',
      (p) => seen.push(p),
    );
    await Promise.resolve();
    emit?.({ paths: ['C:\\notes\\Inbox\\a.csv', 'D:\\other\\b.csv'] });
    expect(seen).toEqual([['Inbox/a.csv']]);
    stop();
    expect(unwatch).toHaveBeenCalled();
  });
});

describe('folder paths reject `..` segments, not names with two dots (§11 nit)', () => {
  async function pickedWatcher(files: Map<string, Uint8Array>) {
    const watcher = new TauriLocalFolderWatcher({
      storage: new TauriSqliteStorage(memoryTauriDb()),
      bridge: memoryBridge(files, true),
    });
    const picked = await watcher.pickFolder();
    return { watcher, id: picked?.id ?? '' };
  }

  it('reads a file whose name has two dots, and refuses traversal with either separator', async () => {
    const files = new Map([['/notes/decks/a..b.csv', text('ok')]]);
    const { watcher, id } = await pickedWatcher(files);
    expect(new TextDecoder().decode(await watcher.readFileBytes(id, 'decks/a..b.csv'))).toBe('ok');
    expect(new TextDecoder().decode(await watcher.readFileBytes(id, 'decks\\a..b.csv'))).toBe('ok');
    for (const rel of [
      '../secret.csv',
      'decks/../../secret.csv',
      '..\\secret.csv',
      'decks\\..\\..\\x',
      'decks/..\\x',
    ]) {
      await expect(watcher.readFileBytes(id, rel)).rejects.toThrow(/Unsafe relative path/);
    }
  });

  it('resolves media next to the deck file, and returns null for traversal', async () => {
    const files = new Map([['/notes/decks/img..1.png', new Uint8Array([1, 2])]]);
    const { watcher, id } = await pickedWatcher(files);
    const media = await watcher.readRelativeMedia(id, 'decks/words.csv', 'img..1.png');
    expect(media?.bytes).toEqual(new Uint8Array([1, 2]));
    expect(media?.mime).toBe('image/png');
    for (const rel of ['../x.png', '..\\x.png', 'a/..\\..\\x.png', 'C:/x.png']) {
      expect(await watcher.readRelativeMedia(id, 'decks/words.csv', rel)).toBeNull();
    }
  });

  it('returns null for a media path with a NUL, even when that file exists', async () => {
    // The files exist at the joined paths, so only the NUL check stands between them and a read.
    const files = new Map([
      ['/notes/decks/img\0.png', new Uint8Array([1])],
      ['/notes/decks/a\0/x.png', new Uint8Array([2])],
      ['/notes/decks/x.png', new Uint8Array([3])],
    ]);
    const { watcher, id } = await pickedWatcher(files);
    for (const rel of ['img\0.png', 'a\0/x.png', '\0x.png', 'x.png\0']) {
      expect(await watcher.readRelativeMedia(id, 'decks/words.csv', rel), rel).toBeNull();
    }
    // A NUL in the deck file's own path is refused the same way.
    expect(await watcher.readRelativeMedia(id, 'decks\0/words.csv', 'x.png')).toBeNull();
    expect((await watcher.readRelativeMedia(id, 'decks/words.csv', 'x.png'))?.bytes).toEqual(
      new Uint8Array([3]),
    );
  });
});
