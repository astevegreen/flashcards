import { getDeckDescription } from '../decks/description.ts';
import type { CollectionState, EventFactory } from '../events/replay.ts';
import type {
  DeckDescriptionChangedPayload,
  KnownEvent,
  NoteUpsertedPayload,
  SourceLinkedPayload,
} from '../events/types.ts';
import { deriveNoteId } from '../ids.ts';
import { shouldUpgradePackage } from '../sources/package-version.ts';
import { STARTER_DECKS, starterDeckId } from './index.ts';
import type {
  StarterDeckContent,
  StarterDeckInfo,
  StarterLegacyGlosses,
  StarterNote,
} from './types.ts';

/**
 * The starter-deck upgrade step. Seeding happens once, at onboarding, so a deck seeded from an
 * older starter release keeps that release's generated text: the 1.0.0 glosses (reworded in
 * 1.1.0) and, before 1.2.0, a licence credit in every note's Notes field (credits are deck-level
 * since 1.2.0). This step brings such a deck up to the current release without touching anything
 * the user changed:
 *
 * - A field changes only while it still exactly equals a value an older release generated for
 *   that note (`retiredStarterValues`); an edited field stays as it is.
 * - Each `NoteUpserted` carries only the changed fields (per-field LWW), stamped now, so it merges
 *   with edits other devices make to the note's other fields.
 * - It runs once per deck version: the deck's `DeckCreated.source.package_version` is compared
 *   with the catalog's (`shouldUpgradePackage`), and a `SourceLinked` records the new version on
 *   the deck's source register. A relaunch, or another device once it has synced, sees the
 *   current version and does nothing. Two devices that upgrade before syncing write the same
 *   values, so they converge.
 *
 * The older texts are rebuilt from the current deck data: the credit formats of 1.0.0 and 1.1.0
 * (`content/starters/README.md`) from `meaningSource`/`meaningEdited`, and the 1.0.0 glosses from
 * the generated `legacy-glosses.ts` table (loaded on demand, like the deck content).
 */

/** The `package_id` prefix every seeded starter deck records in its source. */
export const STARTER_PACKAGE_ID_PREFIX = 'flash-starter:';

/** Starter releases whose generated text the upgrade recognises (each rebuilt below). */
export type LegacyStarterVersion = '1.0.0' | '1.1.0';
const LEGACY_VERSIONS: readonly LegacyStarterVersion[] = ['1.0.0', '1.1.0'];

/** The per-note credit an older release put in Notes, by deck slug. */
const LEGACY_CREDITS: Readonly<
  Record<string, (note: StarterNote, credited: { edited: boolean }) => string>
> = {
  'starter-ko-core': (note, { edited }) =>
    `Word list: NIKL 한국어 학습용 어휘 목록 (2003), KOGL Type 1. English: ${note.meaningSource} (CC0)${edited ? ', edited by this app' : ''}.`,
  'starter-zh-common': (note, { edited }) => {
    const also = note.fields['notes'] ?? '';
    return `${also === '' ? '' : `${also} `}Source: Unicode Unihan 17.0.0 (kHanyuPinlu, kMandarin, kDefinition), Unicode License v3${edited ? '; meaning edited by this app' : ''}.`;
  },
};

/**
 * The fields an older starter release seeded `note` with, rebuilt from the current release's
 * note, or undefined for a deck that release did not have. 1.0.0 had no gloss overrides (every
 * meaning was the upstream gloss, and no credit said "edited"); 1.1.0 had today's meanings; both
 * put the credit in Notes (after the Mandarin "Also read: …").
 */
export function legacyStarterFields(
  slug: string,
  note: StarterNote,
  legacyGlosses: StarterLegacyGlosses,
  version: LegacyStarterVersion,
): Record<string, string> | undefined {
  const credit = LEGACY_CREDITS[slug];
  if (credit === undefined) return undefined;
  const edited = note.meaningEdited === true;
  const fields = { ...note.fields };
  if (version === '1.0.0') {
    if (edited) {
      const gloss = legacyGlosses[slug]?.[note.key];
      if (gloss === undefined) return undefined;
      fields['meaning'] = gloss;
    }
    fields['notes'] = credit(note, { edited: false });
  } else {
    fields['notes'] = credit(note, { edited });
  }
  return fields;
}

/**
 * Per field, the values older releases generated for this note that differ from today's: the
 * values the upgrade may replace. Anything else in the field is the user's and is kept.
 */
