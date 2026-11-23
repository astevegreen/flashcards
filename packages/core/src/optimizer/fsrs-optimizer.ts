import {
  clipFSRS6Parameters,
  FSRS6_MODEL_BOUNDS,
  FSRS6Algorithm,
  migrateFSRS6Parameters,
} from 'ts-fsrs/models/fsrs-6';
import {
  compareReviewRecords,
  getActiveFsrsParamsVersion,
  resolveDeckFsrsConfig,
  type CollectionState,
} from '../events/replay.ts';
import type { DeckFSRSParamsChangedPayload } from '../events/types.ts';
import type { ReviewRating, ReviewRecord } from '../model/types.ts';
import { resolveDayStartHour } from '../study/queue.ts';
import { getStudyDayIndex } from '../fsrs/scheduler.ts';

/**
 * Phase 11 on-device FSRS optimizer — the pure half.
 *
 * The WASM trainer (`fsrs-browser`) and its Web Worker live in `@flash/platform-web`; this module
 * only turns the replayed event log into training data, scores weights against that same data,
 * and builds the `DeckFSRSParamsChanged` payload that records the result.
 *
 * Which reviews count (kept in one place so the UI, tests and any future MCP tool agree):
 * - Only `ReviewRecorded` reviews that were not undone. Practice / cram answers are separate
 *   `PracticeRecorded` events and never reach FSRS, so they are not training data either.
 * - Every card currently in the deck (cards keep their history when notes move between decks).
 * - Reviews are ordered by `(reviewed_at, hlc, review_id)`, exactly like replay.
 * - `delta_t` is the number of study days since the card's previous review, using the review's own
 *   recorded `tz_offset` and the deck's effective day rollover hour (same calendar as the queue
 *   and Stats). Clock skew can never produce a negative gap: it is clamped to 0.
 * - A review is an **eligible** training target when it is not the card's first review and lands
 *   on a later study day than the previous one (`delta_t > 0`). Same-day (learning-step) reviews
 *   stay in the history that precedes a target, but are not targets themselves.
 */

/** Minimum eligible reviews in a deck before the optimizer will run (see module docs). */
export const OPTIMIZER_MIN_REVIEWS = 400;

/** FSRS-6 weight vector length (`ts-fsrs` 6 and `fsrs-browser` 6.x). */
export const FSRS6_WEIGHT_COUNT = 21;

/** Decimal places kept for optimized weights, so events stay compact and stable. */
const WEIGHT_DECIMALS = 4;

export interface OptimizerReview {
  rating: ReviewRating;
  /** Study days since the previous review of the same card (0 for the first review). */
  delta_t: number;
}

export interface OptimizerHistory {
  card_id: string;
  reviews: OptimizerReview[];
}

export interface OptimizerDataset {
  deck_id: string;
  /** One entry per card with at least one active review, in deterministic order. */
  histories: OptimizerHistory[];
  /** Active (not undone) reviews across those cards. */
  review_count: number;
  /** Reviews that are training targets (see module docs). */
  eligible_review_count: number;
}

export interface OptimizerReadiness {
  ready: boolean;
  eligible: number;
  required: number;
  /** Eligible reviews still missing before the optimizer can run (0 when ready). */
  missing: number;
}

/** Flattened `fsrs-browser` `computeParameters` input: one item per eligible review. */
export interface FsrsTrainingBatch {
  ratings: Uint32Array;
  delta_ts: Uint32Array;
  lengths: Uint32Array;
  item_count: number;
}

export interface RetentionEstimate {
  /** Eligible reviews scored. */
  reviews: number;
  /** Share of those reviews that were passed (rating >= 2). */
  measured_retention: number;
  /** Mean predicted probability of recall for those reviews under the weights. */
  predicted_retention: number;
  /** Binary cross-entropy of the predictions (lower is better). */
  log_loss: number;
}

function activeReviewsFor(state: CollectionState, cardId: string): ReviewRecord[] {
  const all = state.reviewsByCard.get(cardId) ?? [];
  return all.filter((r) => !state.undoneReviewIds.has(r.review_id)).sort(compareReviewRecords);
}

