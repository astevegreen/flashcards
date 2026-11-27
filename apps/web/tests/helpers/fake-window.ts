import { vi } from 'vitest';

/** The parts of `window` the writer lock uses: capture listeners, reload, IndexedDB. */
export function fakeWindow() {
  const listeners: string[] = [];
  const reload = vi.fn();
  const win = {
    addEventListener: (type: string, _l: unknown, capture?: boolean) => {
      if (capture) listeners.push(type);
    },
    location: { reload },
    indexedDB,
  } as unknown as Window;
  return { win, listeners, reload };
}
