import { describe, expect, it } from 'vitest';
import { isLeechBackfillReady } from '../src/state/leechBackfillGate.ts';

const LAUNCH = 1_800_000_000_000;

describe('leech backfill gate', () => {
  it('runs at once without a sync provider', () => {
    expect(
      isLeechBackfillReady({ provider: 'none', status: 'disconnected', readOnly: false }, LAUNCH),
    ).toBe(true);
  });

  it('waits on a previously synced device whose stored cursor shows synced at launch', () => {
    // Stale `synced` status from the stored cursor: the remote may hold an add plus a removal.
    expect(
      isLeechBackfillReady(
        {
          provider: 'google_drive',
          status: 'synced',
          readOnly: false,
          lastSyncedAt: LAUNCH - 60_000,
        },
        LAUNCH,
      ),
    ).toBe(false);
  });

  it('waits while idle, syncing, offline or failing', () => {
    for (const status of ['idle', 'syncing', 'offline', 'error', 'reconnect_required'] as const) {
      expect(
        isLeechBackfillReady(
          { provider: 'dropbox', status, readOnly: false, lastSyncedAt: LAUNCH + 5 },
          LAUNCH,
        ),
      ).toBe(false);
    }
  });

  it('runs once a sync completes during this launch', () => {
    expect(
      isLeechBackfillReady(
        { provider: 'google_drive', status: 'synced', readOnly: false, lastSyncedAt: LAUNCH + 1 },
        LAUNCH,
      ),
    ).toBe(true);
  });

  it('never runs on a read-only device', () => {
    expect(
      isLeechBackfillReady({ provider: 'none', status: 'disconnected', readOnly: true }, LAUNCH),
    ).toBe(false);
    expect(
      isLeechBackfillReady(
        { provider: 'google_drive', status: 'synced', readOnly: true, lastSyncedAt: LAUNCH + 1 },
        LAUNCH,
      ),
    ).toBe(false);
  });
});
