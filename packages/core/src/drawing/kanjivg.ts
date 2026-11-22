import type { HanziStrokeData } from './types.ts';

const KANJIVG_SIZE = 109;
const HANZI_WRITER_SIZE = 1024;
const HANZI_WRITER_Y_OFFSET = 900;

/** Returns the canonical 5-digit lowercase hex stem for a character in KanjiVG (e.g., `食` → `098df`). */
export function charToKanjivgHex(char: string): string {
  const cp = char.codePointAt(0);
  if (cp === undefined) {
    throw new Error('Cannot compute KanjiVG hex for empty character.');
  }
  return cp.toString(16).padStart(5, '0');
}

/**
 * Pure ES2023 SVG path command sampler for KanjiVG stroke centerlines.
 * Supports `M/m`, `L/l`, `H/h`, `V/v`, `C/c`, `S/s`, `Q/q`, `T/t`.
 */
export function sampleSvgPathPoints(d: string, curveSteps = 6): [number, number][] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const pts: [number, number][] = [];
  let i = 0;
  let cmd = '';
  let prevCmd = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastCtrlX = 0;
  let lastCtrlY = 0;

  const hasMoreNumbers = (): boolean => {
    const tok = tokens[i];
    return tok !== undefined && !/^[a-zA-Z]$/.test(tok);
  };
  const num = (): number => {
    const val = Number(tokens[i++]);
    return Number.isFinite(val) ? val : 0;
  };
  const push = (x: number, y: number): void => {
    const prev = pts[pts.length - 1];
    if (prev && Math.hypot(x - prev[0], y - prev[1]) < 0.05) return;
    pts.push([x, y]);
  };

  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok !== undefined && /^[a-zA-Z]$/.test(tok)) {
      cmd = tok;
      i++;
    } else if (!cmd) {
      i++;
      continue;
    }

    switch (cmd) {
      case 'M': {
        cx = num();
        cy = num();
        sx = cx;
        sy = cy;
        push(cx, cy);
        prevCmd = 'M';
        cmd = 'L';
        break;
      }
      case 'm': {
        cx += num();
        cy += num();
        sx = cx;
        sy = cy;
        push(cx, cy);
        prevCmd = 'm';
        cmd = 'l';
        break;
      }
      case 'L': {
        cx = num();
        cy = num();
        push(cx, cy);
        prevCmd = 'L';
        break;
      }
      case 'l': {
        cx += num();
        cy += num();
        push(cx, cy);
        prevCmd = 'l';
        break;
      }
      case 'H': {
        cx = num();
        push(cx, cy);
        prevCmd = 'H';
        break;
      }
      case 'h': {
        cx += num();
        push(cx, cy);
        prevCmd = 'h';
        break;
      }
      case 'V': {
        cy = num();
        push(cx, cy);
        prevCmd = 'V';
        break;
      }
      case 'v': {
        cy += num();
        push(cx, cy);
        prevCmd = 'v';
        break;
      }
      case 'C':
      case 'c': {
        const isRel = cmd === 'c';
        const x1 = (isRel ? cx : 0) + num();
        const y1 = (isRel ? cy : 0) + num();
        const x2 = (isRel ? cx : 0) + num();
        const y2 = (isRel ? cy : 0) + num();
        const x3 = (isRel ? cx : 0) + num();
        const y3 = (isRel ? cy : 0) + num();
        for (let step = 1; step <= curveSteps; step++) {
          const t = step / curveSteps;
          const mt = 1 - t;
          const x = mt ** 3 * cx + 3 * mt ** 2 * t * x1 + 3 * mt * t ** 2 * x2 + t ** 3 * x3;
          const y = mt ** 3 * cy + 3 * mt ** 2 * t * y1 + 3 * mt * t ** 2 * y2 + t ** 3 * y3;
          push(x, y);
        }
        lastCtrlX = x2;
        lastCtrlY = y2;
        cx = x3;
        cy = y3;
        prevCmd = cmd;
        break;
      }
      case 'S':
      case 's': {
        const isRel = cmd === 's';
        const hasPrevCubic =
          prevCmd === 'C' || prevCmd === 'c' || prevCmd === 'S' || prevCmd === 's';
        const x1 = hasPrevCubic ? 2 * cx - lastCtrlX : cx;
        const y1 = hasPrevCubic ? 2 * cy - lastCtrlY : cy;
        const x2 = (isRel ? cx : 0) + num();
        const y2 = (isRel ? cy : 0) + num();
        const x3 = (isRel ? cx : 0) + num();
        const y3 = (isRel ? cy : 0) + num();
        for (let step = 1; step <= curveSteps; step++) {
          const t = step / curveSteps;
          const mt = 1 - t;
          const x = mt ** 3 * cx + 3 * mt ** 2 * t * x1 + 3 * mt * t ** 2 * x2 + t ** 3 * x3;
          const y = mt ** 3 * cy + 3 * mt ** 2 * t * y1 + 3 * mt * t ** 2 * y2 + t ** 3 * y3;
          push(x, y);
        }
        lastCtrlX = x2;
        lastCtrlY = y2;
        cx = x3;
        cy = y3;
        prevCmd = cmd;
        break;
      }
      case 'Q':
      case 'q': {
        const isRel = cmd === 'q';
        const x1 = (isRel ? cx : 0) + num();
        const y1 = (isRel ? cy : 0) + num();
        const x2 = (isRel ? cx : 0) + num();
        const y2 = (isRel ? cy : 0) + num();
        for (let step = 1; step <= curveSteps; step++) {
          const t = step / curveSteps;
          const mt = 1 - t;
          const x = mt * mt * cx + 2 * mt * t * x1 + t * t * x2;
          const y = mt * mt * cy + 2 * mt * t * y1 + t * t * y2;
          push(x, y);
        }
        lastCtrlX = x1;
        lastCtrlY = y1;
        cx = x2;
        cy = y2;
        prevCmd = cmd;
        break;
      }
      case 'T':
      case 't': {
        const isRel = cmd === 't';
        const hasPrevQuad =
          prevCmd === 'Q' || prevCmd === 'q' || prevCmd === 'T' || prevCmd === 't';
        const x1 = hasPrevQuad ? 2 * cx - lastCtrlX : cx;
        const y1 = hasPrevQuad ? 2 * cy - lastCtrlY : cy;
        const x2 = (isRel ? cx : 0) + num();
        const y2 = (isRel ? cy : 0) + num();
        for (let step = 1; step <= curveSteps; step++) {
          const t = step / curveSteps;
          const mt = 1 - t;
          const x = mt * mt * cx + 2 * mt * t * x1 + t * t * x2;
          const y = mt * mt * cy + 2 * mt * t * y1 + t * t * y2;
          push(x, y);
        }
        lastCtrlX = x1;
        lastCtrlY = y1;
        cx = x2;
        cy = y2;
        prevCmd = cmd;
        break;
      }
      case 'Z':
      case 'z': {
        cx = sx;
        cy = sy;
        push(cx, cy);
        prevCmd = cmd;
        cmd = '';
        break;
      }
      default: {
        // Consume any trailing unknown command parameters safely
        if (hasMoreNumbers()) {
          i++;
        } else {
          cmd = '';
        }
        break;
      }
    }
  }

  return pts;
}

