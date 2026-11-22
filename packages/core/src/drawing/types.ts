export type StrokeScript = 'ja' | 'zh-Hans';

/** Hanzi Writer compatible character stroke data (1024x1024 Y-up coordinate space). */
export interface HanziStrokeData {
  strokes: string[];
  medians: number[][][];
  radStrokes?: number[];
}

/** Pointer / stylus sample point in screen Y-down coordinates (Phase 8 ML Kit compatible). */
export interface InkPoint {
  x: number;
  y: number;
  t?: number;
}

export type InkStroke = readonly InkPoint[];

export interface HandwritingCandidate {
  character: string;
  score: number;
  strokeCount: number;
}

export interface HandwritingRecognizeOptions {
  lang?: string;
  maxResults?: number;
  strokeCountTolerance?: number;
  /** Optional priority character set (e.g., education Hanja) given a gentle tie-breaking boost. */
  preferredChars?: ReadonlySet<string>;
}

/**
 * Compact, serializable quantized stroke template entry.
 * Each stroke is resampled to `pointsPerStroke` equidistant Y-down points in `[0, 255]`.
 */
export interface QuantizedStrokeTemplate {
  char: string;
  strokeCount: number;
  /** Flattened `[x0, y0, x1, y1, ...]` Uint8 values (length = strokeCount * pointsPerStroke * 2). */
  coords: number[];
}

export interface StrokeLookupIndex {
  formatVersion: 1;
  script: StrokeScript;
  pointsPerStroke: number;
  entries: QuantizedStrokeTemplate[];
}
