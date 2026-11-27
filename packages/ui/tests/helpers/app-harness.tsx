/**
 * Render harness for UI tests that opt into a DOM with `// @vitest-environment happy-dom`.
 * Mounts components under the real AppProvider with an in-memory Storage, using only React's own
 * `act` (no testing library).
 */
import { createEventFactory, createHlcState, type Card, type FlashEvent } from '@flash/core';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '@flash/core/samples';
import type { DeviceMeta, MediaBlob, PlatformServices, Storage } from '@flash/platform';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { AppProvider, useApp, type AppContextValue } from '../../src/state/AppContext.tsx';

// Tells React that updates are wrapped in act(), so it flushes effects and warns about the rest.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface MemoryStorage extends Storage {
  readonly appended: FlashEvent[][];
  readonly kv: Map<string, unknown>;
  readonly media: Map<string, MediaBlob>;
  /** While set, `appendEvents` rejects with it (storage full, blocked). */
  failAppend: Error | undefined;
}

export function createMemoryStorage(): MemoryStorage {
  const kv = new Map<string, unknown>();
  const media = new Map<string, MediaBlob>();
  const storage: MemoryStorage = {
    appended: [],
    kv,
    media,
    failAppend: undefined,
    appendEvents: async (events) => {
      if (storage.failAppend) throw storage.failAppend;
      storage.appended.push([...events]);
    },
    getAllEvents: async () => storage.appended.flat(),
    getDeviceEventsAfterSeq: async () => [],
    getEventsAfterLocalSeq: async () => ({ events: [], maxLocalSeq: 0 }),
    getMaxLocalSeq: async () => 0,
    getDeviceMeta: async () => undefined,
    setDeviceMeta: async () => {},
    getSyncCursor: async () => undefined,
    setSyncCursor: async () => {},
    getSyncConfig: async () => undefined,
    setSyncConfig: async () => {},
    getLocalSnapshot: async () => undefined,
    setLocalSnapshot: async () => {},
    getKv: async <T = unknown,>(k: string) => kv.get(k) as T | undefined,
    setKv: async (k: string, v: unknown) => {
      kv.set(k, v);
    },
    deleteKv: async (k: string) => {
      kv.delete(k);
    },
    putMedia: async (m: MediaBlob) => {
      media.set(m.hash, m);
    },
    getMedia: async (hash: string) => media.get(hash),
    requestPersistence: async () => true,
    clearAll: async () => {
      kv.clear();
      media.clear();
    },
  };
  return storage;
}

const unavailable = () => Promise.reject(new Error('not available in tests'));

export function createTestPlatform(
  storage: Storage = createMemoryStorage(),
  overrides: Partial<PlatformServices> = {},
): PlatformServices {
  return {
    deviceId: 'test-device',
    deviceLabel: 'Test device',
    isDevMode: false,
    hasDeviceSlug: false,
    storage,
    googleOAuthConfigured: false,
    googlePickerConfigured: false,
    supportsLocalFolderSync: false,
    getGoogleAuth: unavailable,
    createGoogleDriveTransport: unavailable,
    getGooglePicker: unavailable,
    ...overrides,
  } as unknown as PlatformServices;
}

export const testMeta = (): DeviceMeta => ({
  deviceId: 'test-device',
  seq: 0,
  hlc: createHlcState('test-device', 0),
});

/** The built-in sample decks, as another device's events. */
export const sampleEvents = (): FlashEvent[] =>
  buildSampleDeckEvents(
    createEventFactory('seed', 0, createHlcState('seed', SAMPLE_SEED_EPOCH_MS)),
    SAMPLE_SEED_EPOCH_MS,
  );

export interface Mounted {
  container: HTMLElement;
  root: Root;
  /** The latest context value seen by the harness's own `useApp()` consumer. */
  app: () => AppContextValue;
  rerender: (ui: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
}

/** Flushes pending effects, microtasks and lazy imports inside act() (fake timers too). */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * Resolves once the lazy sync controller has attached and its effects (the `online` / `offline`
 * listeners among them) are in place: the shell runs `syncNow` only after the controller attached,
 * and act() flushes that commit's effects. With no provider `syncNow` changes nothing.
 */
export async function whenSyncReady(m: Mounted): Promise<void> {
  await act(async () => {
    await m.app().syncNow();
  });
}

/** Moves fake timers forward by `ms` inside act(). */
export async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

export interface MountOptions {
  platform?: PlatformServices;
  initialEvents?: readonly FlashEvent[];
  /** Receives the app's `whenSaved` (the writer-lock handoff in `apps/web` uses it). */
  exposeWhenSaved?: (whenSaved: () => Promise<void>) => void;
}

/** Mounts `ui` inside AppProvider; `app()` reads the current context value. */
export async function mountWithApp(ui: ReactNode, options: MountOptions = {}): Promise<Mounted> {
  const platform = options.platform ?? createTestPlatform();
  let latest: AppContextValue | undefined;
  function Probe() {
    latest = useApp();
    return null;
  }
  const wrap = (children: ReactNode) => (
    <AppProvider
      platform={platform}
      initialMeta={testMeta()}
      {...(options.initialEvents ? { initialEvents: options.initialEvents } : {})}
      exposeWhenSaved={options.exposeWhenSaved}
    >
      <Probe />
      {children}
    </AppProvider>
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(wrap(ui));
  });
  await flush();
  return {
    container,
    root,
    app: () => {
      if (!latest) throw new Error('AppProvider has not rendered');
      return latest;
    },
    rerender: async (next) => {
      await act(async () => {
        root.render(wrap(next));
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** A card that has never been reviewed. */
export function newCard(m: Mounted): Card {
  for (const card of m.app().state.cards.values()) {
    if (card.schedule.reps === 0 && !card.empty) return card;
  }
  throw new Error('no new card in the sample decks');
}

/** `value`, or a test failure naming `what` when it is missing. */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

/** Sets a controlled input's value the way typing does, so React's onChange fires. */
export async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    must(setValue, 'the value setter').call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