/** Builds a closed stroked SVG ribbon polygon around a sampled centerline polyline. */
export function buildStrokeRibbonPath(points: readonly [number, number][], halfWidth = 24): string {
  if (points.length < 2) return '';
  const left: [number, number][] = [];
  const right: [number, number][] = [];

  for (let i = 0; i < points.length; i++) {
    const curr = points[i];
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    if (!curr || !prev || !next) continue;
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * halfWidth;
    const ny = (dx / len) * halfWidth;
    left.push([Math.round(curr[0] + nx), Math.round(curr[1] + ny)]);
    right.push([Math.round(curr[0] - nx), Math.round(curr[1] - ny)]);
  }

  const ring = [...left, ...right.reverse()];
  const first = ring[0];
  if (!first) return '';
  return `M ${first[0]} ${first[1]} ${ring
    .slice(1)
    .map(([x, y]) => `L ${x} ${y}`)
    .join(' ')} Z`;
}

/**
 * Converts a KanjiVG SVG string (109×109 top-down) into Hanzi Writer JSON format
 * (1024×1024 flipped `y' = 900 - y * 1024/109`) per ADR 0001 Spike 0.6.
 */
export function convertKanjivgSvgToHanziWriter(svgText: string): HanziStrokeData {
  // Prefer `<path ... id="kvg:...-sN" ... d="...">` strokes inside the stroke paths group;
  // fall back to all `<path ... d="...">` elements if minimal SVG snippet is supplied.
  const strokeGroupMatch = svgText.match(/<g[^>]*id="kvg:StrokePaths_[^"]*"[^>]*>([\s\S]*?)<\/g>/);
  const scope = strokeGroupMatch?.[1] ?? svgText;
  const pathMatches = [...scope.matchAll(/<path[^>]*\bd="([^"]+)"/g)];
  const scale = HANZI_WRITER_SIZE / KANJIVG_SIZE;

  const strokes: string[] = [];
  const medians: number[][][] = [];

  for (const m of pathMatches) {
    const d = m[1];
    if (!d) continue;
    const rawPts = sampleSvgPathPoints(d);
    if (rawPts.length < 2) continue;
    const hwPts: [number, number][] = rawPts.map(([x, y]) => [
      Math.round(x * scale),
      Math.round(HANZI_WRITER_Y_OFFSET - y * scale),
    ]);
    medians.push(hwPts);
    strokes.push(buildStrokeRibbonPath(hwPts, 24));
  }

  return { strokes, medians };
}

/** Validates that an untrusted JSON object conforms to HanziStrokeData. */
export function isValidHanziStrokeData(raw: unknown): raw is HanziStrokeData {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj['strokes']) || !Array.isArray(obj['medians'])) return false;
  if (obj['strokes'].length === 0 || obj['strokes'].length !== obj['medians'].length) return false;
  for (const s of obj['strokes']) {
    if (typeof s !== 'string' || s.length === 0) return false;
  }
  for (const m of obj['medians']) {
    if (!Array.isArray(m) || m.length < 2) return false;
    for (const pt of m) {
      if (
        !Array.isArray(pt) ||
        pt.length < 2 ||
        typeof pt[0] !== 'number' ||
        typeof pt[1] !== 'number'
      ) {
        return false;
      }
    }
  }
  return true;
}
