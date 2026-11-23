import { listPresetDeckIds, type Deck, type DeckPreset } from '@flash/core';
import {
  buildOptimizedParamsPayload,
  buildTrainingBatch,
  collectOptimizerDataset,
  collectPooledOptimizerDataset,
  estimateRetention,
  getCurrentDeckWeights,
  getOptimizerReadiness,
  normalizeOptimizedWeights,
  resolveFsrs6Weights,
  type OptimizerDataset,
  type RetentionEstimate,
} from '@flash/core/fsrs-optimizer';
import type { FsrsOptimizer, FsrsOptimizerRun, FsrsOptimizerStage } from '@flash/platform';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useDeckOrganization } from '../library/useDeckOrganization.ts';
import { useApp } from '../state/AppContext.tsx';

/**
 * Phase 11 on-device FSRS optimizer for one deck (lazy-loaded from the deck options).
 * Training data and scoring come from `@flash/core/fsrs-optimizer`; the WASM trainer runs in a
 * Web Worker behind `platform.getFsrsOptimizer()`. Applying the result appends one
 * `DeckFSRSParamsChanged` event; nothing is written until the user chooses Apply.
 */

type RunStage = 'preparing' | FsrsOptimizerStage;

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; stage: RunStage }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }
  | {
      kind: 'result';
      weights: number[];
      /** The trainer kept the deck's current weights (e.g. too few distinct cards to learn from). */
      unchanged: boolean;
      before: RetentionEstimate;
      after: RetentionEstimate;
    }
  | { kind: 'applied'; version: number; rescheduled: boolean }
  | { kind: 'applied-preset'; decks: number; rescheduled: boolean };

const STAGES: readonly { stage: RunStage; label: string }[] = [
  { stage: 'preparing', label: 'Preparing review history' },
  { stage: 'loading', label: 'Loading the optimizer' },
  { stage: 'training', label: 'Training weights' },
];

const buttonClass =
  'rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 font-medium hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50';

