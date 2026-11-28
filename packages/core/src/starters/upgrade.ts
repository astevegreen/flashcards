import { getDeckDescription } from '../decks/description.ts';
import type { CollectionState, EventFactory } from '../events/replay.ts';
import type {
  DeckDescriptionChangedPayload,
  KnownEvent,
  StarterDeckUpgradedPayload,
  StarterFieldUpgrade,
  StarterNoteUpgradedPayload,
} from '../events/types.ts';
import { noteFieldRegisterKey } from '../events/starter-upgrades.ts';
import { deriveNoteId } from '../ids.ts';
import { comparePackageVersions, shouldUpgradePackage } from '../sources/package-version.ts';
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
 * - Each note's new text is one `StarterNoteUpgraded` with only the changed fields, each with
 *   the HLC of the field register that held the old text. It never writes a note's deck, source
 *   key or field registers, so it never moves back a note another device moved, and replay shows
 *   it only while no edit the upgrading device had not seen wrote the field: a user's edit, made
 *   offline on another device before the upgrade synced, always wins (`events/starter-upgrades.ts`).
 * - It runs once per release: the deck's release is the newer of its
 *   `DeckCreated.source.package_version` and any `StarterDeckUpgraded` (`starterDeckVersion`),
 *   compared with the catalog's (`shouldUpgradePackage`). The upgrade ends with a
 *   `StarterDeckUpgraded`, a log-retained event that writes no register (a `SourceLinked` would
 *   rewrite the deck's source and could undo another device's unlink). A relaunch, or another
 *   device once it has synced, sees the new release and does nothing. Two devices that upgrade
 *   before syncing write the same values, so they converge.
 *
 * The older texts are rebuilt from the current deck data: the credit formats of 1.0.0 and 1.1.0
 * (`content/starters/README.md`) from `meaningSource`/`meaningEdited`, and the 1.0.0 glosses from
 * the generated `legacy-glosses.ts` table (loaded on demand, like the deck content).
 *
 * The rebuilt values are only right against the release they are written for
 * (`STARTER_UPGRADE_TARGET`). A catalog at any other release gets no upgrade at all, rather than a
 * deck stamped as current while it still shows text this step cannot recognise. To ship the next
 * release: add the outgoing one to `LegacyStarterVersion` with a way to rebuild its values (a
 * formula over the new deck data, or a table the build writes before the data changes, as
 * `legacy-glosses.ts` does for 1.0.0), then set `STARTER_UPGRADE_TARGET` to the new release.
 * `starter-upgrade.test.ts` fails until the target matches the catalog.
 */

/** The `package_id` prefix every seeded starter deck records in its source. */
export const STARTER_PACKAGE_ID_PREFIX = 'flash-starter:';

/** The starter release the rebuilt values below are written against (see the module comment). */
export const STARTER_UPGRADE_TARGET = '1.2.0';

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

/**
 * The release a starter deck's text is at: the newer of the release it was seeded from and every
 * release a `StarterDeckUpgraded` recorded. Undefined for a deck that is not that starter deck.
 */
export function starterDeckVersion(
  state: CollectionState,
  info: StarterDeckInfo,
): string | undefined {
  const deckId = starterDeckId(info.slug);
  const source = state.decks.get(deckId)?.source;
  if (source?.package_id !== `${STARTER_PACKAGE_ID_PREFIX}${info.slug}`) return undefined;
  let version = source.package_version ?? '0';
  for (const ev of state.unknownEvents) {
    if (ev.type !== 'StarterDeckUpgraded') continue;
    const p = ev.payload as Partial<StarterDeckUpgradedPayload> | null;
    if (p?.deck_id !== deckId || typeof p.package_version !== 'string') continue;
    if (comparePackageVersions(p.package_version, version) > 0) version = p.package_version;
  }
  return version;
}

/** Whether this build can bring a deck at `version` up to `info`'s release. */
function canUpgrade(version: string | undefined, info: StarterDeckInfo): boolean {
  return (
    version !== undefined &&
    info.version === STARTER_UPGRADE_TARGET &&
    shouldUpgradePackage(version, info.version)
  );
}

/** Starter decks in the collection that were seeded from an older release than the catalog's. */
export function starterDecksDueForUpgrade(state: CollectionState): StarterDeckInfo[] {
  return STARTER_DECKS.filter((info) => canUpgrade(starterDeckVersion(state, info), info));
}

/** Whether the user ever wrote (or cleared) this deck's description: theirs always wins. */
function hasUserDescription(state: CollectionState, deckId: string): boolean {
  return state.unknownEvents.some((ev) => {
    if (ev.type !== 'DeckDescriptionChanged') return false;
    const p = ev.payload as { deck_id?: unknown; from_package?: unknown } | null;
    return p?.deck_id === deckId && p.from_package !== true;
  });
}

/** What the upgrade writes for one deck (see `buildStarterDeckUpgradeEvents`). */
export interface StarterDeckUpgradePlan {
  deckId: string;
  /** One per note with a field still at an older release's value: only those fields. */
  notes: StarterNoteUpgradedPayload[];
  /**
   * The catalog description (it carries the deck's credits since 1.2.0), when it differs and the
   * user never wrote or cleared one.
   */
  description?: DeckDescriptionChangedPayload;
  /** Records the new release, so the upgrade runs once per release. */
  upgraded: StarterDeckUpgradedPayload;
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
  if (!canUpgrade(starterDeckVersion(state, info), info)) return undefined;
  if (content.slug !== info.slug) throw new Error(`Starter deck content is not "${info.slug}"`);

  const notes: StarterNoteUpgradedPayload[] = [];
  for (const starter of content.notes) {
    // The id never changes, so a note the user moved to another deck is still found. The event
    // names no deck, so the note stays where it is, even after a move that hasn't synced yet.
    const note = state.notes.get(deriveNoteId(deckId, starter.key));
    if (note === undefined) continue;
    const fields: Record<string, StarterFieldUpgrade> = {};
    for (const [field, values] of retiredStarterValues(info.slug, starter, legacyGlosses)) {
      const value = note.fields[field];
      const next = starter.fields[field];
      const base = state.fieldHlcs.get(noteFieldRegisterKey(note.id, field));
      if (value === undefined || next === undefined || base === undefined) continue;
      if (values.has(value)) fields[field] = { value: next, base_hlc: base };
    }
    if (Object.keys(fields).length === 0) continue;
    notes.push({ note_id: note.id, fields });
  }

  const plan: StarterDeckUpgradePlan = {
    deckId,
    notes,
    upgraded: { deck_id: deckId, package_version: info.version },
  };
  // A description the user wrote (or cleared) always wins over a package one, so none is written
  // over it: such an event would only sit in the log.
  const description = info.description.trim();
  if (
    description !== '' &&
    !hasUserDescription(state, deckId) &&
    getDeckDescription(state, deckId) !== description
  ) {
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
  const events = plan.notes.map((payload) =>
    eventFactory.create('StarterNoteUpgraded', payload, nowMs),
  );
  if (plan.description !== undefined) {
    events.push(eventFactory.create('DeckDescriptionChanged', plan.description, nowMs));
  }
  events.push(eventFactory.create('StarterDeckUpgraded', plan.upgraded, nowMs));
  return events;
}

/** The generated 1.0.0 gloss table (its own chunk: only an upgrade loads it). */
export async function loadStarterLegacyGlosses(): Promise<StarterLegacyGlosses> {
  return (await import('./generated/legacy-glosses.ts')).default;
}
