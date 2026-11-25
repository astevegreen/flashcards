import {
  buildStrokeLookupIndex,
  normalizeDrawingLang,
  recognizeHandwriting,
  type HandwritingCandidate,
  type HandwritingRecognizeOptions,
  type InkStroke,
  type StrokeLookupIndex,
} from '@flash/core/drawing';
import type { HandwritingRecognizer, InstalledPackInfo } from '@flash/platform';
import type { DexiePackStorage } from '../packs/dexie-pack-storage.ts';

/** The pack `listInstalledHanjaCharacters` reads. */
const HANJA_PACK_ID = 'dict-hanja-unihan';

/**
 * Web handwriting recognizer backed by our custom MIT stroke-matching algorithm (§6.4)
 * over quantized KanjiVG & Make Me a Hanzi medians stored in `DexiePackStorage`.
 * Runs off the main thread in `recognizer.worker.ts` when Web Workers are available,
 * with automatic main-thread fallback in non-worker test environments.
 */
export class WebStrokeRecognizer implements HandwritingRecognizer {
  readonly id = 'web-stroke-matcher';
  readonly isNative = false;

  private readonly packStorage: DexiePackStorage;
  private worker: Worker | null = null;
  private workerFailed = false;
  private nextReqId = 1;
  private pending = new Map<
    number,
    { resolve: (c: HandwritingCandidate[]) => void; reject: (e: Error) => void }
  >();

  /**
   * Loaded stroke indexes and the Hanja set, each kept until its source changes (P6): loading them
   * read whole packs from IndexedDB on every call. A pack's version is its `installedAt`.
   */
  private readonly loaded = new Map<string, { version: string; value: Promise<unknown> }>();

  constructor(packStorage: DexiePackStorage) {
    this.packStorage = packStorage;
  }

  private loadOnce<T>(name: string, version: string, load: () => Promise<T>): Promise<T> {
    const hit = this.loaded.get(name);
    if (hit?.version === version) return hit.value as Promise<T>;
    const value = load();
    this.loaded.set(name, { version, value });
    // A failed load is retried on the next call.
    value.catch(() => {
      if (this.loaded.get(name)?.value === value) this.loaded.delete(name);
    });
    return value;
  }

  /** Installed packs by id (one small read of the packs table): their `installedAt` versions. */
  private async installedPacks(): Promise<Map<string, InstalledPackInfo>> {
    const packs = await this.packStorage.listInstalledPacks();
    return new Map(packs.map((p) => [p.id, p]));
  }

  private async loadRelevantIndexes(
    lang: string | undefined,
    packs: ReadonlyMap<string, InstalledPackInfo>,
  ): Promise<StrokeLookupIndex[]> {
    const norm = normalizeDrawingLang(lang);
    const indexes: StrokeLookupIndex[] = [];

    const wantJa = norm === 'ja' || norm === 'ko' || !lang || lang === 'any';
    const wantZh =
      norm === 'zh-Hans' || norm === 'zh-Hant' || norm === 'ko' || !lang || lang === 'any';

    if (wantZh) {
      const idx = await this.loadScriptIndex('zh-Hans', packs);
      if (idx) indexes.push(idx);
    }
    if (wantJa) {
      const idx = await this.loadScriptIndex('ja', packs);
      if (idx) indexes.push(idx);
    }
    return indexes;
  }

  private async loadScriptIndex(
    script: 'ja' | 'zh-Hans',
    packs: ReadonlyMap<string, InstalledPackInfo>,
  ): Promise<StrokeLookupIndex | null> {
    const installs = [...packs.values()]
      .filter((p) => p.kind === 'strokes' && p.script === script)
      .map((p) => `${p.id}@${p.installedAt}`);
    // With no stroke pack, the index is built from deck strokes cached one by one: their count
    // changes when one is added.
    const version =
      installs.length > 0
        ? installs.join(',')
        : `deck:${await this.packStorage.countStrokesByScript(script)}`;
    return this.loadOnce(`strokes:${script}`, version, () => this.readScriptIndex(script));
  }

