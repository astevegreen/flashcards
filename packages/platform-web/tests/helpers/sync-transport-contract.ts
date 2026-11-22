import { isSyncTransportError } from '@flash/core';
import type { SyncTransport } from '@flash/platform';
import { describe, expect, it } from 'vitest';

/**
 * Shared §4.3 `SyncTransport` contract suite. Any transport (in-memory, OneDrive, …) runs the same
 * behavioral checks the sync engine relies on: binary-safe round trips, prefix listing in
 * code-unit order, write-once `ifAbsent` -> `ALREADY_EXISTS`, overwrite, and `NOT_FOUND` reads.
 */
export function describeSyncTransportContract(
  name: string,
  createTransport: () => Promise<SyncTransport> | SyncTransport,
): void {
  describe(`SyncTransport contract: ${name}`, () => {
    it('round-trips binary payloads byte-for-byte', async () => {
      const transport = await createTransport();
      const payload = new Uint8Array([0, 255, 10, 13, 0x1f, 0x8b, 128]);
      await transport.write('sync/v1/devices/a/seg-000001.jsonl.gz', payload, { ifAbsent: true });
      expect(await transport.read('sync/v1/devices/a/seg-000001.jsonl.gz')).toEqual(payload);
    });

    it('lists by prefix across nested folders in code-unit order', async () => {
      const transport = await createTransport();
      const bytes = new Uint8Array([1]);
      await transport.write('sync/v1/manifest.json', bytes);
      await transport.write('sync/v1/devices/b/head.json', bytes);
      await transport.write('sync/v1/devices/a/head.json', bytes);
      await transport.write('sync/v1/devices/a/seg-000001.jsonl.gz', new Uint8Array([1, 2, 3]));
      await transport.write('media/ab/abcd.png', bytes);

      const all = await transport.list('sync/v1/');
      expect(all.map((f) => f.path)).toEqual([
        'sync/v1/devices/a/head.json',
        'sync/v1/devices/a/seg-000001.jsonl.gz',
        'sync/v1/devices/b/head.json',
        'sync/v1/manifest.json',
      ]);
      expect(all.find((f) => f.path.endsWith('seg-000001.jsonl.gz'))?.size).toBe(3);

      const partial = await transport.list('sync/v1/devices/a/seg-');
      expect(partial.map((f) => f.path)).toEqual(['sync/v1/devices/a/seg-000001.jsonl.gz']);
      expect((await transport.list('media/')).map((f) => f.path)).toEqual(['media/ab/abcd.png']);
    });

    it('returns an empty list for a prefix nothing was written under', async () => {
      const transport = await createTransport();
      expect(await transport.list('sync/v1/devices/')).toEqual([]);
    });

    it('rejects ifAbsent writes over an existing file with ALREADY_EXISTS', async () => {
      const transport = await createTransport();
      const first = new Uint8Array([7, 7]);
      await transport.write('sync/v1/devices/a/seg-000002.jsonl.gz', first, { ifAbsent: true });
      const err = await transport
        .write('sync/v1/devices/a/seg-000002.jsonl.gz', new Uint8Array([9]), { ifAbsent: true })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(isSyncTransportError(err) && err.code).toBe('ALREADY_EXISTS');
      expect(await transport.read('sync/v1/devices/a/seg-000002.jsonl.gz')).toEqual(first);
    });

    it('overwrites mutable files (head.json) without ifAbsent', async () => {
      const transport = await createTransport();
      await transport.write('sync/v1/devices/a/head.json', new TextEncoder().encode('{"seq":1}'));
      await transport.write('sync/v1/devices/a/head.json', new TextEncoder().encode('{"seq":2}'));
      const text = new TextDecoder().decode(await transport.read('sync/v1/devices/a/head.json'));
      expect(text).toBe('{"seq":2}');
    });

    it('reports NOT_FOUND for a missing file', async () => {
      const transport = await createTransport();
      const err = await transport.read('sync/v1/devices/zz/head.json').then(
        () => null,
        (e: unknown) => e,
      );
      expect(isSyncTransportError(err) && err.code).toBe('NOT_FOUND');
    });
  });
}
