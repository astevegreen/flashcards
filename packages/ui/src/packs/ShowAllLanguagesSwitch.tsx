import { useSyncExternalStore } from 'react';

/**
 * "Show all languages" for the offline pack manager and the dictionary pack filters (UX #2): by
 * default they list only packs for the languages in use. A per-device convenience, kept in this
 * browser's storage and never synced; default off.
 */
const SHOW_ALL_KEY = 'flash:packs:show-all-languages';

function readShowAll(): boolean {
  try {
    return globalThis.localStorage?.getItem(SHOW_ALL_KEY) === '1';
  } catch {
    return false;
  }
}

function writeShowAll(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(SHOW_ALL_KEY, '1');
    else globalThis.localStorage?.removeItem(SHOW_ALL_KEY);
  } catch {
    // Storage blocked (private mode, quota): the switch still works until reload.
  }
}

/**
 * One shared value for every mounted switch: same-tab instances are told through the listener
 * set, other tabs through the `storage` event. The in-memory value still works when storage is
 * blocked.
 */
let current: boolean | undefined;
const listeners = new Set<() => void>();

function getShowAll(): boolean {
  current ??= readShowAll();
  return current;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== SHOW_ALL_KEY) return;
  current = readShowAll();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) globalThis.removeEventListener?.('storage', onStorage);
  };
}

export function setShowAllLanguages(on: boolean): void {
  current = on;
  writeShowAll(on);
  notify();
}

export function useShowAllLanguages(): [boolean, (on: boolean) => void] {
  const showAll = useSyncExternalStore(subscribe, getShowAll, () => false);
  return [showAll, setShowAllLanguages];
}

export function ShowAllLanguagesSwitch({
  checked,
  onChange,
  hiddenCount,
  testId,
}: Readonly<{
  checked: boolean;
  onChange: (on: boolean) => void;
  /** Packs hidden because their language is not in use (shown as a hint while off). */
  hiddenCount: number;
  testId: string;
}>) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
      <input
        type="checkbox"
        role="switch"
        data-testid={testId}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4"
      />
      <span>Show all languages</span>
      {!checked && hiddenCount > 0 && (
        <span data-testid={`${testId}-hidden`}>({hiddenCount} hidden)</span>
      )}
    </label>
  );
}
