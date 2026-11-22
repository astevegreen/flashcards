import type {
  HandwritingCandidate,
  HandwritingRecognizeOptions,
  InkStroke,
  QuantizedStrokeTemplate,
  StrokeLookupIndex,
  StrokeScript,
} from './types.ts';

export const DEFAULT_POINTS_PER_STROKE = 6;
const HANZI_WRITER_Y_OFFSET = 900;

interface Point2D {
  x: number;
  y: number;
}

/** Resamples a polyline to `n` equidistant points along cumulative arc length. */
export function resamplePolyline(
  pts: readonly Point2D[],
  n = DEFAULT_POINTS_PER_STROKE,
): Point2D[] {
  if (pts.length === 0) return [];
  const first = pts[0];
  if (!first) return [];
  if (pts.length === 1 || n <= 1) {
    return Array.from({ length: Math.max(1, n) }, () => ({ x: first.x, y: first.y }));
  }

  const cumLen: number[] = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    if (!prev || !curr) continue;
    total += Math.hypot(curr.x - prev.x, curr.y - prev.y);
    cumLen.push(total);
  }

  if (total < 1e-6) {
    return Array.from({ length: n }, () => ({ x: first.x, y: first.y }));
  }

  const out: Point2D[] = [{ x: first.x, y: first.y }];
  let segIdx = 1;
  for (let k = 1; k < n - 1; k++) {
    const target = (k / (n - 1)) * total;
    while (segIdx < cumLen.length - 1 && (cumLen[segIdx] ?? 0) < target) {
      segIdx++;
    }
    const d0 = cumLen[segIdx - 1] ?? 0;
    const d1 = cumLen[segIdx] ?? d0;
    const p0 = pts[segIdx - 1] ?? first;
    const p1 = pts[segIdx] ?? p0;
    const t = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
    out.push({
      x: p0.x + (p1.x - p0.x) * t,
      y: p0.y + (p1.y - p0.y) * t,
    });
  }
  const last = pts[pts.length - 1] ?? first;
  out.push({ x: last.x, y: last.y });
  return out;
}

/**
 * Normalizes a multi-stroke drawing (screen Y-down coordinates) into a uniform aspect-preserving
 * `[0, 1] × [0, 1]` bounding box, resampled to `pointsPerStroke` points per stroke.
 */
export function normalizeStrokes(
  strokes: readonly (readonly Point2D[])[],
  pointsPerStroke = DEFAULT_POINTS_PER_STROKE,
): Point2D[][] {
  const nonEmpty = strokes.filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const stroke of nonEmpty) {
    for (const p of stroke) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  const width = maxX - minX;
  const height = maxY - minY;
  // Minimum span clamp prevents single straight strokes (e.g. `一` or `丨`) from blowing up noise
  const span = Math.max(width, height, 1e-3);
  const padX = (span - width) / 2;
  const padY = (span - height) / 2;

  return nonEmpty.map((stroke) => {
    const resampled = resamplePolyline(stroke, pointsPerStroke);
    return resampled.map((p) => ({
      x: Math.max(0, Math.min(1, (p.x - minX + padX) / span)),
      y: Math.max(0, Math.min(1, (p.y - minY + padY) / span)),
    }));
  });
}

/**
 * Compiles a compact quantized `StrokeLookupIndex` from Hanzi Writer medians (Y-up coordinate space).
 * Flips median Y (`900 - y`) into canonical screen Y-down space so it aligns directly with Pointer Events ink.
 */
export function buildStrokeLookupIndex(
  script: StrokeScript,
  entries: ReadonlyArray<{ char: string; medians: readonly (readonly (readonly number[])[])[] }>,
  pointsPerStroke = DEFAULT_POINTS_PER_STROKE,
): StrokeLookupIndex {
  const templates: QuantizedStrokeTemplate[] = [];

  for (const item of entries) {
    if (!item.char || item.medians.length === 0) continue;
    const screenStrokes: Point2D[][] = [];
    for (const med of item.medians) {
      const pts: Point2D[] = [];
      for (const pair of med) {
        const x = pair[0];
        const y = pair[1];
        if (typeof x === 'number' && typeof y === 'number') {
          // Flip Hanzi Writer Y-up -> canonical screen Y-down
          pts.push({ x, y: HANZI_WRITER_Y_OFFSET - y });
        }
      }
      if (pts.length > 0) {
        screenStrokes.push(pts);
      }
    }
    if (screenStrokes.length === 0) continue;

    const normalized = normalizeStrokes(screenStrokes, pointsPerStroke);
    const coords: number[] = [];
    for (const stroke of normalized) {
      for (const p of stroke) {
        coords.push(Math.round(p.x * 255), Math.round(p.y * 255));
      }
    }
    templates.push({
      char: item.char,
      strokeCount: normalized.length,
      coords,
    });
  }

  return {
    formatVersion: 1,
    script,
    pointsPerStroke,
    entries: templates,
  };
}

/**
 * Computes distance between one normalized user stroke and one quantized template stroke.
 * Combines pointwise Euclidean distance, endpoint anchor alignment, and stroke-direction cosine penalty.
 */
