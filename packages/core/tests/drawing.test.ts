import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deserializeCollectionState,
  serializeCollectionState,
} from '../src/index.ts';
import {
  buildStrokeLookupIndex,
  charToKanjivgHex,
  convertKanjivgSvgToHanziWriter,
  extractDrawableCharacters,
  mapDrawMistakesToRating,
  recognizeHandwriting,
  resolveDrawingMode,
  resolveStrokeScriptForLang,
  type InkStroke,
} from '../src/drawing/index.ts';
import { describe, expect, it } from 'vitest';

const SAMPLE_KANJIVG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="109" height="109" viewBox="0 0 109 109">
<g id="kvg:StrokePaths_065e5">
  <path id="kvg:065e5-s1" d="M31.5,24.5c0.44,1,0.88,2.5,0.88,3.88c0,1.38-0.29,40.31-0.29,41"/>
  <path id="kvg:065e5-s2" d="M33.23,26.15c2.47-0.17,37.89-3.17,40.14-3.37c1.88-0.17,3.08,1.85,2.94,2.83c-0.29,2-0.57,41.29-0.57,42.29"/>
  <path id="kvg:065e5-s3" d="M33.67,46.79c3.35,0,37.82-2.73,41.61-2.73"/>
  <path id="kvg:065e5-s4" d="M33.52,67.5c6.81-0.72,33.7-2.63,42.19-3.25"/>
