import { describe, expect, it, vi } from 'vitest';
import { WebStrokeDataProvider } from '../src/drawing/web-stroke-provider.ts';
import type { DexiePackStorage } from '../src/packs/dexie-pack-storage.ts';

/**
 * P8: a stroke download over the 1 MB cap is refused, even when the server sends no
 * Content-Length or a lying one. The body is valid stroke data, so only the cap can reject it.
 */

function strokeJson(padTo: number): string {
  const base = {
    strokes: ['M 1 1 L 2 2 Z'],
    medians: [
      [
        [1, 1],
        [2, 2],
      ],
    ],
  };
  const text = JSON.stringify(base);
  const pad = Math.max(0, padTo - text.length);
  return JSON.stringify({ ...base, strokes: [`M 1 1 L 2 2 Z${' '.repeat(pad)}`] });
}

function setup(body: string, headers: Record<string, string> = {}) {
  const putSingleStroke = vi.fn(async () => undefined);
  const packStorage = {
    getStroke: async () => undefined,
    getCachedCatalog: async () => ({
      catalog: {
        packs: [
          {
            kind: 'strokes',
            script: 'ja',
            char_url_template: 'https://packs.example.com/strokes/ja/{hex5}.json',
          },
        ],
      },
    }),
    putSingleStroke,
  } as unknown as DexiePackStorage;
  const fetchImpl = vi.fn(async () => {
    // A stream without a declared length unless the test sets one.
    const stream = new Response(body).body;
    return new Response(stream, { status: 200, headers });
  });
  const provider = new WebStrokeDataProvider({ packStorage, fetchImpl });
  return { provider, putSingleStroke, fetchImpl };
}

describe('WebStrokeDataProvider download cap (P8)', () => {
  it('accepts a normal-size stroke file', async () => {
    const { provider, putSingleStroke } = setup(strokeJson(2_000));
    await expect(provider.getCharacterData('ja', '日')).resolves.not.toBeNull();
    expect(putSingleStroke).toHaveBeenCalledTimes(1);
  });

  it('refuses an over-cap body sent without Content-Length', async () => {
    const { provider, putSingleStroke, fetchImpl } = setup(strokeJson(1024 * 1024 + 10));
    await expect(provider.getCharacterData('ja', '日')).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(putSingleStroke).not.toHaveBeenCalled();
  });

  it('refuses an over-cap body whose Content-Length lies', async () => {
    const { provider, putSingleStroke } = setup(strokeJson(1024 * 1024 + 10), {
      'content-length': '500',
    });
    await expect(provider.getCharacterData('ja', '日')).resolves.toBeNull();
    expect(putSingleStroke).not.toHaveBeenCalled();
  });
});