function strokeDistance(
  userStroke: readonly Point2D[],
  coords: readonly number[],
  strokeOffset: number,
  pointsPerStroke: number,
): number {
  let sumDist = 0;
  for (let p = 0; p < pointsPerStroke; p++) {
    const up = userStroke[p];
    const rx = (coords[strokeOffset + p * 2] ?? 0) / 255;
    const ry = (coords[strokeOffset + p * 2 + 1] ?? 0) / 255;
    if (!up) continue;
    sumDist += Math.hypot(up.x - rx, up.y - ry);
  }
  const meanPointDist = sumDist / pointsPerStroke;

  // Direction cosine penalty (discourages reversed strokes while tolerating slight angle drift)
  const uStart = userStroke[0];
  const uEnd = userStroke[pointsPerStroke - 1];
  const rStartX = (coords[strokeOffset] ?? 0) / 255;
  const rStartY = (coords[strokeOffset + 1] ?? 0) / 255;
  const rEndX = (coords[strokeOffset + (pointsPerStroke - 1) * 2] ?? 0) / 255;
  const rEndY = (coords[strokeOffset + (pointsPerStroke - 1) * 2 + 1] ?? 0) / 255;

  let dirPenalty = 0;
  if (uStart && uEnd) {
    const udx = uEnd.x - uStart.x;
    const udy = uEnd.y - uStart.y;
    const rdx = rEndX - rStartX;
    const rdy = rEndY - rStartY;
    const uLen = Math.hypot(udx, udy);
    const rLen = Math.hypot(rdx, rdy);
    if (uLen > 0.04 && rLen > 0.04) {
      const cosSim = Math.max(-1, Math.min(1, (udx * rdx + udy * rdy) / (uLen * rLen)));
      dirPenalty = 0.28 * ((1 - cosSim) / 2);
    }
  }

  return meanPointDist + dirPenalty;
}

/**
 * Order-tolerant greedy min-weight bipartite stroke matching.
 * Allows Hanja / CJK learners who draw strokes out of canonical order to still get top matches.
 */
function orderTolerantDistance(
  userStrokes: readonly (readonly Point2D[])[],
  template: QuantizedStrokeTemplate,
  pointsPerStroke: number,
): number {
  const k = userStrokes.length;
  const m = template.strokeCount;
  const stride = pointsPerStroke * 2;
  const pairs: Array<{ u: number; r: number; d: number }> = [];

  for (let u = 0; u < k; u++) {
    const us = userStrokes[u];
    if (!us) continue;
    for (let r = 0; r < m; r++) {
      const d = strokeDistance(us, template.coords, r * stride, pointsPerStroke);
      pairs.push({ u, r, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);

  const usedU = new Uint8Array(k);
  const usedR = new Uint8Array(m);
  const targetMatches = Math.min(k, m);
  let matched = 0;
  let totalDist = 0;

  for (const edge of pairs) {
    if (usedU[edge.u] || usedR[edge.r]) continue;
    usedU[edge.u] = 1;
    usedR[edge.r] = 1;
    totalDist += edge.d;
    matched++;
    if (matched >= targetMatches) break;
  }

  const avgMatched = targetMatches > 0 ? totalDist / targetMatches : 1;
  const countDiffPenalty = k === m ? 0 : (0.18 * Math.abs(k - m)) / Math.max(k, m);
  return avgMatched + countDiffPenalty;
}

/**
 * Custom MIT/permissive stroke-matching recognizer over quantized KanjiVG / Make Me a Hanzi templates (§6.4).
 * Runs deterministically in pure ES2023 TypeScript (safe on main thread or inside a Web Worker).
 */
export function recognizeHandwriting(
  rawStrokes: readonly InkStroke[],
  indexes: readonly StrokeLookupIndex[],
  options: HandwritingRecognizeOptions = {},
): HandwritingCandidate[] {
  const nonEmpty = rawStrokes.filter((s) => s.length > 0);
  if (nonEmpty.length === 0 || indexes.length === 0) return [];

  const maxResults = Math.max(1, Math.min(50, options.maxResults ?? 12));
  const k = nonEmpty.length;
  const tol = options.strokeCountTolerance ?? (k <= 4 ? 1 : 2);
  const preferred = options.preferredChars;

  // Cache normalized user strokes per index pointsPerStroke (usually all 6)
  const normCache = new Map<number, Point2D[][]>();
  const bestByChar = new Map<string, HandwritingCandidate>();

  for (const index of indexes) {
    const pps = index.pointsPerStroke || DEFAULT_POINTS_PER_STROKE;
    let userStrokes = normCache.get(pps);
    if (!userStrokes) {
      userStrokes = normalizeStrokes(nonEmpty, pps);
      normCache.set(pps, userStrokes);
    }
    const stride = pps * 2;

    for (const tpl of index.entries) {
      if (Math.abs(tpl.strokeCount - k) > tol) continue;
      if (tpl.coords.length < tpl.strokeCount * stride) continue;

      let dist: number;
      if (tpl.strokeCount === k) {
        let ordSum = 0;
        for (let i = 0; i < k; i++) {
          const us = userStrokes[i];
          if (!us) continue;
          ordSum += strokeDistance(us, tpl.coords, i * stride, pps);
        }
        const dOrd = ordSum / k;
        const dBag = orderTolerantDistance(userStrokes, tpl, pps);
        // Blend ordered + order-tolerant so canonical order wins ties while out-of-order Hanja still matches
        dist = 0.55 * dOrd + 0.45 * dBag;
      } else {
        dist = orderTolerantDistance(userStrokes, tpl, pps);
      }

      let score = Math.exp(-3.2 * dist);
      if (preferred?.has(tpl.char)) {
        score = Math.min(1, score + 0.04);
      }

      const prev = bestByChar.get(tpl.char);
      if (!prev || score > prev.score) {
        bestByChar.set(tpl.char, {
          character: tpl.char,
          score,
          strokeCount: tpl.strokeCount,
        });
      }
    }
  }

  return [...bestByChar.values()]
    .sort((a, b) => b.score - a.score || (a.character < b.character ? -1 : 1))
    .slice(0, maxResults);
}