  private async readScriptIndex(script: 'ja' | 'zh-Hans'): Promise<StrokeLookupIndex | null> {
    const stored = await this.packStorage.getStrokeIndex(script);
    if (stored && stored.entries.length > 0) {
      return stored;
    }
    // Fallback: build an in-memory index from any individually pre-cached deck strokes
    const rows = await this.packStorage.listStrokesByScript(script);
    if (rows.length === 0) return null;
    return buildStrokeLookupIndex(
      script,
      rows.map((r) => ({ char: r.char, medians: r.data.medians })),
    );
  }

  async isReady(lang?: string): Promise<boolean> {
    const indexes = await this.loadRelevantIndexes(lang, await this.installedPacks());
    return indexes.some((idx) => idx.entries.length > 0);
  }

  private getOrCreateWorker(): Worker | null {
    if (this.workerFailed) return null;
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') {
      this.workerFailed = true;
      return null;
    }
    try {
      const w = new Worker(new URL('../workers/recognizer.worker.ts', import.meta.url), {
        type: 'module',
      });
      w.onmessage = (
        ev: MessageEvent<{
          id: number;
          ok: boolean;
          candidates?: HandwritingCandidate[];
          error?: string;
        }>,
      ) => {
        const msg = ev.data;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.ok && msg.candidates) {
          entry.resolve(msg.candidates);
        } else {
          entry.reject(new Error(msg.error ?? 'Recognizer worker failed'));
        }
      };
      w.onerror = () => {
        this.workerFailed = true;
        for (const entry of this.pending.values()) {
          entry.reject(new Error('Recognizer worker error'));
        }
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
      };
      this.worker = w;
      return w;
    } catch {
      this.workerFailed = true;
      return null;
    }
  }

  async recognize(
    strokes: readonly InkStroke[],
    options: HandwritingRecognizeOptions = {},
  ): Promise<HandwritingCandidate[]> {
    const packs = await this.installedPacks();
    const indexes = await this.loadRelevantIndexes(options.lang, packs);
    if (indexes.length === 0) return [];

    let preferredChars = options.preferredChars;
    if (!preferredChars && normalizeDrawingLang(options.lang) === 'ko') {
      const hanjaVersion = String(packs.get(HANJA_PACK_ID)?.installedAt);
      const hanjaChars = await this.loadOnce('hanja', hanjaVersion, () =>
        this.packStorage.listInstalledHanjaCharacters(),
      );
      if (hanjaChars.size > 0) {
        preferredChars = hanjaChars;
      }
    }

    const totalTemplates = indexes.reduce((acc, idx) => acc + idx.entries.length, 0);
    // Run on main thread for tiny indexes (< 400 templates) or when Worker unavailable; use Worker for large packs
    const worker = totalTemplates >= 400 ? this.getOrCreateWorker() : null;
    if (worker) {
      try {
        const reqId = this.nextReqId++;
        return await new Promise<HandwritingCandidate[]>((resolve, reject) => {
          this.pending.set(reqId, { resolve, reject });
          worker.postMessage({
            id: reqId,
            type: 'recognize',
            strokes,
            indexes,
            options: {
              ...(options.lang !== undefined ? { lang: options.lang } : {}),
              ...(options.maxResults !== undefined ? { maxResults: options.maxResults } : {}),
              ...(options.strokeCountTolerance !== undefined
                ? { strokeCountTolerance: options.strokeCountTolerance }
                : {}),
              ...(preferredChars ? { preferredCharsList: [...preferredChars] } : {}),
            },
          });
        });
      } catch {
        // Fall through to synchronous main-thread recognition
      }
    }

    return recognizeHandwriting(strokes, indexes, {
      ...options,
      ...(preferredChars ? { preferredChars } : {}),
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
