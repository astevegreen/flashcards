import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareCodeUnits } from '../../packages/core/src/study/queue.ts';
import { buildAnkiFixtures, DEFAULT_FIXTURE_DIR } from '../build-anki-fixtures.mjs';

describe('Anki .apkg fixtures', () => {
  it('are reproducible byte for byte from scripts/build-anki-fixtures.mjs', async () => {
    const built = await buildAnkiFixtures();
    const committed = readdirSync(DEFAULT_FIXTURE_DIR).filter((f) => f.endsWith('.apkg'));
    expect(committed.sort(compareCodeUnits)).toEqual(Object.keys(built).sort(compareCodeUnits));
    for (const [name, bytes] of Object.entries(built)) {
      const onDisk = new Uint8Array(readFileSync(join(DEFAULT_FIXTURE_DIR, name)));
      expect(Buffer.compare(Buffer.from(onDisk), Buffer.from(bytes)), name).toBe(0);
    }
  });

  it('stay tiny', () => {
    for (const name of readdirSync(DEFAULT_FIXTURE_DIR)) {
      expect(readFileSync(join(DEFAULT_FIXTURE_DIR, name)).byteLength, name).toBeLessThan(
        16 * 1024,
      );
    }
  });
});
