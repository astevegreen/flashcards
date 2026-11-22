/**
 * In-app card text-size preference (Phase 13 accessibility scaling).
 *
 * Device-local display preference (like the dictionary's last-deck memory): a phone and a
 * monitor want different sizes, so it is kept in `localStorage` and never synced as an event.
 * The value is applied as `<html data-card-text="…">`; the CSS in `apps/web/src/styles.css`
 * turns it into the `--card-text-scale` multiplier used by every auto-fit card text class,
 * so changing it costs no React re-render on the study screen.
 */
export type CardTextSize = 's' | 'm' | 'l' | 'xl';

export const CARD_TEXT_SIZES: readonly CardTextSize[] = ['s', 'm', 'l', 'xl'];

export const CARD_TEXT_SIZE_STORAGE_KEY = 'flash:display:cardTextSize';

export function parseCardTextSize(raw: unknown): CardTextSize {
  return raw === 's' || raw === 'l' || raw === 'xl' ? raw : 'm';
}

export function readCardTextSize(): CardTextSize {
  try {
    return parseCardTextSize(globalThis.localStorage?.getItem(CARD_TEXT_SIZE_STORAGE_KEY));
  } catch {
    return 'm';
  }
}

export function applyCardTextSize(size: CardTextSize): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset['cardText'] = size;
}

export function storeCardTextSize(size: CardTextSize): void {
  try {
    globalThis.localStorage?.setItem(CARD_TEXT_SIZE_STORAGE_KEY, size);
  } catch {
    // Storage blocked (private mode, quota): the size still applies for this session.
  }
  applyCardTextSize(size);
}
