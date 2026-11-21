import { describe, expect, it } from 'vitest';
import {
  FOREGROUND_PULL_COOLDOWN_MS,
  IDLE_PUSH_DEBOUNCE_MS,
  isNetworkSyncProvider,
  shouldFlushPendingSync,
  shouldTriggerForegroundPull,
} from '../src/state/useSyncController.ts';

describe('seamless sync trigger policies (§4.2)', () => {
  it('exposes bounded idle debounce and foreground pull cooldown defaults', () => {
    expect(IDLE_PUSH_DEBOUNCE_MS).toBeGreaterThanOrEqual(5_000);
    expect(IDLE_PUSH_DEBOUNCE_MS).toBeLessThanOrEqual(15_000);
    expect(FOREGROUND_PULL_COOLDOWN_MS).toBeGreaterThanOrEqual(10_000);
    expect(FOREGROUND_PULL_COOLDOWN_MS).toBeLessThanOrEqual(30_000);
  });

  it('distinguishes network sync providers from local-only providers', () => {
    expect(isNetworkSyncProvider('google_drive')).toBe(true);
    expect(isNetworkSyncProvider('dev_channel')).toBe(true);
    expect(isNetworkSyncProvider('local_folder')).toBe(false);
    expect(isNetworkSyncProvider('none')).toBe(false);
  });

  describe('shouldFlushPendingSync (idle debounce & study-exit flush)', () => {
    it('flushes when connected online with pending events', () => {
      expect(
        shouldFlushPendingSync({ provider: 'google_drive', pendingCount: 1, isOnline: true }),
      ).toBe(true);
      expect(
        shouldFlushPendingSync({ provider: 'dev_channel', pendingCount: 3, isOnline: true }),
      ).toBe(true);
    });

    it('skips when disconnected or when no pending events exist', () => {
      expect(shouldFlushPendingSync({ provider: 'none', pendingCount: 5, isOnline: true })).toBe(
        false,
      );
      expect(
        shouldFlushPendingSync({ provider: 'google_drive', pendingCount: 0, isOnline: true }),
      ).toBe(false);
    });

    it('defers network providers when offline but still allows local_folder flushes offline', () => {
      expect(
        shouldFlushPendingSync({ provider: 'google_drive', pendingCount: 2, isOnline: false }),
      ).toBe(false);
      expect(
        shouldFlushPendingSync({ provider: 'dev_channel', pendingCount: 2, isOnline: false }),
      ).toBe(false);
      expect(
        shouldFlushPendingSync({ provider: 'local_folder', pendingCount: 2, isOnline: false }),
      ).toBe(true);
    });
  });

  describe('shouldTriggerForegroundPull (visibilitychange -> visible / window.focus)', () => {
    const base = {
      provider: 'google_drive' as const,
      visibilityState: 'visible' as DocumentVisibilityState,
      isOnline: true,
      nowMs: 100_000,
      lastSyncAtMs: 100_000 - FOREGROUND_PULL_COOLDOWN_MS,
      inFlight: false,
    };

    it('pulls once the foreground cooldown has elapsed on a visible tab', () => {
      expect(shouldTriggerForegroundPull(base)).toBe(true);
      expect(shouldTriggerForegroundPull({ ...base, lastSyncAtMs: 0 })).toBe(true);
    });

    it('throttles rapid focus/visibility switches within the cooldown window', () => {
      expect(
        shouldTriggerForegroundPull({
          ...base,
          lastSyncAtMs: base.nowMs - (FOREGROUND_PULL_COOLDOWN_MS - 1),
        }),
      ).toBe(false);
    });

    it('skips when disconnected, hidden, in-flight, or offline on a network provider', () => {
      expect(shouldTriggerForegroundPull({ ...base, provider: 'none' })).toBe(false);
      expect(shouldTriggerForegroundPull({ ...base, visibilityState: 'hidden' })).toBe(false);
      expect(shouldTriggerForegroundPull({ ...base, inFlight: true })).toBe(false);
      expect(shouldTriggerForegroundPull({ ...base, isOnline: false })).toBe(false);
    });

    it('still allows local_folder foreground pulls while offline', () => {
      expect(
        shouldTriggerForegroundPull({
          ...base,
          provider: 'local_folder',
          isOnline: false,
        }),
      ).toBe(true);
    });
  });
});
