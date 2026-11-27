// @vitest-environment happy-dom
import type { ReviewRecordedPayload } from '@flash/core';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApp, type SyncUiState } from '../src/state/AppContext.tsx';
import { useSyncState } from '../src/state/syncStateStore.ts';
import {
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  must,
  newCard,
  sampleEvents as seedEvents,
  whenSyncReady,
  type Mounted,
} from './helpers/app-harness.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

async function mount(storage = createMemoryStorage()) {
  mounted = await mountWithApp(null, {
    platform: createTestPlatform(storage),
    initialEvents: seedEvents(),
  });
  return { m: mounted, storage };
}

/** Polls `check` until it passes, flushing React work inside act() between tries. */
const settle = (check: () => void) =>
  vi.waitFor(
    async () => {
      await flush(1);
      check();
    },
    { timeout: 4_000, interval: 10 },
  );

const appendedTypes = (storage: ReturnType<typeof createMemoryStorage>) =>
  storage.appended.flat().map((e) => e.type);

describe('AppContext rateCard / undoLastReview / redoLastUndo (§9 UI state)', () => {
  it('rateCard records the review, schedules the card and pushes an undo entry', async () => {
    const { m, storage } = await mount();
    const card = newCard(m);
    await act(async () => m.app().rateCard(card, 3, 1234.6, { typedAnswer: 'x' }));
    await settle(() => expect(appendedTypes(storage)).toContain('ReviewRecorded'));

    const app = m.app();
    expect(app.undoStack).toHaveLength(1);
    expect(app.redoStack).toHaveLength(0);
    const entry = must(app.undoStack[0]);
    expect(entry).toMatchObject({ cardId: card.id, deckId: card.deck_id });
    expect(entry.review).toMatchObject({
      card_id: card.id,
      rating: 3,
      duration_ms: 1235,
      typed_answer: 'x',
    });
    expect(app.state.cards.get(card.id)?.schedule.reps).toBe(1);
    const recorded = storage.appended.flat().find((e) => e.type === 'ReviewRecorded');
    expect((recorded?.payload as ReviewRecordedPayload).review_id).toBe(entry.reviewId);
  });

  it('stores the events with the meta that counts them when the storage can (D11)', async () => {
    const storage = createMemoryStorage();
    const together: Array<{ types: string[]; seq: number }> = [];
    const setMeta = vi.spyOn(storage, 'setDeviceMeta');
    storage.appendEventsWithMeta = async (events, meta) => {
      together.push({ types: events.map((e) => e.type), seq: meta.seq });
    };
    const { m } = await mount(storage);
    await act(async () => m.app().rateCard(newCard(m), 3, 1000));
    await settle(() => expect(together).toHaveLength(1));

    expect(together[0]?.types).toEqual(['ReviewRecorded']);
    expect(together[0]?.seq).toBe(must(m.app().meta).seq);
    expect(storage.appended).toEqual([]);
    expect(setMeta).not.toHaveBeenCalled();
  });

  it('undoLastReview appends ReviewUndone, restores the schedule and moves the entry to redo', async () => {
    const { m, storage } = await mount();
    const card = newCard(m);
    await act(async () => m.app().rateCard(card, 3, 1000));
    let undone = false;
    await act(async () => {
      undone = m.app().undoLastReview();
    });
    await settle(() => expect(appendedTypes(storage)).toContain('ReviewUndone'));

    expect(undone).toBe(true);
    expect(m.app().state.cards.get(card.id)?.schedule.reps).toBe(0);
    expect(m.app().undoStack).toHaveLength(0);
    expect(m.app().redoStack).toHaveLength(1);
    // Nothing left to undo.
    let again = true;
    await act(async () => {
      again = m.app().undoLastReview();
    });
    expect(again).toBe(false);
  });

  it('undoLastReview refuses an entry outside the deck being studied', async () => {
    const { m } = await mount();
    const card = newCard(m);
    await act(async () => m.app().rateCard(card, 3, 1000));
    await act(async () => m.app().setActiveDeckId('some-other-deck'));
    let undone = true;
    await act(async () => {
      undone = m.app().undoLastReview();
    });
    expect(undone).toBe(false);
    expect(m.app().undoStack).toHaveLength(1);
  });

  it('redoLastUndo records the review again under a new id with its original time', async () => {
    const { m } = await mount();
    const card = newCard(m);
    await act(async () => m.app().rateCard(card, 4, 1000));
    const first = must(m.app().undoStack[0]);
    const dueAfterRate = m.app().state.cards.get(card.id)?.schedule.due;
    await act(async () => void m.app().undoLastReview());
    let redone = false;
    await act(async () => {
      redone = m.app().redoLastUndo();
    });
    await flush();

    expect(redone).toBe(true);
    const app = m.app();
    expect(app.redoStack).toHaveLength(0);
    expect(app.undoStack).toHaveLength(1);
    const again = must(app.undoStack[0]);
    expect(again.reviewId).not.toBe(first.reviewId);
    expect(again.review.reviewed_at).toBe(first.review.reviewed_at);
    expect(again.review.rating).toBe(4);
    expect(app.state.cards.get(card.id)?.schedule.due).toBe(dueAfterRate);
  });

  it('redoLastUndo drops the entry once the card has a newer review', async () => {
    const { m } = await mount();
    const card = newCard(m);
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await act(async () => m.app().rateCard(card, 3, 1000));
    const review = must(m.app().undoStack[0]).review;
    await act(async () => void m.app().undoLastReview());
    // A later answer for the same card, as if synced from another device.
    now.mockReturnValue(t0 + 60_000);
    const f = m.app().getEventFactory();
    const remote = { ...review, review_id: 'remote-review', reviewed_at: t0 + 60_000 };
    await act(async () => m.app().emitEvents([f.create('ReviewRecorded', remote, t0 + 60_000)]));
    expect(m.app().redoStack).toHaveLength(1);
    let redone = true;
    await act(async () => {
      redone = m.app().redoLastUndo();
    });
    expect(redone).toBe(false);
    expect(m.app().redoStack).toHaveLength(0);
  });

  it('a new answer ends the redo history', async () => {
    const { m } = await mount();
    const card = newCard(m);
    await act(async () => m.app().rateCard(card, 3, 1000));
    await act(async () => void m.app().undoLastReview());
    expect(m.app().redoStack).toHaveLength(1);
    await act(async () => m.app().rateCard(must(m.app().state.cards.get(card.id)), 2, 1000));
    expect(m.app().redoStack).toHaveLength(0);
  });

  it('a newer review from elsewhere makes the older undo entry stale', async () => {
    const { m } = await mount();
    const card = newCard(m);
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    await act(async () => m.app().rateCard(card, 3, 1000));
    const f = m.app().getEventFactory();
    const later: ReviewRecordedPayload = {
      ...must(m.app().undoStack[0]).review,
      review_id: 'remote-review',
      reviewed_at: t0 + 60_000,
    };
    await act(async () => m.app().emitEvents([f.create('ReviewRecorded', later, t0 + 60_000)]));
    let undone = true;
    await act(async () => {
      undone = m.app().undoLastReview();
    });
    expect(undone).toBe(false);
    expect(m.app().undoStack).toHaveLength(0);
  });
});

