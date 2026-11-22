import type {
  HandwritingCandidate,
  HandwritingRecognizeOptions,
  HandwritingRecognizer,
  InkStroke,
} from '@flash/platform';

export interface MlKitDigitalInkPlugin {
  isModelDownloaded(opts: { languageTag: string }): Promise<{ downloaded: boolean }>;
  downloadModel(opts: { languageTag: string }): Promise<void>;
  recognize(opts: {
    languageTag: string;
    strokes: Array<{ points: Array<{ x: number; y: number; t?: number }> }>;
    maxResults: number;
  }): Promise<{ candidates: Array<{ text: string; score?: number }> }>;
}

function toMlKitLangTag(lang: string | undefined): string {
  const clean = (lang ?? 'ko').trim().toLowerCase();
  if (clean === 'ja' || clean.startsWith('ja-')) return 'ja';
  if (clean.startsWith('zh-hant') || clean === 'zh-tw' || clean === 'zh-hk') return 'zh-Hant';
  if (clean.startsWith('zh')) return 'zh-Hans';
  // For Korean Hanja lookup, ML Kit uses `zh-Hant` / `ja` Han character models or `ko`
  if (clean === 'ko' || clean.startsWith('ko-')) return 'zh-Hant';
  return 'ja';
}

/**
 * Native Google ML Kit Digital Ink Recognition adapter for Capacitor Android & iOS (§6.4, §15 Phase 8).
 * Consumes the exact timestamped `InkStroke[]` emitted by `PointerInkCanvas` with zero UI changes.
 */
export class CapacitorMlKitInkRecognizer implements HandwritingRecognizer {
  readonly id = 'mlkit-digital-ink';
  readonly isNative = true;
  private readonly plugin?: MlKitDigitalInkPlugin;
  private readonly fallback?: HandwritingRecognizer;

  constructor(options: { plugin?: MlKitDigitalInkPlugin; fallback?: HandwritingRecognizer } = {}) {
    if (options.plugin) this.plugin = options.plugin;
    if (options.fallback) this.fallback = options.fallback;
  }

  async isReady(lang?: string): Promise<boolean> {
    if (this.plugin) {
      try {
        const res = await this.plugin.isModelDownloaded({ languageTag: toMlKitLangTag(lang) });
        if (res.downloaded) return true;
      } catch {
        // Fall through to fallback
      }
    }
    return this.fallback ? this.fallback.isReady(lang) : false;
  }

  async recognize(
    strokes: readonly InkStroke[],
    options?: HandwritingRecognizeOptions,
  ): Promise<HandwritingCandidate[]> {
    if (strokes.length === 0) return [];
    const maxResults = options?.maxResults ?? 12;

    if (this.plugin) {
      const languageTag = toMlKitLangTag(options?.lang);
      const status = await this.plugin.isModelDownloaded({ languageTag });
      if (!status.downloaded) {
        await this.plugin.downloadModel({ languageTag });
      }
      const res = await this.plugin.recognize({
        languageTag,
        strokes: strokes.map((stroke) => ({
          points: stroke.map((p) => ({
            x: p.x,
            y: p.y,
            ...(p.t !== undefined ? { t: p.t } : {}),
          })),
        })),
        maxResults,
      });

      const out: HandwritingCandidate[] = [];
      const seen = new Set<string>();
      res.candidates.forEach((cand, idx) => {
        const ch = [...cand.text.trim()][0];
        if (!ch || seen.has(ch)) return;
        seen.add(ch);
        out.push({
          character: ch,
          score: typeof cand.score === 'number' ? cand.score : Math.max(0, 1 - idx * 0.05),
          strokeCount: strokes.length,
        });
      });
      if (out.length > 0) return out.slice(0, maxResults);
    }

    if (this.fallback) {
      return this.fallback.recognize(strokes, options);
    }
    return [];
  }
}
