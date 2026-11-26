// @vitest-environment happy-dom
// S6: the "For other apps" box on both CSV exports asks for the guarded copy (`stripRichText`).
import * as csv from '@flash/core/csv';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BulkEditBar } from '../src/browse/BulkEditBar.tsx';
import { CategoryExportPanel } from '../src/library/CategoryExportPanel.tsx';
import {
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  must,
  sampleEvents,
  type Mounted,
} from './helpers/app-harness.tsx';

vi.mock('@flash/core/csv', async (importOriginal) => {
  const original = await importOriginal<typeof csv>();
  return { ...original, exportCsv: vi.fn(original.exportCsv) };
});

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.mocked(csv.exportCsv).mockClear();
});

function platformWithDownloads() {
  const downloadFile = vi.fn(async () => {});
  const platform = createTestPlatform(createMemoryStorage(), {
    files: { downloadFile } as never,
  });
  return { platform, downloadFile };
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

function lastOptions() {
  return vi.mocked(csv.exportCsv).mock.lastCall?.[1];
}

describe('CSV export for other apps (S6)', () => {
  it('Browse bulk bar: off keeps the round-trip CSV, on strips and guards it', async () => {
    const { platform, downloadFile } = platformWithDownloads();
    const events = sampleEvents();
    mounted = await mountWithApp(<span />, { platform, initialEvents: events });
    const state = mounted.app().state;
    const deckId = must([...state.decks.values()][0], 'a deck').id;
    const noteIds = [...state.notes.values()].filter((n) => n.deck_id === deckId).map((n) => n.id);
    await mounted.rerender(
      <BulkEditBar noteIds={noteIds} showingArchived={false} onClear={() => {}} />,
    );

    const exportButton = must(mounted.container.querySelector('[data-testid="bulk-export-csv"]'));
    await click(exportButton);
    expect(lastOptions()?.stripRichText).toBeUndefined();

    const anki = must(
      mounted.container.querySelector<HTMLInputElement>('[data-testid="bulk-export-for-anki"]'),
    );
    const other = must(
      mounted.container.querySelector<HTMLInputElement>(
        '[data-testid="bulk-export-for-other-apps"]',
      ),
    );
    await click(anki);
    expect(anki.checked).toBe(true);
    await click(other);
    expect(other.checked).toBe(true);
    expect(anki.checked).toBe(false);

    await click(exportButton);
    expect(lastOptions()?.stripRichText).toBe(true);
    expect(downloadFile).toHaveBeenCalledTimes(2);

    await click(anki);
    expect(other.checked).toBe(false);
  });

  it('category export: the box turns on the guarded CSV', async () => {
    const { platform, downloadFile } = platformWithDownloads();
    mounted = await mountWithApp(<span />, { platform, initialEvents: sampleEvents() });
    await mounted.rerender(
      <CategoryExportPanel
        collectMediaBlobs={async () => new Map()}
        onStatus={() => {}}
        onError={(m) => {
          throw new Error(m);
        }}
      />,
    );
    const select = must(
      mounted.container.querySelector<HTMLSelectElement>('[data-testid="category-export-tag"]'),
    );
    const firstTag = must(select.options[1], 'a sample tag').value;
    await act(async () => {
      select.value = firstTag;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    const deckSelect = must(
      mounted.container.querySelector<HTMLSelectElement>('[data-testid="category-export-deck"]'),
    );
    const firstDeck = must(deckSelect.options[1], 'a deck with the tag').value;
    await act(async () => {
      deckSelect.value = firstDeck;
      deckSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const exportButton = must(
      mounted.container.querySelector('[data-testid="category-export-csv"]'),
    );
    await click(exportButton);
    expect(lastOptions()?.stripRichText).toBeUndefined();

    await click(
      must(mounted.container.querySelector('[data-testid="category-export-for-other-apps"]')),
    );
    await click(exportButton);
    expect(lastOptions()?.stripRichText).toBe(true);
    expect(downloadFile).toHaveBeenCalledTimes(2);
  });
});
