import { assertSafePackUrl } from '@flash/core/dictionary';
import {
  charToKanjivgHex,
  convertKanjivgSvgToHanziWriter,
  isValidHanziStrokeData,
  type HanziStrokeData,
  type StrokeScript,
} from '@flash/core/drawing';
import type {
  AbortSignalLike,
  PackManager,
  StrokeCacheProgress,
  StrokeDataProvider,
} from '@flash/platform';
import { readTextCapped } from '../net/read-capped.ts';
import type { DexiePackStorage } from '../packs/dexie-pack-storage.ts';

/** One character's stroke JSON or KanjiVG SVG is a few KB; anything this big is not stroke data. */
const MAX_STROKE_RESPONSE_BYTES = 1024 * 1024;

export interface WebStrokeDataProviderOptions {
  packStorage: DexiePackStorage;
  packManager?: PackManager;
  allowRelativeUrls?: boolean;
  fetchImpl?: typeof fetch;
}

function expandCharUrlTemplate(template: string, char: string): string {
  const hex5 = charToKanjivgHex(char);
  return template.replaceAll('{hex5}', hex5).replaceAll('{char}', encodeURIComponent(char));
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean'
    ? true
    : navigator.onLine;
}

/**
 * Resolves stroke data for graded `draw` mode (§6.4, ADR 0001 Spike 0.6):
 * 1. Local IndexedDB (`flashcards-packs-db` strokes store, strictly separated by `ja` vs `zh-Hans`).
 * 2. Optional per-character static URL template declared in the unified `packs.json` manifest
 *    (hosted on the same CORS-enabled Cloudflare Pages / GitHub Pages / R2 pack host, or local
 *    `/packs/...` fixtures in dev/CI — never calling `raw.githubusercontent.com` or GitHub Releases).
 */
export class WebStrokeDataProvider implements StrokeDataProvider {
  private readonly packStorage: DexiePackStorage;
  private readonly packManager?: PackManager;
  private readonly allowRelativeUrls: boolean;
  private readonly fetchImpl: typeof fetch;
  private templateCache: Partial<Record<StrokeScript, string>> = {};
  private templateLoaded = false;

  constructor(options: WebStrokeDataProviderOptions) {
    this.packStorage = options.packStorage;
    if (options.packManager) {
      this.packManager = options.packManager;
    }
    this.allowRelativeUrls = options.allowRelativeUrls ?? false;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  private async resolveCharUrlTemplate(script: StrokeScript): Promise<string | undefined> {
    if (this.templateCache[script]) return this.templateCache[script];

    // Check already-cached packs.json first to avoid redundant network requests
    const cached = await this.packStorage.getCachedCatalog();
    if (cached) {
      for (const p of cached.catalog.packs) {
        if (p.kind === 'strokes' && p.script && p.char_url_template) {
          this.templateCache[p.script] = p.char_url_template;
        }
      }
      if (this.templateCache[script]) return this.templateCache[script];
    }

    if (!this.templateLoaded && this.packManager && isOnline()) {
      this.templateLoaded = true;
      try {
        const catalog = await this.packManager.fetchCatalog();
        for (const p of catalog.packs) {
          if (p.kind === 'strokes' && p.script && p.char_url_template) {
            this.templateCache[p.script] = p.char_url_template;
          }
        }
      } catch {
        // Offline or unconfigured catalog — fall back silently to locally cached strokes
      }
    }

    return this.templateCache[script];
  }

  async hasCachedCharacter(script: StrokeScript, char: string): Promise<boolean> {
    return this.packStorage.hasStroke(script, char);
  }

  async getCacheCoverage(
    script: StrokeScript,
    chars: readonly string[],
  ): Promise<{ cached: number; total: number; missing: string[] }> {
    const unique = [...new Set(chars.filter((c) => [...c].length === 1))];
    const missing: string[] = [];
    let cached = 0;
    for (const ch of unique) {
      if (await this.packStorage.hasStroke(script, ch)) {
        cached++;
      } else {
        missing.push(ch);
      }
    }
    return { cached, total: unique.length, missing };
  }

  async getCharacterData(
    script: StrokeScript,
    char: string,
    opts?: { allowNetwork?: boolean },
  ): Promise<HanziStrokeData | null> {
    const single = [...char.trim()][0];
    if (!single) return null;

    const cached = await this.packStorage.getStroke(script, single);
    if (cached) return cached;

    if (opts?.allowNetwork === false || !isOnline()) {
      return null;
    }

    const template = await this.resolveCharUrlTemplate(script);
    if (!template) {
      return null;
    }

    const rawUrl = expandCharUrlTemplate(template, single);
    let safeUrl: string;
    try {
      safeUrl = assertSafePackUrl(rawUrl, this.allowRelativeUrls || template.startsWith('/'));
    } catch {
      return null;
    }

    try {
      const res = await this.fetchImpl(safeUrl, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'follow',
      });
      if (!res.ok) return null;

      let parsed: HanziStrokeData | null = null;
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const text = await readTextCapped(res, MAX_STROKE_RESPONSE_BYTES, {
        tooLarge: () => new Error('Stroke data response is too large.'),
      });
      if (safeUrl.endsWith('.svg') || contentType.includes('svg')) {
        const converted = convertKanjivgSvgToHanziWriter(text);
        if (isValidHanziStrokeData(converted)) {
          parsed = converted;
        }
      } else {
        const json: unknown = JSON.parse(text);
        if (isValidHanziStrokeData(json)) {
          parsed = { strokes: json.strokes, medians: json.medians };
        }
      }

      if (parsed) {
        await this.packStorage.putSingleStroke(script, single, parsed);
        return parsed;
      }
    } catch {
      // Transient offline / CORS failure
    }
    return null;
  }

  async precacheCharacters(
    script: StrokeScript,
    chars: readonly string[],
    opts?: {
      onProgress?: (progress: StrokeCacheProgress) => void;
      signal?: AbortSignalLike;
    },
  ): Promise<{ cached: number; failed: string[] }> {
    const unique = [...new Set(chars.filter((c) => [...c].length === 1))];
    const total = unique.length;
    let completed = 0;
    let cachedCount = 0;
    const failed: string[] = [];

    if (total === 0) {
      opts?.onProgress?.({ completed: 0, total: 0, cached: 0, failed: 0 });
      return { cached: 0, failed: [] };
    }

    // Check which chars are already cached first
    const missing: string[] = [];
    for (const ch of unique) {
      if (await this.packStorage.hasStroke(script, ch)) {
        completed++;
        cachedCount++;
      } else {
        missing.push(ch);
      }
    }
    opts?.onProgress?.({ completed, total, cached: cachedCount, failed: 0 });

    // Bounded concurrency = 6 for polite static host fetching
    const CONCURRENCY = 6;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < missing.length) {
        if (opts?.signal?.aborted) return;
        const ch = missing[cursor++];
        if (!ch) continue;
        const data = await this.getCharacterData(script, ch, { allowNetwork: true });
        completed++;
        if (data) {
          cachedCount++;
        } else {
          failed.push(ch);
        }
        opts?.onProgress?.({
          completed,
          total,
          cached: cachedCount,
          failed: failed.length,
          currentChar: ch,
        });
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, missing.length) }, () => worker());
    await Promise.all(workers);

    return { cached: cachedCount, failed };
  }
}
