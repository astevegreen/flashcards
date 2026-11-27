// @vitest-environment happy-dom
// The screens that list or show note fields, on a note type whose field keys are `constructor` and
// `toString` while the notes lack them (S4: noteField). Fixtures: tests/helpers/proto-keys.ts.
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DuplicateFinderPanel } from '../src/browse/DuplicateFinderPanel.tsx';
import { NoteDetailPane } from '../src/browse/NoteDetailPane.tsx';
import { PageViewer } from '../src/pages/PageViewer.tsx';
import { LibraryScreen } from '../src/screens/LibraryScreen.tsx';
import { BrowseScreen } from '../src/screens/BrowseScreen.tsx';
import { act } from 'react';
import {
  createTestPlatform,
  flush,
  mountWithApp,
  type MountOptions,
  type Mounted,
} from './helpers/app-harness.tsx';
import { expectNoProtoLeak, protoEvents, spyConsoleErrors } from './helpers/proto-keys.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Reports an 800 x 800 box as soon as an element is observed (the virtual list needs one). */
class ViewportObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    const box = { inlineSize: 800, blockSize: 800 };
    this.callback(
      [{ target, borderBoxSize: [box], contentBoxSize: [box] } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Mounts the app on the proto collection, then renders `ui(state)` and checks it stays clean. */
async function show(
  ui: (m: Mounted) => ReactNode,
  options: MountOptions = {},
  interact?: (container: HTMLElement) => Promise<void>,
) {
  const errors = spyConsoleErrors();
  mounted = await mountWithApp(null, { initialEvents: protoEvents(), ...options });
  await mounted.rerender(ui(mounted));
  await flush();
  await interact?.(mounted.container);
  expect(errors).not.toHaveBeenCalled();
  expectNoProtoLeak(mounted.container);
  return mounted.container;
}

describe('note types with field keys that exist only on Object.prototype', () => {
  it('Browse rows show empty text, not the inherited function', async () => {
    // The virtualized list renders no rows in a DOM without layout, so give it a viewport.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 800,
      height: 800,
    } as DOMRect);
    vi.stubGlobal('ResizeObserver', ViewportObserver);
    for (const prop of ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth']) {
      vi.spyOn(HTMLElement.prototype, prop as 'offsetHeight', 'get').mockReturnValue(800);
    }
    const container = await show(() => createElement(BrowseScreen));
    expect(container.querySelectorAll('[data-testid^="browse-row"]').length).toBeGreaterThan(0);
  });

  it('the note detail pane shows empty values', async () => {
    const container = await show((m) => {
      const note = m.app().state.notes.get([...m.app().state.notes.keys()][0] ?? '');
      if (!note) throw new Error('no note');
      return createElement(NoteDetailPane, { note, onEdit: () => undefined });
    });
    expect(container.querySelector('[data-testid="browse-detail-headline"]')).not.toBeNull();
  });

  it('the duplicate finder shows an empty secondary text', async () => {
    const container = await show(() =>
      createElement(DuplicateFinderPanel, { onOpen: () => undefined, onClose: () => undefined }),
    );
    expect(container.textContent).toContain('dup');
  });

  it('a page mini-study card shows empty front and back', async () => {
    const container = await show(
      () => {
        const page = {
          id: 'page-proto',
          slug: 'proto',
          title: 'Proto',
          markdown: '::cards{deck="Proto A"}',
          tags: [],
        };
        return createElement(PageViewer, { page, previewMode: true });
      },
      undefined,
      async (root) => {
        // The back is only rendered once the card is flipped.
        await act(async () =>
          root.querySelector<HTMLButtonElement>('[data-testid="directive-cards-flip"]')?.click(),
        );
      },
    );
    expect(container.querySelector('[data-testid="directive-cards"]')).not.toBeNull();
  });

  it('the Library stroke pre-cache counts no characters from them', async () => {
    const provider = {
      getCacheCoverage: vi.fn(async () => ({ cached: 0, total: 5 })),
      precacheCharacters: vi.fn(async () => ({ cached: 0, failed: [] })),
    };
    const platform = createTestPlatform(undefined, {
      getStrokeDataProvider: async () => provider,
    } as never);
    const container = await show(
      () => createElement(LibraryScreen, { onStudyDeck: () => undefined }),
      { platform },
    );
    const row = container.querySelector('[data-testid="deck-row-deck-proto-c"]');
    const options = [...(row?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Options',
    );
    await act(async () => options?.click());
    await flush(20);
    // The coverage effect asks the provider about the deck's characters: none.
    expect(provider.getCacheCoverage).toHaveBeenCalledWith('ja', []);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="precache-deck-strokes-btn"]')
        ?.click(),
    );
    await flush();
    expect(provider.precacheCharacters).toHaveBeenCalledWith('ja', [], expect.anything());
  });
});