function toHistory(cardId: string, reviews: readonly ReviewRecord[], dayStartHour: number) {
  const out: OptimizerReview[] = [];
  let prevDay: number | undefined;
  for (const r of reviews) {
    const day = getStudyDayIndex(r.reviewed_at, r.tz_offset, dayStartHour);
    const deltaT = prevDay === undefined ? 0 : Math.max(0, day - prevDay);
    out.push({ rating: r.rating, delta_t: deltaT });
    prevDay = day;
  }
  return { card_id: cardId, reviews: out };
}

/** Number of eligible training targets in one card history. */
export function countEligibleReviews(reviews: readonly OptimizerReview[]): number {
  let n = 0;
  for (let i = 1; i < reviews.length; i++) {
    if ((reviews[i]?.delta_t ?? 0) > 0) n += 1;
  }
  return n;
}

/**
 * Collects the deck's review histories from the replayed state. Pure and deterministic: the same
 * events (in any delivery order) always yield the same dataset, because cards are ordered by their
 * first active review using the replay comparator.
 */
export function collectOptimizerDataset(state: CollectionState, deckId: string): OptimizerDataset {
  return collectPooledOptimizerDataset(state, [deckId], deckId);
}

/**
 * Pools the review histories of several decks (a deck option preset's decks) into one dataset.
 * Each card keeps its own deck's day rollover; cards are ordered across all decks by their first
 * active review, so the result does not depend on the order of `deckIds`. `datasetId` becomes
 * the dataset's `deck_id`.
 */
export function collectPooledOptimizerDataset(
  state: CollectionState,
  deckIds: readonly string[],
  datasetId: string,
): OptimizerDataset {
  const perCard: { cardId: string; reviews: ReviewRecord[]; dayStartHour: number }[] = [];
  for (const deckId of new Set(deckIds)) {
    const deck = state.decks.get(deckId);
    const dayStartHour = resolveDayStartHour(
      deck?.settings.day_start_hour,
      state.preferences.day_start_hour,
    );
    for (const cardId of state.cardIdsByDeck.get(deckId) ?? []) {
      const reviews = activeReviewsFor(state, cardId);
      if (reviews.length > 0) perCard.push({ cardId, reviews, dayStartHour });
    }
  }
  perCard.sort((a, b) => {
    const [ra] = a.reviews;
    const [rb] = b.reviews;
    return (ra && rb ? compareReviewRecords(ra, rb) : 0) || (a.cardId < b.cardId ? -1 : 1);
  });

  const histories: OptimizerHistory[] = [];
  let reviewCount = 0;
  let eligible = 0;
  for (const { cardId, reviews, dayStartHour } of perCard) {
    const history = toHistory(cardId, reviews, dayStartHour);
    histories.push(history);
    reviewCount += reviews.length;
    eligible += countEligibleReviews(history.reviews);
  }
  return {
    deck_id: datasetId,
    histories,
    review_count: reviewCount,
    eligible_review_count: eligible,
  };
}

export function getOptimizerReadiness(
  dataset: Pick<OptimizerDataset, 'eligible_review_count'>,
  required: number = OPTIMIZER_MIN_REVIEWS,
): OptimizerReadiness {
  const eligible = dataset.eligible_review_count;
  const missing = Math.max(0, required - eligible);
  return { ready: missing === 0, eligible, required, missing };
}

/**
 * Builds the `fsrs-browser` training input: for every eligible review, one item holding the
 * card's reviews up to and including that review (the last entry is the training target).
 */
export function buildTrainingBatch(histories: readonly OptimizerHistory[]): FsrsTrainingBatch {
  let total = 0;
  let items = 0;
  for (const h of histories) {
    for (let i = 1; i < h.reviews.length; i++) {
      if ((h.reviews[i]?.delta_t ?? 0) > 0) {
        total += i + 1;
        items += 1;
      }
    }
  }
  const ratings = new Uint32Array(total);
  const deltaTs = new Uint32Array(total);
  const lengths = new Uint32Array(items);
  let offset = 0;
  let item = 0;
  for (const h of histories) {
    for (let i = 1; i < h.reviews.length; i++) {
      if ((h.reviews[i]?.delta_t ?? 0) <= 0) continue;
      for (let j = 0; j <= i; j++) {
        const r = h.reviews[j];
        ratings[offset] = r?.rating ?? 0;
        deltaTs[offset] = r?.delta_t ?? 0;
        offset += 1;
      }
      lengths[item] = i + 1;
      item += 1;
    }
  }
  return { ratings, delta_ts: deltaTs, lengths, item_count: items };
}