</g>
</svg>`;

/** Converts Hanzi Writer Y-up median points into screen Y-down InkStrokes for recognition tests. */
function mediansToScreenInk(
  medians: readonly (readonly (readonly number[])[])[],
  opts?: { dx?: number; dy?: number; scale?: number; jitter?: number },
): InkStroke[] {
  const dx = opts?.dx ?? 0;
  const dy = opts?.dy ?? 0;
  const scale = opts?.scale ?? 0.2;
  const jitter = opts?.jitter ?? 0;
  return medians.map((stroke, sIdx) =>
    stroke.map((pair, pIdx) => ({
      x: (pair[0] ?? 0) * scale + dx + (jitter ? ((sIdx + pIdx) % 2 === 0 ? jitter : -jitter) : 0),
      y:
        (900 - (pair[1] ?? 0)) * scale +
        dy +
        (jitter ? ((sIdx * 3 + pIdx) % 2 === 0 ? -jitter : jitter) : 0),
      t: sIdx * 300 + pIdx * 20,
    })),
  );
}

describe('Phase 6 core drawing utilities, KanjiVG converter & MIT recognizer', () => {
  it('maps draw mistake counts to FSRS ratings (§6.4: 0->Easy, 1-2->Good, 3+->Again)', () => {
    expect(mapDrawMistakesToRating(0)).toBe(4);
    expect(mapDrawMistakesToRating(-1)).toBe(4);
    expect(mapDrawMistakesToRating(1)).toBe(3);
    expect(mapDrawMistakesToRating(2)).toBe(3);
    expect(mapDrawMistakesToRating(3)).toBe(1);
    expect(mapDrawMistakesToRating(12)).toBe(1);
  });

  it('resolves per-language drawing mode defaults and synced overrides', () => {
    expect(resolveDrawingMode(undefined, 'ja')).toBe('graded');
    expect(resolveDrawingMode(undefined, 'ja-JP')).toBe('graded');
    expect(resolveDrawingMode(undefined, 'zh-Hans')).toBe('graded');
    expect(resolveDrawingMode(undefined, 'ko')).toBe('lookup');
    expect(resolveDrawingMode(undefined, 'en')).toBe('off');

    expect(resolveDrawingMode({ drawing_modes: { ja: 'lookup', ko: 'off' } }, 'ja')).toBe('lookup');
    expect(resolveDrawingMode({ drawing_modes: { ja: 'lookup', ko: 'off' } }, 'ko')).toBe('off');

    expect(resolveStrokeScriptForLang('ja')).toBe('ja');
    expect(resolveStrokeScriptForLang('zh-Hans')).toBe('zh-Hans');
    expect(resolveStrokeScriptForLang('ko')).toBe('zh-Hans');
  });

  it('extracts drawable CJK characters while stripping inline ruby and cloze syntax', () => {
    expect(extractDrawableCharacters('日本[にほん]', 'ja')).toEqual(['日', '本']);
    expect(extractDrawableCharacters('{今日|きょう}', 'ja')).toEqual(['今', '日']);
    expect(extractDrawableCharacters('私[わたし]は{{c1::学生[がくせい]}}です', 'ja')).toEqual([
      '私',
      '学',
      '生',
    ]);
    expect(extractDrawableCharacters('학교 (學校[학교])', 'ko')).toEqual(['學', '校']);
    expect(extractDrawableCharacters('学习!', 'zh-Hans')).toEqual(['学', '习']);
    // Kana fallback when Japanese word has no kanji
    expect(extractDrawableCharacters('ありがとう', 'ja')).toEqual(['あ', 'り', 'が', 'と', 'う']);
  });

  it('converts KanjiVG 109x109 SVG paths into Hanzi Writer 1024x1024 Y-flipped JSON', () => {
    expect(charToKanjivgHex('食')).toBe('098df');
    expect(charToKanjivgHex('日')).toBe('065e5');

    const hw = convertKanjivgSvgToHanziWriter(SAMPLE_KANJIVG_SVG);
    expect(hw.strokes).toHaveLength(4);
    expect(hw.medians).toHaveLength(4);
    for (const path of hw.strokes) {
      expect(path.startsWith('M ')).toBe(true);
      expect(path.endsWith(' Z')).toBe(true);
    }
    // Verify top of stroke 1 (y ≈ 24.5 in 109-space) flipped to high Y in Hanzi Writer Y-up space (~670)
    const firstPt = hw.medians[0]?.[0];
    expect(firstPt?.[0]).toBeGreaterThan(250);
    expect(firstPt?.[1]).toBeGreaterThan(600);
  });

  it('recognizes exact, noisy, out-of-order (Hanja), and stroke-count-variant drawings', () => {
    const chars = [
      {
        char: '一',
        medians: [
          [
            [140, 460],
            [512, 460],
            [884, 460],
          ],
        ],
      },
      {
        char: '二',
        medians: [
          [
            [220, 620],
            [804, 620],
          ],
          [
            [120, 260],
            [904, 260],
          ],
        ],
      },
      {
        char: '人',
        medians: [
          [
            [520, 810],
            [380, 450],
            [180, 110],
          ],
          [
            [450, 520],
            [640, 310],
            [860, 110],
          ],
        ],
      },
      {
        char: '口',
        medians: [
          [
            [240, 720],
            [260, 220],
          ],
          [
            [250, 710],
            [780, 710],
            [740, 220],
          ],
          [
            [280, 220],
            [740, 220],
          ],
        ],
      },
      {
        char: '日',
        medians: [
          [
            [270, 760],
            [270, 120],
          ],
          [
            [270, 760],
            [755, 760],
            [755, 120],
          ],
          [
            [280, 460],
            [740, 460],
          ],
          [
            [280, 145],
            [740, 145],
          ],
        ],
      },
      {
        char: '木',
        medians: [
          [
            [180, 610],
            [844, 610],
          ],
          [
            [512, 830],
            [512, 80],
          ],
          [
            [505, 600],
            [160, 170],
          ],
          [
            [520, 600],
            [870, 170],
          ],
        ],
      },
    ];

    const index = buildStrokeLookupIndex('zh-Hans', chars);
    expect(index.entries).toHaveLength(chars.length);

    // 1. Exact single stroke `一`
    const oneMedians = chars[0]?.medians ?? [];
    const oneInk = mediansToScreenInk(oneMedians);
    const oneRes = recognizeHandwriting(oneInk, [index]);
    expect(oneRes[0]?.character).toBe('一');
    expect(oneRes[0]?.score).toBeGreaterThan(0.9);

    // 2. Translated + noisy `木`
    const muMedians = chars[5]?.medians ?? [];
    const muInk = mediansToScreenInk(muMedians, { dx: 40, dy: 25, scale: 0.22, jitter: 4 });
    const muRes = recognizeHandwriting(muInk, [index]);
    expect(muRes[0]?.character).toBe('木');

    // 3. Out-of-order strokes (Hanja learner draws bottom stroke before top stroke of `日`)
    const riMedians = chars[4]?.medians ?? [];
    const [r0 = [], r1 = [], r2 = [], r3 = []] = riMedians;
    const reversedRiInk = mediansToScreenInk([r3, r2, r0, r1]);
    const riRes = recognizeHandwriting(reversedRiInk, [index]);
    expect(riRes.slice(0, 2).map((c) => c.character)).toContain('日');

    // 4. Stroke-count tolerance (±1): drawing `日` missing middle bar still surfaces `日` or `口`
    const partialRiInk = mediansToScreenInk([r0, r1, r3]);
    const partialRes = recognizeHandwriting(partialRiInk, [index], {
      preferredChars: new Set(['日']),
    });
    expect(partialRes.slice(0, 2).map((c) => c.character)).toContain('日');
  });

  it('replays and serializes synced drawing_modes preferences deterministically via HLC LWW', () => {
    const fA = createEventFactory('dev-a', 0, createHlcState('dev-a', 1000));
    const fB = createEventFactory('dev-b', 0, createHlcState('dev-b', 2000));

    const evA = fA.create(
      'PreferencesChanged',
      { preferences: { drawing_modes: { ja: 'lookup', ko: 'graded' } } },
      1000,
    );
    const evB = fB.create(
      'PreferencesChanged',
      { preferences: { drawing_modes: { ja: 'graded' } } },
      2000,
    );

    const st1 = applyEvents(createEmptyState(), [evA, evB]);
    const st2 = applyEvents(createEmptyState(), [evB, evA]);

    expect(st1.preferences.drawing_modes).toEqual({ ja: 'graded', ko: 'graded' });
    expect(st2.preferences.drawing_modes).toEqual(st1.preferences.drawing_modes);

    const roundTrip = deserializeCollectionState(serializeCollectionState(st1, {}));
    expect(roundTrip.preferences.drawing_modes).toEqual({ ja: 'graded', ko: 'graded' });
  });
});