export function retiredStarterValues(
  slug: string,
  note: StarterNote,
  legacyGlosses: StarterLegacyGlosses,
): Map<string, Set<string>> {
  const retired = new Map<string, Set<string>>();
  for (const version of LEGACY_VERSIONS) {
    const old = legacyStarterFields(slug, note, legacyGlosses, version);
    if (old === undefined) continue;
    for (const [field, value] of Object.entries(old)) {
      if (value === note.fields[field]) continue;
      const set = retired.get(field) ?? new Set<string>();
      set.add(value);
      retired.set(field, set);
    }
  }
  return retired;
}

/** Starter decks in the collection that were seeded from an older release than the catalog's. */
export function starterDecksDueForUpgrade(state: CollectionState): StarterDeckInfo[] {
  return STARTER_DECKS.filter((info) => {
    const source = state.decks.get(starterDeckId(info.slug))?.source;
    return (
      source?.package_id === `${STARTER_PACKAGE_ID_PREFIX}${info.slug}` &&
      shouldUpgradePackage(source.package_version, info.version)
    );
  });
}

/** What the upgrade writes for one deck (see `buildStarterDeckUpgradeEvents`). */
export interface StarterDeckUpgradePlan {
  deckId: string;
  /** One per note with a field still at an older release's value: only those fields. */
  notes: NoteUpsertedPayload[];
  /** The catalog description (it carries the deck's credits since 1.2.0), when it differs. */
  description?: DeckDescriptionChangedPayload;
  /** Records the new version on the deck's source, so the upgrade runs once per version. */
  source: SourceLinkedPayload;
}

/**
 * Plans the upgrade of one starter deck to `info`'s release, or undefined when the deck is not
 * in the collection, is not that starter deck, or is already at (or past) that release.
 */
export function planStarterDeckUpgrade(
  state: CollectionState,
  info: StarterDeckInfo,
  content: StarterDeckContent,
  legacyGlosses: StarterLegacyGlosses,
): StarterDeckUpgradePlan | undefined {
  const deckId = starterDeckId(info.slug);
  const source = state.decks.get(deckId)?.source;
  if (source?.package_id !== `${STARTER_PACKAGE_ID_PREFIX}${info.slug}`) return undefined;
  if (!shouldUpgradePackage(source.package_version, info.version)) return undefined;
  if (content.slug !== info.slug) throw new Error(`Starter deck content is not "${info.slug}"`);

  const notes: NoteUpsertedPayload[] = [];
  for (const starter of content.notes) {
    // The id never changes, so a note the user moved to another deck is still found (and stays
    // in that deck: the payload repeats its current deck and source key).
    const note = state.notes.get(deriveNoteId(deckId, starter.key));
    if (note === undefined) continue;
    const fields: Record<string, string> = {};
    for (const [field, values] of retiredStarterValues(info.slug, starter, legacyGlosses)) {
      const value = note.fields[field];
      const next = starter.fields[field];
      if (value !== undefined && next !== undefined && values.has(value)) fields[field] = next;
    }
    if (Object.keys(fields).length === 0) continue;
    notes.push({ note_id: note.id, deck_id: note.deck_id, source_key: note.source_key, fields });
  }

  const plan: StarterDeckUpgradePlan = {
    deckId,
    notes,
    source: {
      target_kind: 'deck',
      target_id: deckId,
      source: { ...source, package_version: info.version, content_hash: info.contentHash },
    },
  };
  // A description the user wrote (or cleared) always wins over a package one, so this only
  // replaces the older catalog text.
  const description = info.description.trim();
  if (description !== '' && getDeckDescription(state, deckId) !== description) {
    plan.description = { deck_id: deckId, description, from_package: true };
  }
  return plan;
}

/** The plan's events, all stamped `nowMs`: note fields first, the version record last. */
export function buildStarterDeckUpgradeEvents(
  eventFactory: EventFactory,
  plan: StarterDeckUpgradePlan,
  nowMs: number,
): KnownEvent[] {
  const events = plan.notes.map((payload) => eventFactory.create('NoteUpserted', payload, nowMs));
  if (plan.description !== undefined) {
    events.push(eventFactory.create('DeckDescriptionChanged', plan.description, nowMs));
  }
  events.push(eventFactory.create('SourceLinked', plan.source, nowMs));
  return events;
}

/** The generated 1.0.0 gloss table (its own chunk: only an upgrade loads it). */
export async function loadStarterLegacyGlosses(): Promise<StarterLegacyGlosses> {
  return (await import('./generated/legacy-glosses.ts')).default;
}
