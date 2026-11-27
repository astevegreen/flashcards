// @vitest-environment happy-dom
import { createHlcState } from '@flash/core';
import type { DeviceMeta } from '@flash/platform';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WriterSetup } from '../src/writer-lock.ts';

/**
 * `main.tsx` hands `holdWriter` a `booted` promise. A take-over request from another tab is
 * honoured only once it resolves, so every way boot can end must resolve it: the app exposing its
 * persist queue, `boot()` rejecting, and a first render that throws (no effects run then).
 */

interface AppProps {
  exposeWhenSaved?: (whenSaved: () => Promise<void>) => void;
}

const control = vi.hoisted(() => ({
  booted: undefined as Promise<void> | undefined,
  storage: {} as Record<string, unknown>,
  App: (() => null) as (props: AppProps) => null,
}));

vi.mock('@flash/platform-web', () => ({
  resolveDeviceFromUrl: () => ({}),
  createWebPlatform: () => ({ storage: control.storage, hasDeviceSlug: false, deviceId: 'web-t' }),
}));
vi.mock('@flash/ui', () => ({ FlashcardsApp: (props: AppProps) => control.App(props) }));
vi.mock('../src/writer-lock.ts', () => ({
  usableLocks: () => ({ request: () => Promise.resolve() }),
  holdWriter: (s: WriterSetup) => {
    control.booted = s.booted;
    return Promise.resolve();
  },
}));
vi.mock('../src/styles.css', () => ({}));

const meta: DeviceMeta = {
  deviceId: 'web-t',
  seq: 0,
  hlc: createHlcState('web-t', 0),
  seeded: true,
};

function storage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dbName: 'flashcards-db-boot-test',
    getSyncConfig: async () => undefined,
    getSyncCursor: async () => undefined,
    getDeviceMeta: async () => meta,
    setDeviceMeta: async () => undefined,
    getDeviceEventsAfterSeq: async () => [],
    getLocalSnapshot: async () => undefined,
    getAllEvents: async () => [],
    ...overrides,
  };
}

/** Starts `main.tsx` afresh and returns the `booted` promise it gave `holdWriter`. */
async function startMain(): Promise<{ booted: Promise<void> }> {
  vi.resetModules();
  control.booted = undefined;
  await import('../src/main.tsx');
  await vi.waitFor(() => expect(control.booted).toBeDefined());
  // Wrapped: an async function returning the promise itself would wait for it.
  return { booted: control.booted as unknown as Promise<void> };
}

/** Whether `p` resolves within `ms`. */
function resolvesWithin(p: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(r, ms, false))]);
}

let reportError: ReturnType<typeof vi.fn>;
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  reportError = vi.fn();
  vi.stubGlobal('reportError', reportError);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('main.tsx resolves `booted` however boot ends', () => {
  it('when the app exposes its persist queue, and not before', async () => {
    let expose: (() => void) | undefined;
    control.storage = storage();
    control.App = ({ exposeWhenSaved }) => {
      useEffect(() => {
        expose = () => exposeWhenSaved?.(async () => undefined);
      }, [exposeWhenSaved]);
      return null;
    };
    const { booted } = await startMain();
    await vi.waitFor(() => expect(expose).toBeDefined());
    // Rendered, but the persist queue isn't exposed yet: a handoff must still wait.
    expect(await resolvesWithin(booted, 50)).toBe(false);
    expose?.();
    expect(await resolvesWithin(booted, 1000)).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('when the first render throws (no effect runs), and the error is still reported', async () => {
    const crash = new Error('render failed');
    control.storage = storage();
    control.App = () => {
      throw crash;
    };
    const { booted } = await startMain();
    expect(await resolvesWithin(booted, 2000)).toBe(true);
    expect(reportError).toHaveBeenCalledWith(crash);
  });

  it('when boot() rejects, and the rejection is still thrown', async () => {
    const failure = new Error('storage gone');
    control.storage = storage({ getSyncConfig: () => Promise.reject(failure) });
    control.App = () => null;
    // boot()'s rethrow is an unhandled rejection by design; catch it here instead of vitest.
    const others = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    const unhandled = new Promise<unknown>((r) => process.once('unhandledRejection', r));
    try {
      const { booted } = await startMain();
      expect(await resolvesWithin(booted, 1000)).toBe(true);
      expect(await unhandled).toBe(failure);
    } finally {
      process.removeAllListeners('unhandledRejection');
      for (const l of others) process.on('unhandledRejection', l);
    }
  });
});
