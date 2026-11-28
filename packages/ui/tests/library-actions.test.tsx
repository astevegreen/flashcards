// @vitest-environment happy-dom
import { getEnabledLayoutsForDeck, type FlashEvent, type Layout } from '@flash/core';
import { act } from 'react';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '@flash/core/samples';
import { afterEach, describe, expect, it } from 'vitest';
import { useLibraryActions, type LibraryActions } from '../src/state/libraryActions.ts';
import {
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  must,
  sampleEvents,
  type Mounted,
} from './helpers/app-harness.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function mount() {
  const storage = createMemoryStorage();
  let actions: LibraryActions | undefined;
  function Probe() {
    actions = useLibraryActions();
    return null;
  }
  mounted = await mountWithApp(<Probe />, {
    platform: createTestPlatform(storage),
    initialEvents: sampleEvents(),
  });
  const m = mounted;
  const run = async <T,>(fn: (a: LibraryActions) => T): Promise<T> => {
    let out: T | undefined;
    await act(async () => {
      out = fn(must(actions));
    });
    await flush();
    return out as T;
  };
  const appended = (): FlashEvent[] => storage.appended.flat();
  return { m, run, appended };
}

describe('library actions (off the study chunk, §8)', () => {
  it('createDeck returns the new deck id and the deck is live at once', async () => {
    const { m, run } = await mount();
    const noteTypeId = must([...m.app().state.noteTypes.keys()][0]);
    const deckId = await run((a) => a.createDeck('  Verbs  ', noteTypeId, 'ko'));
    const deck = must(m.app().state.decks.get(deckId));
    expect(deck.name).toBe('Verbs');
    expect(deck.note_type_id).toBe(noteTypeId);
  });

  it('createDeck starts the deck on the Settings card order, written in DeckCreated', async () => {
    const { m, run, appended } = await mount();
    await act(async () => m.app().updatePreferences({ study_order: 'random' }));
    const noteTypeId = must([...m.app().state.noteTypes.keys()][0]);
    const deckId = await run((a) => a.createDeck('Shuffled', noteTypeId, 'ko'));
    expect(m.app().state.decks.get(deckId)?.settings.new_card_order).toBe('random');
    const create = appended().find(
      (e) => e.type === 'DeckCreated' && (e.payload as { deck_id: string }).deck_id === deckId,
    );
    expect(create?.payload).toMatchObject({ settings: { new_card_order: 'random' } });
  });

  it('every batch emitted through the app (samples, starters, imports) gets the order', async () => {
    const { m, appended } = await mount();
    await act(async () => m.app().updatePreferences({ study_order: 'random' }));
    const { buildStarterDeckEvents, loadStarterDeck, STARTER_DECKS } =
      await import('@flash/core/starters');
    const info = must(STARTER_DECKS[0]);
    const content = await loadStarterDeck(info.slug);
    await act(async () => {
      m.app().emitEvents(buildStarterDeckEvents(m.app().getEventFactory(), info, content));
    });
    await flush();
    const creates = appended().filter((e) => e.type === 'DeckCreated');
    expect(creates.at(-1)?.payload).toMatchObject({ settings: { new_card_order: 'random' } });
    // Sample decks already in the collection are left alone when re-emitted.
    const before = appended().length;
    await act(async () => {
      m.app().emitEvents(buildSampleDeckEvents(m.app().getEventFactory(), SAMPLE_SEED_EPOCH_MS));
    });
    await flush();
    const resent = appended()
      .slice(before)
      .filter((e) => e.type === 'DeckCreated');
    expect(resent.length).toBeGreaterThan(0);
    for (const e of resent) {
      expect((e.payload as { settings?: unknown }).settings).toBeUndefined();
    }
  });

  it('upsertPage cleans the slug, keeps a given page id and marks pages read', async () => {
    const { m, run, appended } = await mount();
    const pageId = await run((a) =>
      a.upsertPage({ slug: '  Hello, World!  ', title: '  ', markdown: '# Hi', tags: ['t'] }),
    );
    const page = must(m.app().state.pages.get(pageId));
    expect(page.slug).toBe('hello-world');
    expect(page.title).toBe('hello-world');
    const again = await run((a) =>
      a.upsertPage({ pageId, slug: '!!!', title: 'T', markdown: '', lang: 'ja', tags: [] }),
    );
    expect(again).toBe(pageId);
    expect(m.app().state.pages.get(pageId)?.slug).toBe('page');
    await run((a) => a.markPageRead(pageId));
    expect(appended().some((e) => e.type === 'PageRead')).toBe(true);
  });

  it('toggleDeckLayout adds and removes a layout but never the last one', async () => {
    const { m, run, appended } = await mount();
    const deck = must([...m.app().state.decks.values()][0]);
    const enabled = () =>
      getEnabledLayoutsForDeck(m.app().state, must(m.app().state.decks.get(deck.id))).map(
        (l) => l.id,
      );
    const settingsChanges = () => appended().filter((e) => e.type === 'DeckSettingsChanged');
    // A layout of the deck's note type that the deck doesn't use yet.
    const base = must(getEnabledLayoutsForDeck(m.app().state, deck)[0]);
    await run((a) =>
      a.upsertLayout({ ...base, id: 'layout-extra', name: 'Extra', enabled: false }),
    );
    const before = enabled();
    expect(before).not.toContain('layout-extra');

    await run((a) => a.toggleDeckLayout(deck.id, 'layout-extra'));
    expect(enabled()).toContain('layout-extra');
    expect(enabled()).toHaveLength(before.length + 1);
    await run((a) => a.toggleDeckLayout(deck.id, 'layout-extra'));
    expect(enabled()).toEqual(before);

    // Down to one layout: every other one is removed.
    await run((a) => a.toggleDeckLayout(deck.id, 'layout-extra'));
    const [last, ...rest] = enabled();
    expect(rest.length).toBeGreaterThan(0);
    for (const id of rest) await run((a) => a.toggleDeckLayout(deck.id, id));
    expect(enabled()).toEqual([must(last)]);
    // Toggling the last one off does nothing: no event, still enabled.
    const changes = settingsChanges().length;
    await run((a) => a.toggleDeckLayout(deck.id, must(last)));
    expect(enabled()).toEqual([last]);
    // Unknown deck: nothing happens either.
    await run((a) => a.toggleDeckLayout('no-such-deck', 'layout-extra'));
    expect(settingsChanges()).toHaveLength(changes);
  });

  it('upsertLayout can enable the layout on a deck', async () => {
    const { m, run, appended } = await mount();
    const deck = must([...m.app().state.decks.values()][0]);
    const base = must(getEnabledLayoutsForDeck(m.app().state, deck)[0]);
    const layout: Layout = { ...base, id: 'layout-custom', name: 'Custom' };
    await run((a) => a.upsertLayout(layout, deck.id));
    expect(m.app().state.layouts.get('layout-custom')?.name).toBe('Custom');
    expect(m.app().state.decks.get(deck.id)?.settings.enabled_layout_ids).toContain(
      'layout-custom',
    );
    // A deck that doesn't exist: the layout is saved, no deck changes.
    await run((a) => a.upsertLayout({ ...layout, id: 'layout-other' }, 'no-such-deck'));
    expect(m.app().state.layouts.has('layout-other')).toBe(true);
    const changes = appended().filter((e) => e.type === 'DeckSettingsChanged').length;
    // Already enabled: only the layout itself changes.
    await run((a) => a.upsertLayout({ ...layout, name: 'Renamed' }, deck.id));
    expect(appended().filter((e) => e.type === 'DeckSettingsChanged')).toHaveLength(changes);
    expect(m.app().state.layouts.get('layout-custom')?.name).toBe('Renamed');
  });

  it('rescheduleDeck bumps the params version; upsertCourse records the course', async () => {
    const { m, run, appended } = await mount();
    const deck = must([...m.app().state.decks.values()][0]);
    await run((a) => a.rescheduleDeck(deck.id));
    const ev = appended().find((e) => e.type === 'DeckFSRSParamsChanged');
    expect(ev?.payload).toMatchObject({ deck_id: deck.id, reschedule_existing: true });
    await run((a) => a.rescheduleDeck('no-such-deck'));
    expect(appended().filter((e) => e.type === 'DeckFSRSParamsChanged')).toHaveLength(1);

    await run((a) =>
      a.upsertCourse({
        id: 'course-1',
        title: 'Course',
        lessons: [],
      } as unknown as Parameters<LibraryActions['upsertCourse']>[0]),
    );
    expect(appended().some((e) => e.type === 'CourseChanged')).toBe(true);
  });
});
