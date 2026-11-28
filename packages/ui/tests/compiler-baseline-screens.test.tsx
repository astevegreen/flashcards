// @vitest-environment happy-dom
// LibraryScreen cleared from REACT_COMPILER_BASELINE (#108): the deck-limit drafts and the shell's
// Import / Export request used to be copied into state by effects, and are now copied during the
// render that sees the new value. These pin what the effects did: a limit changed elsewhere refills
// only its own draft, and each new shell request opens the panel on its tab.
import {
  BUILTIN_NOTE_TYPE_IDS,
  createEventFactory,
  createHlcState,
  type FlashEvent,
} from '@flash/core';
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportExportTab } from '../src/library/ImportExportPanel.tsx';
import { LibraryScreen } from '../src/screens/LibraryScreen.tsx';
import { flush, mountWithApp, must, typeInto, type Mounted } from './helpers/app-harness.tsx';

const T0 = Date.UTC(2026, 10, 1);
const DECK_ID = 'limits-deck';

function oneDeck(): FlashEvent[] {
  const f = createEventFactory('other', 0, createHlcState('other', T0));
  return [
    f.create(
      'DeckCreated',
      {
        deck_id: DECK_ID,
        name: 'Limits',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
      },
      T0,
    ),
  ];
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function inputLabelled(m: Mounted, label: string): HTMLInputElement {
  for (const el of m.container.querySelectorAll('label')) {
    if (el.querySelector('span')?.textContent === label) {
      return must(el.querySelector('input'), `the ${label} input`);
    }
  }
  throw new Error(`no input labelled ${label}`);
}

async function click(el: Element | null): Promise<void> {
  await act(async () => {
    must(el, 'element to click').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('LibraryScreen deck-limit drafts follow the deck settings', () => {
  it('refills only the draft whose limit changed, and keeps the others as typed', async () => {
    mounted = await mountWithApp(createElement(LibraryScreen, { onStudyDeck: () => undefined }), {
      initialEvents: oneDeck(),
    });
    const m = mounted;
    const row = await vi.waitFor(async () => {
      await flush(1);
      return must(m.container.querySelector(`[data-testid="deck-row-${DECK_ID}"]`), 'deck row');
    });
    const options = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Options');
    await click(must(options, 'the Options button'));

    const deck = must(m.app().state.decks.get(DECK_ID), 'the deck');
    const newPerDay = () => inputLabelled(m, 'New cards / day');
    const maxRev = () => inputLabelled(m, 'Max reviews / day');
    expect(newPerDay().value).toBe(String(deck.settings.new_cards_per_day));

    // A half-typed review limit (empty, so nothing is committed yet).
    await typeInto(maxRev(), '');
    expect(maxRev().value).toBe('');

    // Another device changes the new-card limit: that draft follows, the typed one stays.
    const next = deck.settings.new_cards_per_day + 7;
    await act(async () => {
      const f = m.app().getEventFactory();
      m.app().emitEvents([
        f.create(
          'DeckSettingsChanged',
          { deck_id: DECK_ID, settings: { new_cards_per_day: next } },
          Date.now(),
        ),
      ]);
    });
    await flush();
    expect(newPerDay().value).toBe(String(next));
    expect(maxRev().value).toBe('');
  });
});

describe('LibraryScreen opens Import / Export for each shell request', () => {
  it('opens on the requested tab at mount and again for a new request after closing', async () => {
    const render = (request: { tab: ImportExportTab; nonce: number }) =>
      createElement(LibraryScreen, { onStudyDeck: () => undefined, initialImportExport: request });
    const first = { tab: 'import' as const, nonce: 1 };
    mounted = await mountWithApp(render(first), { initialEvents: oneDeck() });
    const m = mounted;
    const toggle = () =>
      must(m.container.querySelector('[data-testid="import-export-btn"]'), 'the toggle');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');

    await click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');

    // The same request object again (an unrelated parent render) leaves the panel closed.
    await m.rerender(render(first));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');

    await m.rerender(render({ tab: 'export', nonce: 2 }));
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });
});
