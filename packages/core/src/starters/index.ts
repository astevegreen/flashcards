import type { EventFactory } from '../events/replay.ts';
import type { KnownEvent } from '../events/types.ts';
import { deriveNoteId, FLASH_NAMESPACE_UUID, uuidv5 } from '../ids.ts';
import { STARTER_CATALOG } from './generated/catalog.ts';
import type { StarterDeckContent, StarterDeckInfo } from './types.ts';

export type {
  StarterDeckContent,
  StarterDeckInfo,
  StarterDeckSource,
  StarterNote,
} from './types.ts';

/**
 * Curated onboarding starter decks (Phase 14), built from open data by
 * `scripts/build-starter-decks.mjs`. This module holds only the tiny catalog; each deck's notes
 * are a separate generated module that `loadStarterDeck` imports on demand, so no deck content
 * reaches a bundle until someone picks that deck.
 */
export const STARTER_DECKS: readonly StarterDeckInfo[] = STARTER_CATALOG;

/**
 * Fixed seed time for starter-deck events (like the sample decks): re-seeding the same deck on
 * another device produces the same timestamps, so it never overwrites a user's later edits (LWW).
 */
export const STARTER_SEED_EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

const STARTER_BY_SLUG = new Map(STARTER_DECKS.map((d) => [d.slug, d]));

/** Generated deck modules, by `StarterDeckInfo.module` (static specifiers so bundlers split them). */
const LOADERS = new Map<string, () => Promise<{ default: StarterDeckContent }>>([
  ['ko-core', () => import('./generated/ko-core.ts')],
  ['zh-common', () => import('./generated/zh-common.ts')],
]);

export function findStarterDeck(slug: string): StarterDeckInfo | undefined {
  return STARTER_BY_SLUG.get(slug);
}

/** The deck id a starter deck always gets (deterministic, so re-seeding never duplicates it). */
export function starterDeckId(slug: string): string {
  return uuidv5(FLASH_NAMESPACE_UUID, slug);
}

/** Loads a starter deck's notes. Rejects for an unknown slug or when the chunk can't load. */
export async function loadStarterDeck(slug: string): Promise<StarterDeckContent> {
  const info = STARTER_BY_SLUG.get(slug);
  const loader = info === undefined ? undefined : LOADERS.get(info.module);
  if (loader === undefined) throw new Error(`Unknown starter deck "${slug}"`);
  const content = (await loader()).default;
  if (content.slug !== slug) throw new Error(`Starter deck module mismatch for "${slug}"`);
  return content;
}

/**
 * Seed events for one starter deck: `DeckCreated` (a native deck that records where it came
 * from), `DeckDescriptionChanged` with the catalog description, and one `NoteUpserted` per note, with ids derived from the slug and each note's source key.
 */
export function buildStarterDeckEvents(
  eventFactory: EventFactory,
  info: StarterDeckInfo,
  content: StarterDeckContent,
  nowMs: number = STARTER_SEED_EPOCH_MS,
): KnownEvent[] {
  const deckId = starterDeckId(info.slug);
  const events: KnownEvent[] = [
    eventFactory.create(
      'DeckCreated',
      {
        deck_id: deckId,
        name: info.name,
        note_type_id: info.noteTypeId,
        language: info.language,
        // `native`: nothing ever pulls a starter deck, so it is the user's own deck (Browse can
        // move notes in and out, see `isLinkedDeck`); the other fields only record provenance.
        source: {
          kind: 'native',
          package_id: `flash-starter:${info.slug}`,
          package_version: info.version,
          content_hash: info.contentHash,
          ...(info.sources[0] === undefined ? {} : { uri: info.sources[0].sourceUrl }),
        },
        created_at: nowMs,
      },
      nowMs,
    ),
  ];
  const description = info.description.trim();
  if (description) {
    events.push(
      eventFactory.create(
        'DeckDescriptionChanged',
        { deck_id: deckId, description, from_package: true },
        nowMs,
      ),
    );
  }
  content.notes.forEach((note, i) => {
    events.push(
      eventFactory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(deckId, note.key),
          deck_id: deckId,
          source_key: note.key,
          fields: note.fields,
          tags: note.tags,
          provenance: { source: 'import', reviewed: true },
          created_order: i,
        },
        nowMs,
      ),
    );
  });
  return events;
}
