import type { PracticeOrder, StudyMethod } from '@flash/core';
import { useId } from 'react';
import { chooseMethod, chooseOrder, type StudyOptionsContext } from './studyOptionsActions.ts';
import { METHOD_LABELS, ORDER_LABELS } from './studyOptionsStore.ts';

const SCHEDULE_ORDERS: readonly PracticeOrder[] = ['deck', 'random'];
const PRACTICE_ORDERS: readonly PracticeOrder[] = ['deck', 'random', 'hardest'];

function Choice({
  group,
  name,
  value,
  label,
  checked,
  onChoose,
}: Readonly<{
  group: string;
  name: string;
  value: string;
  label: string;
  checked: boolean;
  onChoose: () => void;
}>) {
  return (
    <label className="flex items-center gap-2 py-0.5">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        data-testid={`${group}-${value}`}
        onChange={onChoose}
      />
      {label}
    </label>
  );
}

export interface StudyOptionsPanelProps {
  ctx: StudyOptionsContext;
  method: StudyMethod;
  order: PracticeOrder | undefined;
  onDone: () => void;
}

/** The Study options popover body (lazy chunk, §8): method and order radios for this session. */
export function StudyOptionsPanel({
  ctx,
  method,
  order,
  onDone,
}: Readonly<StudyOptionsPanelProps>) {
  const name = useId();
  const orders = method === 'practice' ? PRACTICE_ORDERS : SCHEDULE_ORDERS;
  return (
    <>
      <fieldset className="mb-2">
        <legend className="mb-1 font-semibold">Method (this session)</legend>
        {(['schedule', 'practice'] as const).map((m) => (
          <Choice
            key={m}
            group="study-method"
            name={`${name}-method`}
            value={m}
            label={m === 'practice' ? 'Practice (no schedule changes)' : METHOD_LABELS[m]}
            checked={method === m}
            onChoose={() => chooseMethod(ctx, m)}
          />
        ))}
      </fieldset>
      <fieldset className="mb-2">
        <legend className="mb-1 font-semibold">Order</legend>
        {orders.map((o) => (
          <Choice
            key={o}
            group="study-order"
            name={`${name}-order`}
            value={o}
            label={ORDER_LABELS[o]}
            checked={order === o}
            onChoose={() => chooseOrder(ctx, o)}
          />
        ))}
      </fieldset>
      <p className="mb-2 text-[11px] text-[var(--muted)]">
        Resets when you change deck. Defaults: Settings › Study Preferences.
      </p>
      <button
        type="button"
        data-testid="study-options-done"
        onClick={onDone}
        className="w-full rounded-lg border border-[var(--border)] px-2 py-1 font-semibold hover:bg-[var(--surface-2)]"
      >
        Done
      </button>
    </>
  );
}
