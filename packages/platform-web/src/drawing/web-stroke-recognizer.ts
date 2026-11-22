import {
  buildStrokeLookupIndex,
  normalizeDrawingLang,
  recognizeHandwriting,
  type HandwritingCandidate,
  type HandwritingRecognizeOptions,
  type InkStroke,
  type StrokeLookupIndex,
} from '@flash/core/drawing';
import type { HandwritingRecognizer } from '@flash/platform';
import type { DexiePackStorage } from '../packs/dexie-pack-storage.ts';

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

  constructor(packStorage: DexiePackStorage) {
    this.packStorage = packStorage;
  }

  private async loadRelevantIndexes(lang?: string): Promise<StrokeLookupIndex[]> {
    const norm = normalizeDrawingLang(lang);
    const indexes: StrokeLookupIndex[] = [];

    const wantJa = norm === 'ja' || norm === 'ko' || !lang || lang === 'any';
    const wantZh =
      norm === 'zh-Hans' || norm === 'zh-Hant' || norm === 'ko' || !lang || lang === 'any';

    if (wantZh) {
      const idx = await this.loadScriptIndex('zh-Hans');
      if (idx) indexes.push(idx);
    }
    if (wantJa) {
      const idx = await this.loadScriptIndex('ja');
      if (idx) indexes.push(idx);
    }
    return indexes;
  }

  private async loadScriptIndex(script: 'ja' | 'zh-Hans'): Promise<StrokeLookupIndex | null> {
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
    const indexes = await this.loadRelevantIndexes(lang);
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
    const indexes = await this.loadRelevantIndexes(options.lang);
    if (indexes.length === 0) return [];

    let preferredChars = options.preferredChars;
    if (!preferredChars && normalizeDrawingLang(options.lang) === 'ko') {
      const hanjaChars = await this.packStorage.listInstalledHanjaCharacters();
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