function percent(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function RunningView({ stage, onCancel }: Readonly<{ stage: RunStage; onCancel: () => void }>) {
  const index = Math.max(
    0,
    STAGES.findIndex((s) => s.stage === stage),
  );
  const label = STAGES[index]?.label ?? '';
  return (
    <div className="flex flex-col gap-2" data-testid="fsrs-optimizer-running">
      <progress
        aria-label="Optimizer progress"
        max={STAGES.length}
        value={index}
        className="h-2 w-full"
      />
      <div className="flex flex-wrap items-center gap-2">
        <output>
          Step {index + 1} of {STAGES.length}: {label}…
        </output>
        <button type="button" onClick={onCancel} className={buttonClass}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function EstimateRow({
  label,
  estimate,
}: Readonly<{ label: string; estimate: RetentionEstimate }>) {
  return (
    <tr>
      <th scope="row" className="py-1 pr-3 text-left font-normal">
        {label}
      </th>
      <td className="py-1 pr-3 tabular-nums">{percent(estimate.predicted_retention)}</td>
      <td className="py-1 tabular-nums">{estimate.log_loss.toFixed(4)}</td>
    </tr>
  );
}

function verdict(before: RetentionEstimate, after: RetentionEstimate, unchanged: boolean): string {
  if (unchanged) {
    return 'The optimizer kept the current weights, so there is nothing to apply. This usually means the history is too uniform to learn from yet, such as many reviews of only a few cards.';
  }
  return after.log_loss < before.log_loss
    ? 'The optimized weights fit your review history better.'
    : 'The optimized weights do not fit your history better than the current ones.';
}

function ResultView({
  before,
  after,
  unchanged,
  onApply,
  onDiscard,
}: Readonly<{
  before: RetentionEstimate;
  after: RetentionEstimate;
  unchanged: boolean;
  onApply: (reschedule: boolean) => void;
  onDiscard: () => void;
}>) {
  const [reschedule, setReschedule] = useState(false);
  return (
    <div className="flex flex-col gap-2" data-testid="fsrs-optimizer-result">
      <p>
        Measured retention over {after.reviews} reviews:{' '}
        <span data-testid="fsrs-optimizer-measured">{percent(after.measured_retention)}</span>
      </p>
      <table className="self-start text-xs" data-testid="fsrs-optimizer-estimate">
        <caption className="sr-only">Retention estimate before and after optimizing</caption>
        <thead>
          <tr className="text-[var(--muted)]">
            <th scope="col" className="pr-3 text-left font-normal">
              Weights
            </th>
            <th scope="col" className="pr-3 text-left font-normal">
              Predicted retention
            </th>
            <th scope="col" className="text-left font-normal">
              Log loss (lower is better)
            </th>
          </tr>
        </thead>
        <tbody>
          <EstimateRow label="Current" estimate={before} />
          <EstimateRow label="Optimized" estimate={after} />
        </tbody>
      </table>
      <p className="text-[var(--muted)]">{verdict(before, after, unchanged)}</p>
      {!unchanged && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={reschedule}
            onChange={(e) => setReschedule(e.target.checked)}
            className="h-4 w-4"
          />
          <span>Reschedule existing cards with the new weights</span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        {!unchanged && (
          <button type="button" onClick={() => onApply(reschedule)} className={buttonClass}>
            Apply weights
          </button>
        )}
        <button type="button" onClick={onDiscard} className={buttonClass}>
          {unchanged ? 'Close' : 'Discard'}
        </button>
      </div>
    </div>
  );
}

function StatusLine({ phase }: Readonly<{ phase: Phase }>) {
  if (phase.kind === 'cancelled') return <output className="block">Optimization cancelled.</output>;
  if (phase.kind === 'error') {
    return (
      <p role="alert" className="text-[var(--danger,#dc2626)]">
        Optimization failed: {phase.message}
      </p>
    );
  }
  if (phase.kind === 'applied-preset') {
    const tail = phase.rescheduled
      ? 'Existing cards were rescheduled.'
      : 'They apply to future reviews; existing due dates are unchanged.';
    return (
      <output className="block">
        Saved the optimized weights on the preset and its {phase.decks} deck(s). {tail}
      </output>
    );
  }
  if (phase.kind === 'applied') {
    const tail = phase.rescheduled
      ? 'Existing cards were rescheduled.'
      : 'They apply to future reviews; existing due dates are unchanged.';
    return (
      <output className="block">
        Saved optimized weights as FSRS parameters v{phase.version}. {tail}
      </output>
    );
  }
  return null;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

interface RunArgs {
  getOptimizer: () => Promise<FsrsOptimizer>;
  dataset: OptimizerDataset;
  currentWeights: number[];
  onStage: (stage: FsrsOptimizerStage) => void;
  onRun: (run: FsrsOptimizerRun) => void;
}

/** One optimizer run, from training batch to before/after estimate. Never throws. */
async function runOptimization(args: RunArgs): Promise<Phase> {
  try {
    const optimizer = await args.getOptimizer();
    const batch = buildTrainingBatch(args.dataset.histories);
    const run = optimizer.optimize(
      {
        ratings: batch.ratings,
        delta_ts: batch.delta_ts,
        lengths: batch.lengths,
        enable_short_term: true,
      },
      { onStage: args.onStage },
    );
    args.onRun(run);
    const weights = normalizeOptimizedWeights(await run.result);
    if (!weights) return { kind: 'error', message: 'the optimizer returned unusable weights.' };
    return {
      kind: 'result',
      weights,
      unchanged: weights.every(
        (w, i) => Math.abs(w - (args.currentWeights[i] ?? Number.NaN)) < 1e-4,
      ),
      before: estimateRetention(args.dataset.histories, args.currentWeights),
      after: estimateRetention(args.dataset.histories, weights),
    };
  } catch (err) {
    if (isAbortError(err)) return { kind: 'cancelled' };
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** One deck, or a preset whose decks' reviews are pooled (deck option presets). */
type OptimizerTarget =
  { deck: Deck; preset?: undefined } | { preset: DeckPreset; deck?: undefined };

export default function FsrsOptimizerPanel({ deck, preset }: Readonly<OptimizerTarget>) {
  const { platform, state, stateVersion, emitEvents, getEventFactory } = useApp();
  const { applyPresetWeights } = useDeckOrganization();
  const targetId = preset ? `preset-${preset.id}` : (deck?.id ?? '');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const runRef = useRef<FsrsOptimizerRun | null>(null);
  // Bumped on every start / cancel / unmount so a stale run can never update the panel.
  const tokenRef = useRef(0);
  const whyId = useId();

  const presetDeckIds = useMemo(
    () => (preset ? listPresetDeckIds(state, preset.id) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion, preset],
  );
  const dataset = useMemo(
    () =>
      preset
        ? collectPooledOptimizerDataset(state, presetDeckIds, `preset:${preset.id}`)
        : collectOptimizerDataset(state, deck?.id ?? ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion, deck?.id, preset, presetDeckIds],
  );
  const readiness = getOptimizerReadiness(dataset);
  const getOptimizer = platform.getFsrsOptimizer;

  useEffect(() => {
    const tokens = tokenRef;
    const runs = runRef;
    return () => {
      tokens.current += 1;
      runs.current?.cancel();
    };
  }, []);

  const start = async () => {
    if (!getOptimizer || !readiness.ready) return;
    tokenRef.current += 1;
    const token = tokenRef.current;
    const isCurrent = () => tokenRef.current === token;
    setPhase({ kind: 'running', stage: 'preparing' });
    const next = await runOptimization({
      getOptimizer,
      dataset,
      currentWeights: preset
        ? resolveFsrs6Weights(preset.w)
        : getCurrentDeckWeights(state, deck?.id ?? '', Date.now()),
      onStage: (stage) => {
        if (isCurrent()) setPhase({ kind: 'running', stage });
      },
      onRun: (run) => {
        if (isCurrent()) runRef.current = run;
        else run.cancel();
      },
    });
    if (!isCurrent()) return;
    runRef.current = null;
    setPhase(next);
  };

  const cancel = () => {
    tokenRef.current += 1;
    runRef.current?.cancel();
    runRef.current = null;
    setPhase({ kind: 'cancelled' });
  };

  const apply = (weights: number[], reschedule: boolean) => {
    if (preset) {
      const decks = applyPresetWeights(preset.id, weights, reschedule);
      setPhase({ kind: 'applied-preset', decks, rescheduled: reschedule });
      return;
    }
    if (!deck) return;
    const nowMs = Date.now();
    const payload = buildOptimizedParamsPayload(state, deck.id, weights, {
      nowMs,
      rescheduleExisting: reschedule,
    });
    emitEvents([getEventFactory().create('DeckFSRSParamsChanged', payload, nowMs)]);
    setPhase({ kind: 'applied', version: payload.params_version, rescheduled: reschedule });
  };

  const available = typeof getOptimizer === 'function';
  const running = phase.kind === 'running';
  const canRun = available && readiness.ready && !running;

  return (
    <section
      aria-label="FSRS optimizer"
      data-testid={`fsrs-optimizer-${targetId}`}
      className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-xs"
    >
      <div className="font-semibold text-[var(--fg)]">FSRS optimizer</div>
      <p className="text-[var(--muted)]">
        {preset
          ? `Fits FSRS weights to the pooled review history of this preset's ${presetDeckIds.length} deck(s), on this device. `
          : "Fits FSRS weights to this deck's review history, on this device. "}
        <span data-testid="fsrs-optimizer-count">{readiness.eligible}</span> eligible reviews
        (minimum {readiness.required}).
      </p>
      {!readiness.ready && (
        <p id={whyId} data-testid="fsrs-optimizer-why">
          Needs at least {readiness.required} eligible reviews ({readiness.missing} more). A review
          counts when it is a later study day than that card&apos;s previous review; first reviews,
          same-day repeats, undone reviews and practice answers do not.
        </p>
      )}
      {!available && <p>The optimizer is not available on this platform.</p>}
      {phase.kind !== 'result' && !running && (
        <div>
          <button
            type="button"
            disabled={!canRun}
            aria-describedby={readiness.ready ? undefined : whyId}
            onClick={() => void start()}
            className={buttonClass}
          >
            Optimize weights
          </button>
        </div>
      )}
      {phase.kind === 'running' && <RunningView stage={phase.stage} onCancel={cancel} />}
      {phase.kind === 'result' && (
        <ResultView
          before={phase.before}
          after={phase.after}
          unchanged={phase.unchanged}
          onApply={(reschedule) => apply(phase.weights, reschedule)}
          onDiscard={() => setPhase({ kind: 'idle' })}
        />
      )}
      <StatusLine phase={phase} />
    </section>
  );
}
