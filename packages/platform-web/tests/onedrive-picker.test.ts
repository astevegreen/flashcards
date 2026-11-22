import { describe, expect, it, vi } from 'vitest';
import { GraphOneDriveFilePicker, isPickableOneDriveFile } from '../src/sources/onedrive-picker.ts';
import { FakeGraphServer } from './fakes/fake-graph.ts';

function setup(options: { hasFilesRead?: boolean; maxBytes?: number } = {}) {
  const graph = new FakeGraphServer({ pageSize: 2 });
  const enc = new TextEncoder();
  graph.drive.put('Decks/korean.csv', enc.encode('Front,Back\n개,dog\n'), 1_700_000_000_000);
  graph.drive.put('Decks/notes.docx', enc.encode('ignored'), 1_700_000_000_000);
  graph.drive.put('Decks/Archive/old.flashpkg', new Uint8Array([80, 75, 3, 4]), 0);
  graph.drive.put('vocab.xlsx', new Uint8Array([80, 75, 5, 6]), 0);
  graph.drive.put('photo.jpg', new Uint8Array([1]), 0);
  const auth = {
    isConfigured: () => true,
    getValidAccessToken: vi.fn(async () => 'graph-token-1'),
    hasScope: vi.fn(
      async (scope: string) => scope === 'Files.Read' && options.hasFilesRead !== false,
    ),
    signIn: vi.fn(async () => null),
  };
  const picker = new GraphOneDriveFilePicker({
    auth,
    fetchImpl: graph.fetch,
    sleep: async () => {},
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  });
  return { graph, auth, picker };
}

describe('GraphOneDriveFilePicker (Files.Read, §15 Phase 12)', () => {
  it('lists folders first, then only importable files, following nextLink pages', async () => {
    const { picker } = setup();
    const root = await picker.listFolder();
    expect(root.map((i) => `${i.kind}:${i.name}`)).toEqual(['folder:Decks', 'file:vocab.xlsx']);

    const decks = root[0];
    if (!decks) throw new Error('missing folder');
    const inside = await picker.listFolder(decks.id);
    expect(inside.map((i) => `${i.kind}:${i.name}`)).toEqual(['folder:Archive', 'file:korean.csv']);
  });

  it('downloads a picked file through its pre-authenticated URL without the bearer token', async () => {
    const { graph, picker } = setup();
    const decks = (await picker.listFolder())[0];
    const csv = (await picker.listFolder(decks?.id)).find((i) => i.name === 'korean.csv');
    if (!csv) throw new Error('missing csv');
    const picked = await picker.downloadFile(csv);
    expect(picked.name).toBe('korean.csv');
    expect(picked.mime).toBe('text/csv');
    expect(new TextDecoder().decode(picked.bytes)).toContain('개,dog');
    expect(graph.authLeaks).toEqual([]);
  });

  it('refuses unsupported types and files over the size cap', async () => {
    const { picker } = setup({ maxBytes: 4 });
    const xlsx = (await picker.listFolder()).find((i) => i.name === 'vocab.xlsx');
    if (!xlsx) throw new Error('missing xlsx');
    await expect(picker.downloadFile({ ...xlsx, size: 10 })).rejects.toThrow(/50 MB/);
    await expect(
      picker.downloadFile({ id: 'x', name: 'photo.jpg', kind: 'file', size: 1 }),
    ).rejects.toThrow(/not a \.csv/);
    expect(isPickableOneDriveFile('Deck.FLASHPKG')).toBe(true);
    expect(isPickableOneDriveFile('deck.zip')).toBe(false);
  });

  it('reports file access from the granted scope and requests it with intent "sources"', async () => {
    const { auth, picker } = setup({ hasFilesRead: false });
    expect(await picker.hasFileAccess()).toBe(false);
    expect(await picker.requestFileAccess()).toBe(false);
    expect(auth.signIn).toHaveBeenCalledWith({ intent: 'sources' });
  });

  it('maps Graph 403 (no Files.Read consent) to PERMISSION_DENIED', async () => {
    const { graph, picker } = setup();
    graph.inject({ match: (req) => req.url.includes('/root/children'), status: 403 });
    await expect(picker.listFolder()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