describe('AppContext emitEvents with a failed persist', () => {
  it('keeps the change in memory, flags persistFailed, and retryPersist writes it', async () => {
    const storage = createMemoryStorage();
    const { m } = await mount(storage);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    storage.failAppend = new Error('QuotaExceededError');
    const card = newCard(m);
    await act(async () => m.app().rateCard(card, 3, 1000));
    // The write runs asynchronously; wait for its failure to show rather than for a tick count, which a loaded
    // machine outran.
    await settle(() => expect(m.app().persistFailed).toBe(true));
    // Optimistic: the review stands in this tab.
    expect(m.app().state.cards.get(card.id)?.schedule.reps).toBe(1);
    expect(storage.appended).toHaveLength(0);
    await expect(m.app().whenSaved()).rejects.toBeDefined();

    storage.failAppend = undefined;
    await act(async () => m.app().retryPersist());
    await settle(() => expect(m.app().persistFailed).toBe(false));
    expect(appendedTypes(storage)).toContain('ReviewRecorded');
    await expect(m.app().whenSaved()).resolves.toBeUndefined();
  });
});

describe('P3: a sync tick re-renders only the sync status readers', () => {
  it('re-renders no useApp() consumer, and sync readers only when the state changed', async () => {
    let appRenders = 0;
    let syncRenders = 0;
    let providerRenders = 0;
    let latest: SyncUiState | undefined;
    function AppConsumer() {
      useApp();
      appRenders += 1;
      return null;
    }
    function SyncConsumer() {
      latest = useSyncState();
      syncRenders += 1;
      return null;
    }
    function ProviderConsumer() {
      useSyncState((s) => s.provider);
      providerRenders += 1;
      return null;
    }
    mounted = await mountWithApp(
      <>
        <AppConsumer />
        <SyncConsumer />
        <ProviderConsumer />
      </>,
      { initialEvents: seedEvents() },
    );
    await whenSyncReady(mounted);
    expect(latest?.isOnline).toBe(true);
    const app0 = appRenders;
    const sync0 = syncRenders;
    const provider0 = providerRenders;

    // Already online: the controller's update returns an equal state, kept as the old object.
    await act(async () => void window.dispatchEvent(new Event('online')));
    await flush();
    expect(syncRenders).toBe(sync0);
    expect(appRenders).toBe(app0);

    // Going offline changes the state: its readers render, useApp() consumers still don't.
    await act(async () => void window.dispatchEvent(new Event('offline')));
    await flush();
    expect(latest?.isOnline).toBe(false);
    expect(syncRenders).toBeGreaterThan(sync0);
    expect(appRenders).toBe(app0);
    // A reader of one field skips ticks that leave that field alone.
    expect(providerRenders).toBe(provider0);
  });
});
