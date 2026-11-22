import { useState } from 'react';
import {
  CARD_TEXT_SIZES,
  readCardTextSize,
  storeCardTextSize,
  type CardTextSize,
} from './cardTextSize.ts';

const LABEL: Record<CardTextSize, string> = { s: 'S', m: 'M', l: 'L', xl: 'XL' };
const NAME: Record<CardTextSize, string> = {
  s: 'Small',
  m: 'Medium',
  l: 'Large',
  xl: 'Extra large',
};

/** Settings → Display: in-app card text size (device-local, Phase 13 accessibility scaling). */
export function CardTextSizeSetting() {
  const [size, setSize] = useState<CardTextSize>(readCardTextSize);

  return (
    <div
      data-testid="display-settings-card"
      className="touch-scope flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <h2 className="text-sm font-semibold">Display</h2>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div>
          <div id="card-text-size-label" className="font-medium">
            Card text size
          </div>
          <div className="text-xs text-[var(--muted)]">
            Scales study card text on this device. Card text also follows your system text size.
          </div>
        </div>
        <div
          role="group"
          aria-labelledby="card-text-size-label"
          className="flex overflow-hidden rounded-xl border border-[var(--border)]"
        >
          {CARD_TEXT_SIZES.map((s) => (
            <button
              key={s}
              type="button"
              data-testid={`card-text-size-${s}`}
              aria-pressed={size === s}
              title={NAME[s]}
              onClick={() => {
                storeCardTextSize(s);
                setSize(s);
              }}
              className={`min-h-11 min-w-11 px-3 text-sm font-semibold ${
                size === s
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg)] text-[var(--fg)] hover:bg-[var(--surface-2)]'
              }`}
            >
              {LABEL[s]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