function roundWeight(x: number): number {
  const f = 10 ** WEIGHT_DECIMALS;
  return Math.round(x * f) / f;
}

/**
 * Validates raw optimizer output and returns weights safe to store in an event: exactly
 * {@link FSRS6_WEIGHT_COUNT} finite numbers, rounded, then clipped to the FSRS-6 bounds that
 * `ts-fsrs` enforces. Returns `null` for anything else (wrong model, NaN, empty).
 */
export function normalizeOptimizedWeights(raw: ArrayLike<number>): number[] | null {
  if (raw.length !== FSRS6_WEIGHT_COUNT) return null;
  const values = Array.from(raw);
  if (!values.every((x) => Number.isFinite(x))) return null;
  return clipFSRS6Parameters(values.map(roundWeight));
}

/** The FSRS-6 weights the deck schedules new reviews with right now (defaults when unset). */
export function getCurrentDeckWeights(
  state: CollectionState,
  deckId: string,
  nowMs: number,
): number[] {
  const config = resolveDeckFsrsConfig(state, deckId, nowMs);
  return migrateFSRS6Parameters(config.w ? Array.from(config.w) : undefined);
}

const PROB_EPSILON = 1e-6;

/**
 * Scores weights against the eligible reviews of a dataset: replays each card's memory state
 * with the FSRS-6 model and compares the predicted probability of recall at every eligible
 * review with what actually happened. Used for the before/after retention estimate.
 */
export function estimateRetention(
  histories: readonly OptimizerHistory[],
  weights: readonly number[],
  enableShortTerm = true,
): RetentionEstimate {
  const algorithm = new FSRS6Algorithm(
    migrateFSRS6Parameters(Array.from(weights)),
    enableShortTerm,
    FSRS6_MODEL_BOUNDS,
  );
  let n = 0;
  let passed = 0;
  let predicted = 0;
  let loss = 0;
  for (const h of histories) {
    let memory: { stability: number; difficulty: number } | null = null;
    for (const r of h.reviews) {
      // `memory` is null only before the card's first review, so this skips that review.
      if (memory && r.delta_t > 0) {
        const p = Math.min(
          1 - PROB_EPSILON,
          Math.max(PROB_EPSILON, algorithm.forgetting_curve(r.delta_t, memory.stability)),
        );
        const y = r.rating >= 2 ? 1 : 0;
        n += 1;
        passed += y;
        predicted += p;
        loss -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
      }
      memory = algorithm.next_state(memory, r.delta_t, r.rating);
    }
  }
  if (n === 0) {
    return { reviews: 0, measured_retention: 0, predicted_retention: 0, log_loss: 0 };
  }
  return {
    reviews: n,
    measured_retention: passed / n,
    predicted_retention: predicted / n,
    log_loss: loss / n,
  };
}

export interface OptimizedParamsOptions {
  nowMs: number;
  /** Re-apply the new weights to every past review of the deck (§4.1 explicit reschedule). */
  rescheduleExisting: boolean;
}

/**
 * Builds the `DeckFSRSParamsChanged` payload for optimized weights. The new version keeps the
 * deck's current target retention and other params and swaps in `weights`. Applying it is an
 * ordinary event append, so replay stays the single source of truth: with `reschedule_existing`
 * every older review is re-run under these weights, deterministically and in any delivery order.
 */
export function buildOptimizedParamsPayload(
  state: CollectionState,
  deckId: string,
  weights: readonly number[],
  options: OptimizedParamsOptions,
): DeckFSRSParamsChangedPayload {
  const deck = state.decks.get(deckId);
  const current = resolveDeckFsrsConfig(state, deckId, options.nowMs);
  const payload: DeckFSRSParamsChangedPayload = {
    deck_id: deckId,
    params_version: getActiveFsrsParamsVersion(state, deckId) + 1,
    effective_from: options.nowMs,
    params: {
      ...current,
      request_retention: deck?.settings.target_retention ?? current.request_retention,
      w: [...weights],
    },
  };
  if (options.rescheduleExisting) payload.reschedule_existing = true;
  return payload;
}

/** FSRS-6 weights for a stored weight vector (defaults when absent), e.g. a deck preset's. */
export function resolveFsrs6Weights(w: readonly number[] | undefined): number[] {
  return migrateFSRS6Parameters(w ? Array.from(w) : undefined);
}
