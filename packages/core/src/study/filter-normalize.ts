import { compareCodeUnits } from '../compare.ts';
import {
  CARD_STATE_KINDS,
  LEECH_CATEGORY,
  normalizeCategories,
  type CardFilter,
  type CardStateKind,
  type PerformanceCriterion,
} from './filter.ts';

/**
 * Canonical form of an untrusted filter. Only Browse, Stats, Study Sets and custom study use it,
 * so it lives outside `filter.ts`, which the study queue imports on the critical path (§8).
 */

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= 1 ? n : undefined;
}

function normalizeDeckIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = [
    ...new Set(raw.filter((v): v is string => typeof v === 'string' && v.length > 0)),
  ].sort(compareCodeUnits);
  return ids.length > 0 ? ids : undefined;
}

function normalizeStates(raw: unknown): CardStateKind[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const states = CARD_STATE_KINDS.filter((k) => (raw as unknown[]).includes(k));
  return states.length > 0 ? states : undefined;
}

/** Integer performance criteria (>= 1), in canonical key order. */
const POSITIVE_INT_PERFORMANCE_KEYS = [
  'minLapses',
  'minAgainCount',
  'failedWithinDays',
  'hardest',
] as const;

function normalizePerformance(raw: unknown): PerformanceCriterion | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  const next: PerformanceCriterion = {};
  for (const key of POSITIVE_INT_PERFORMANCE_KEYS) {
    const value = positiveInt(p[key]);
    if (value !== undefined) next[key] = value;
  }
  const maxR = p['maxRetrievability'];
  if (typeof maxR === 'number' && Number.isFinite(maxR) && maxR > 0 && maxR <= 1) {
    next.maxRetrievability = maxR;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Sanitizes an untrusted / partially filled filter into canonical form: dedupes and sorts ids
 * and tags, drops empty criteria and invalid numbers. Idempotent; safe for persistence.
 */
export function normalizeCardFilter(raw: unknown): CardFilter {
  const out: CardFilter = {};
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;

  const deckIds = normalizeDeckIds(r['deckIds']);
  if (deckIds) out.deckIds = deckIds;
  const categories = normalizeCategories(r['categories']);
  if (categories) out.categories = categories;
  const states = normalizeStates(r['states']);
  if (states) out.states = states;
  const performance = normalizePerformance(r['performance']);
  if (performance) out.performance = performance;

  return out;
}

/** True when the filter needs per-card data (state / performance / the virtual leech category). */
export function hasCardLevelCriteria(filter: CardFilter): boolean {
  return (
    (filter.states?.length ?? 0) > 0 ||
    (filter.performance !== undefined && Object.keys(filter.performance).length > 0) ||
    (filter.categories?.tags.includes(LEECH_CATEGORY) ?? false)
  );
}
