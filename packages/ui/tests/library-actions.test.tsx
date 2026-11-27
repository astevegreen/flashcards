// @vitest-environment happy-dom
import { getEnabledLayoutsForDeck, type FlashEvent, type Layout } from '@flash/core';
import { act } from 'react';
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
    const { m, run } = await mount();
    const deck = must([...m.app().state.decks.values()][0]);
    const enabled = () =>
      getEnabledLayoutsForDeck(m.app().state, must(m.app().state.decks.get(deck.id))).map(
        (l) => l.id,
      );
    const layouts = [...m.app().state.layouts.values()].filter(
      (l) => l.note_type_id === deck.note_type_id,
    );
    const before = enabled();
    const extra = layouts.find((l) => !before.includes(l.id));
    if (extra) {
      await run((a) => a.toggleDeckLayout(deck.id, extra.id));
      expect(enabled()).toContain(extra.id);
      await run((a) => a.toggleDeckLayout(deck.id, extra.id));
      expect(enabled()).not.toContain(extra.id);
    }
    // Down to one layout: toggling it off does nothing.
    for (const id of enabled().slice(1)) await run((a) => a.toggleDeckLayout(deck.id, id));
    const last = must(enabled()[0]);
    await run((a) => a.toggleDeckLayout(deck.id, last));
    expect(enabled()).toEqual([last]);
    // Unknown deck: nothing happens.
    await run((a) => a.toggleDeckLayout('no-such-deck', last));
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
