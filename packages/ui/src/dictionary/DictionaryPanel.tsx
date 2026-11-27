import {
  BUILTIN_NOTE_TYPE_IDS,
  compareCodeUnits,
  deriveNoteId,
  stripRichText,
  stripRuby,
  type Deck,
  type Note,
  type NoteType,
} from '@flash/core';
import { canCreateOrImportDeck } from '@flash/core/license';
import type {
  DictionaryEntry,
  DictionaryPackId,
  DictionaryService,
  InstalledPackInfo,
} from '@flash/platform';
import type {
  DictionaryBrowseSummary,
  DictionaryDirection,
  DictionaryLevel,
  DictionaryRelationType,
  DictionarySense,
  DictionarySenseSource,
} from '@flash/core/dictionary';
import { Fragment, useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { RichText } from '../components/RichText.tsx';
import { DrawLookupPanel } from '../drawing/DrawLookupPanel.tsx';
import { useApp } from '../state/AppContext.tsx';
import { useLibraryActions } from '../state/libraryActions.ts';
import {
  drawToolsVisible,
  useDrawScripts,
  type DrawScriptLang,
} from '../drawing/useDrawScripts.ts';
import { ShowAllLanguagesSwitch } from '../packs/ShowAllLanguagesSwitch.tsx';
import { homeSummariesFor, searchPackIds, useVisiblePacks } from './useVisiblePacks.ts';
import { DictionaryBrowseHeader, DictionaryHome } from './DictionaryHome.tsx';
import {
  createLatestSearch,
  directionTargetName,
  pushRecentLookup,
  readLookupDirection,
  readRecentLookups,
  writeLookupDirection,
  writeRecentLookups,
  type DictionaryBrowseSelection,
} from './dictionary-home-model.ts';
import {
  SENSE_SOURCE_ATTRIBUTION,
  SENSE_SOURCE_CLASS,
  SENSE_SOURCE_LABEL,
} from './sense-source.ts';

export interface DictionaryPanelProps {
  initialQuery?: string;
  initialDrawOpen?: boolean;
  onOpenSettings?: () => void;
}

const PACK_SHORT_LABEL: Record<DictionaryPackId, string> = {
  'dict-hanja-unihan': 'Hanja',
  'dict-kanjidic2': 'Kanji',
  'dict-cc-cedict': 'Chinese',
  'dict-jmdict': 'Japanese',
  'dict-krdict': 'Korean',
  'dict-urimalsam': '우리말샘',
  'dict-kaikki-ko': 'Wiktionary',
};

function isKoreanWordPack(packId: DictionaryPackId): boolean {
  return packId === 'dict-krdict' || packId === 'dict-urimalsam' || packId === 'dict-kaikki-ko';
}

const LEVEL_LABEL: Record<DictionaryLevel, string> = {
  beginner: 'Beginner · 초급',
  intermediate: 'Intermediate · 중급',
  advanced: 'Advanced · 고급',
};

const LEVEL_CLASS: Record<DictionaryLevel, string> = {
  beginner: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  intermediate: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  advanced: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};

/** Single Han ideographs go through character lookup; everything else (Hangul, 초성, romanization, English) through search. */
function isSingleIdeograph(text: string): boolean {
  const chars = [...text];
  if (chars.length !== 1) return false;
  const cp = chars[0]?.codePointAt(0) ?? 0;
  return (cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || cp >= 0x20000;
}

const PACK_LANG: Record<DictionaryPackId, string> = {
  'dict-hanja-unihan': 'ko',
  'dict-kanjidic2': 'ja',
  'dict-cc-cedict': 'zh-Hans',
  'dict-jmdict': 'ja',
  'dict-krdict': 'ko',
  'dict-urimalsam': 'ko',
  'dict-kaikki-ko': 'ko',
};

/** `Radical: 水 · Strokes: 4 · grade` notes for character entries. */
function entryMetaNotes(entry: DictionaryEntry): string {
  const parts: string[] = [];
  if (entry.radical) parts.push(`Radical: ${entry.radical}`);
  if (entry.strokeCount) parts.push(`Strokes: ${entry.strokeCount}`);
  if (entry.grade) parts.push(entry.grade);
  return parts.join(' · ');
}

/** Korean word packs (KRDict) → Korean vocabulary note type: word / Hanja / meaning / example / notes. */
function koreanWordNoteFields(
  entry: DictionaryEntry,
  keys: ReadonlySet<string>,
): Record<string, string> {
  const firstExample = entry.senses?.find((s) => s.examples?.length)?.examples?.[0]?.text ?? '';
  const notes = [
    entry.pos?.join(', '),
    entry.level ? LEVEL_LABEL[entry.level] : undefined,
    entry.readings.length > 0 ? `[${entry.readings.join(', ')}]` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    word: entry.headword,
    hanja: entry.altForms?.[0] ?? '',
    meaning: entry.meanings.slice(0, 3).join('; '),
    ...(keys.has('example') ? { example: firstExample } : {}),
    notes,
  };
}

/** Texts shared by the note-field shapes below. */
interface EntryNoteTexts {
  meaning: string;
  reading: string;
  eumhun: string;
  metaNotes: string;
}

/** Built-in note-type field shapes, first match wins: required field keys → field values. */
const NOTE_FIELD_SHAPES: ReadonlyArray<{
  keys: readonly string[];
  build: (entry: DictionaryEntry, t: EntryNoteTexts) => Record<string, string>;
}> = [
  {
    keys: ['character', 'eumhun'],
    build: (entry, t) => ({
      character: entry.headword,
      eumhun: t.eumhun,
      meaning: t.meaning,
      notes: t.metaNotes,
    }),
  },
  {
    keys: ['word', 'hanja'],
    build: (entry, t) => ({
      word: entry.eumhun?.[0] ? `${entry.eumhun[0]} (${entry.headword})` : entry.headword,
      hanja: t.eumhun ? `${entry.headword} · ${t.eumhun}` : entry.headword,
      meaning: t.meaning,
      notes: t.metaNotes,
    }),
  },
  {
    keys: ['word', 'reading'],
    build: (entry, t) => ({
      word: entry.headword,
      reading: t.reading,
      meaning: t.meaning,
      notes: t.metaNotes,
    }),
  },
  {
    keys: ['sentence', 'translation'],
    build: (entry, t) => ({
      sentence: entry.headword,
      reading: t.reading,
      translation: t.meaning,
      notes: t.metaNotes,
    }),
  },
];

function mapEntryToNoteFields(
  entry: DictionaryEntry,
  noteType: NoteType | undefined,
): Record<string, string> {
  const keys = new Set((noteType?.fields ?? []).map((f) => f.key));
  if (isKoreanWordPack(entry.packId) && keys.has('word') && keys.has('hanja')) {
    return koreanWordNoteFields(entry, keys);
  }

  const meaningText = entry.meanings.join('; ');
  const readingText = entry.readings.join(', ');
  const shape = NOTE_FIELD_SHAPES.find((s) => s.keys.every((k) => keys.has(k)));
  if (shape) {
    return shape.build(entry, {
      meaning: meaningText,
      reading: readingText,
      eumhun: entry.eumhun?.join(', ') || readingText,
      metaNotes: entryMetaNotes(entry),
    });
  }
  const firstKey = noteType?.fields[0]?.key ?? 'word';
  const secondKey = noteType?.fields[1]?.key ?? 'meaning';
  return {
    [firstKey]: entry.headword,
    [secondKey]: meaningText || readingText,
  };
}

function defaultDeckSpecForPack(packId: DictionaryPackId): {
  name: string;
  noteTypeId: string;
  language: string;
} {
  switch (packId) {
    case 'dict-hanja-unihan':
      return { name: 'Hanja Study Deck', noteTypeId: BUILTIN_NOTE_TYPE_IDS.HANJA, language: 'ko' };
    case 'dict-cc-cedict':
      return {
        name: 'Chinese Vocabulary',
        noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_ZH,
        language: 'zh-Hans',
      };
    case 'dict-krdict':
    case 'dict-urimalsam':
    case 'dict-kaikki-ko':
      return {
        name: 'Korean Vocabulary',
        noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
      };
    case 'dict-kanjidic2':
    case 'dict-jmdict':
      return {
        name: 'Japanese Vocabulary',
        noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_JA,
        language: 'ja',
      };
  }
}

/**
 * Standalone comprehensive offline dictionary & Draw-to-Lookup panel (§6.3, §6.4).
 * - Standard native `<form>` + `<input type="search">` compatible with Android/iOS keyboard dictation & IMEs.
 * - Supports bidirectional native (English) ↔ target language lookup independent of installed decks.
 * - Quick 1–2 tap "+ Add to Deck" with per-language last-deck memory and duplicate detection.
 */
const LAST_DECK_STORAGE_KEY = 'flash:dictionary:lastDeckByLang';

function readRememberedDecks(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_DECK_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeRememberedDecks(value: Record<string, string>): void {
  try {
    globalThis.localStorage?.setItem(LAST_DECK_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage blocked (private mode, quota): remembering is a convenience only.
  }
}

/** Selected split-view row: accent ring only once the detail pane is beside the list. */
const SELECTED_ROW_CLASS =
  'border-[var(--border)] @lg:border-[var(--accent)] @lg:ring-1 @lg:ring-[var(--accent)]';

interface DeckPresence {
  exact: Set<string>;
  sourceKeys: Set<string>;
}

/** Duplicate detection per deck, built for a deck only when a row first asks about it. */
interface DeckPresenceIndex {
  get(deckId: string): DeckPresence | undefined;
}

/** Matches `source_key`, an exact field, or a parenthesized Hanja token. */
function buildDeckPresence(notes: readonly Note[]): DeckPresence {
  const presence: DeckPresence = { exact: new Set<string>(), sourceKeys: new Set<string>() };
  for (const note of notes) {
    if (note.source_key) presence.sourceKeys.add(note.source_key);
    for (const val of Object.values(note.fields)) {
      const plain = stripRuby(stripRichText(val)).trim();
      if (!plain) continue;
      presence.exact.add(plain);
      // Extract parenthesized Hanja/compound tokens like `한 일 (一)` -> `一`
      for (const m of plain.matchAll(/\(([^)]+)\)/g)) {
        if (m[1]?.trim()) presence.exact.add(m[1].trim());
      }
    }
  }
  return presence;
}

/** Live notes grouped by deck, in one pass over the collection. */
function notesByDeck(notes: Iterable<Note>): Map<string, Note[]> {
  const byDeck = new Map<string, Note[]>();
  for (const note of notes) {
    if (note.archived) continue;
    const list = byDeck.get(note.deck_id);
    if (list) list.push(note);
    else byDeck.set(note.deck_id, [note]);
  }
  return byDeck;
}

/**
 * A lazy index: only the decks the visible rows point at are indexed, once per collection change,
 * instead of every field of every note on each `stateVersion` (P9). The first lookup groups the
 * notes by deck in one pass, so k decks cost N + their own notes, not k × N.
 */
export function createDeckPresenceIndex(notes: ReadonlyMap<string, Note>): DeckPresenceIndex {
  const cache = new Map<string, DeckPresence>();
  let byDeck: Map<string, Note[]> | undefined;
  return {
    get(deckId) {
      let presence = cache.get(deckId);
      if (!presence) {
        byDeck ??= notesByDeck(notes.values());
        presence = buildDeckPresence(byDeck.get(deckId) ?? []);
        cache.set(deckId, presence);
      }
      return presence;
    },
  };
}

function isEntryInDeck(entry: DictionaryEntry, presence: DeckPresence | undefined): boolean {
  return Boolean(
    presence && (presence.sourceKeys.has(`dict:${entry.id}`) || presence.exact.has(entry.headword)),
  );
}

interface EntryLangProps {
  entry: DictionaryEntry;
  lang: string;
  pinyinToneColors: boolean;
}

/** Each Han character of a word's Hanja spelling as a button that looks the character up. */
function HanjaLinks({
  text,
  onLookup,
  testIds,
}: Readonly<{
  text: string;
  onLookup: (char: string) => void;
  testIds: boolean;
}>) {
  // Keyed by code-unit offset: stable for a given text, and unique even when a character repeats.
  const parts: Array<{ ch: string; at: number }> = [];
  let at = 0;
  for (const ch of text) {
    parts.push({ ch, at });
    at += ch.length;
  }
  return (
    <>
      {parts.map(({ ch, at: offset }) =>
        isSingleIdeograph(ch) ? (
          <button
            key={offset}
            type="button"
            lang="ko"
            data-testid={testIds ? `dict-hanja-link-${ch}` : undefined}
            aria-label={`Look up Hanja ${ch}`}
            onClick={() => onLookup(ch)}
            className="rounded px-0.5 text-[var(--accent)] underline decoration-dotted underline-offset-2 hover:bg-[var(--accent-soft)]"
          >
            {ch}
          </button>
        ) : (
          <span key={offset}>{ch}</span>
        ),
      )}
    </>
  );
}

/** The reading line's text: KRDict pronunciation, tone-coloured pinyin, or plain readings. */
function EntryReadingText({ entry, lang, pinyinToneColors }: EntryLangProps) {
  if (isKoreanWordPack(entry.packId)) {
    return (
      <span
        lang="ko"
        data-testid={`dict-pron-${entry.headword}`}
        title="Standard pronunciation (표준 발음)"
      >
        [{entry.readings.join(', ')}]
      </span>
    );
  }
  if (entry.packId === 'dict-cc-cedict') {
    return (
      <RichText
        text={entry.readings.join(' · ')}
        lang="zh-Latn-pinyin"
        hideRuby={false}
        pinyinToneColors={pinyinToneColors}
      />
    );
  }
  return <span lang={lang}>{entry.readings.join(' · ')}</span>;
}

/** 음훈 for Hanja entries, otherwise the readings (if any). */
function EntryReading(props: EntryLangProps) {
  const { entry } = props;
  if (entry.eumhun && entry.eumhun.length > 0) {
    return (
      <span lang="ko" className="text-sm font-semibold text-[var(--accent)]">
        {entry.eumhun.join(' · ')}
      </span>
    );
  }
  if (entry.readings.length === 0) return null;
  return (
    <span className="text-sm font-medium text-[var(--accent)]">
      <EntryReadingText {...props} />
    </span>
  );
}

function EntryHeadline(props: EntryLangProps & { onLookup: (text: string) => void }) {
  const { entry, lang, onLookup } = props;
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span lang={lang} className="text-2xl font-bold leading-none text-[var(--fg)]">
        {entry.headword}
      </span>
      {entry.homonym !== undefined && entry.homonym > 0 && (
        <sup className="text-xs text-[var(--muted)]">{entry.homonym}</sup>
      )}
      {entry.altForms && entry.altForms.length > 0 && (
        <span
          lang={lang}
          data-testid={`dict-alt-${entry.headword}`}
          title={isKoreanWordPack(entry.packId) ? 'Hanja (원어)' : undefined}
          className="text-xs text-[var(--muted)]"
        >
          (
          {isKoreanWordPack(entry.packId) ? (
            <HanjaLinks text={entry.altForms.join(', ')} onLookup={onLookup} testIds />
          ) : (
            entry.altForms.join(', ')
          )}
          )
        </span>
      )}
      <EntryReading {...props} />
    </div>
  );
}

/** Where one sense came from (KRDict, or the app's own wording), with its attribution as a tooltip. */
function SenseSourceBadge({
  source,
  testId,
}: Readonly<{ source: DictionarySenseSource; testId: boolean }>) {
  return (
    <span
      data-testid={testId ? 'dict-sense-source' : undefined}
      data-source={source}
      title={SENSE_SOURCE_ATTRIBUTION[source]}
      className={`rounded px-1 py-0.5 text-[10px] font-semibold ${SENSE_SOURCE_CLASS[source]}`}
    >
      {SENSE_SOURCE_LABEL[source]}
    </span>
  );
}

const RELATION_LABEL: Record<DictionaryRelationType, string> = {
  synonym: 'Synonyms',
  antonym: 'Antonyms',
  related: 'See also',
};
const RELATION_ORDER: readonly DictionaryRelationType[] = ['synonym', 'antonym', 'related'];

/** The Korean definition and the synonym / antonym / related-word links of one sense. */
function SenseExtras({
  sense,
  onLookup,
  testIds,
  textClass,
}: Readonly<{
  sense: DictionarySense;
  onLookup: (text: string) => void;
  testIds: boolean;
  textClass: string;
}>) {
  return (
    <>
      {sense.definitionNative && (
        <p
          lang="ko"
          data-testid={testIds ? 'dict-definition-native' : undefined}
          className={`${textClass} text-[var(--fg)]`}
        >
          {sense.definitionNative}
        </p>
      )}
      {RELATION_ORDER.map((type) => {
        const words = sense.relations?.filter((r) => r.type === type) ?? [];
        if (words.length === 0) return null;
        return (
          <p
            key={type}
            data-testid={testIds ? `dict-relations-${type}` : undefined}
            className={`${textClass} flex flex-wrap items-baseline gap-x-1.5 text-[var(--muted)]`}
          >
            <span>{RELATION_LABEL[type]}:</span>
            {words.map((r) => (
              <button
                key={r.word}
                type="button"
                lang="ko"
                aria-label={`Look up ${r.word}`}
                onClick={() => onLookup(r.word)}
                className="rounded px-0.5 text-[var(--accent)] underline decoration-dotted underline-offset-2 hover:bg-[var(--accent-soft)]"
              >
                {r.word}
              </button>
            ))}
          </p>
        );
      })}
    </>
  );
}

function SenseItem({
  sense,
  index,
  onLookup,
}: {
  sense: DictionarySense;
  index: number;
  onLookup: (text: string) => void;
}) {
  return (
    <li className="text-sm">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className="text-[11px] font-semibold text-[var(--muted)]">{index + 1}.</span>
        <span className="font-semibold text-[var(--fg)]">
          {sense.equivalents.length > 0 ? sense.equivalents.join('; ') : sense.definition}
        </span>
        {sense.source && <SenseSourceBadge source={sense.source} testId />}
      </div>
      {sense.definition && sense.equivalents.length > 0 && (
        <p className="text-xs text-[var(--muted)]">{sense.definition}</p>
      )}
      <SenseExtras sense={sense} onLookup={onLookup} testIds textClass="text-xs" />
      {sense.examples && sense.examples.length > 0 && (
        <ul className="mt-0.5 flex flex-col gap-0.5 border-l-2 border-[var(--border)] pl-2 text-xs">
          {sense.examples.map((ex, exIdx) => (
            <li key={exIdx} data-testid="dict-example">
              <span lang="ko" className="text-[var(--fg)]">
                {ex.text}
              </span>
              {ex.translation && (
                <span lang="en" className="text-[var(--muted)]">
                  {' — '}
                  {ex.translation}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Numbered per-sense list for word packs, or the flat meanings line. */
function EntrySenses({
  entry,
  onLookup,
}: {
  entry: DictionaryEntry;
  onLookup: (text: string) => void;
}) {
  if (!entry.senses || entry.senses.length === 0) {
    return <p className="mt-1 text-sm text-[var(--fg)]">{entry.meanings.join('; ')}</p>;
  }
  return (
    <ol data-testid={`dict-senses-${entry.headword}`} className="mt-1.5 flex flex-col gap-1.5">
      {entry.senses.map((sense, senseIdx) => (
        <SenseItem key={senseIdx} sense={sense} index={senseIdx} onLookup={onLookup} />
      ))}
    </ol>
  );
}

function EntryMetaRow({
  entry,
  alreadyInSelectedDeck,
}: {
  entry: DictionaryEntry;
  alreadyInSelectedDeck: boolean;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--muted)]">
      <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-semibold">
        {PACK_SHORT_LABEL[entry.packId]}
      </span>
      {entry.pos && entry.pos.length > 0 && (
        <span data-testid={`dict-pos-${entry.headword}`} className="italic">
          {entry.pos.join(', ')}
        </span>
      )}
      {entry.level && (
        <span
          data-testid={`dict-level-${entry.headword}`}
          className={`rounded-full px-2 py-0.5 font-semibold ${LEVEL_CLASS[entry.level]}`}
        >
          {LEVEL_LABEL[entry.level]}
        </span>
      )}
      {entry.origin && !entry.altForms?.length && <span lang="ko">원어 {entry.origin}</span>}
      {entry.radical && <span>Radical: {entry.radical}</span>}
      {entry.strokeCount && <span>{entry.strokeCount} strokes</span>}
      {entry.grade && <span>· {entry.grade}</span>}
      {alreadyInSelectedDeck && (
        <span
          data-testid={`dict-in-deck-${entry.headword}`}
          className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-semibold text-emerald-700 dark:text-emerald-300"
        >
          In deck ✓
        </span>
      )}
    </div>
  );
}

/** Note type whose decks a pack's entries go to when no deck is remembered. */
const DEFAULT_NOTE_TYPE_FOR_PACK: Partial<Record<DictionaryPackId, string>> = {
  'dict-hanja-unihan': BUILTIN_NOTE_TYPE_IDS.HANJA,
  'dict-krdict': BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
  'dict-urimalsam': BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
  'dict-kaikki-ko': BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
};

/** The deck a dictionary entry goes to by default: remembered, then by note type, then language. */
function resolveDefaultDeck(
  entry: DictionaryEntry,
  decks: readonly Deck[],
  lastDeckByLang: Readonly<Record<string, string>>,
): Deck | undefined {
  const lang = PACK_LANG[entry.packId];
  const remembered = decks.find((d) => d.id === lastDeckByLang[lang]);
  if (remembered) return remembered;
  const noteTypeId = DEFAULT_NOTE_TYPE_FOR_PACK[entry.packId];
  const byNoteType = noteTypeId ? decks.find((d) => d.note_type_id === noteTypeId) : undefined;
  return byNoteType ?? decks.find((d) => d.language === lang) ?? decks[0];
}

/** The deck the Add to Deck bar preselects for `entry`. */
function rowDeckId(
  entry: DictionaryEntry,
  decks: readonly Deck[],
  lastDeckByLang: Readonly<Record<string, string>>,
): string {
  return (
    lastDeckByLang[PACK_LANG[entry.packId]] ??
    resolveDefaultDeck(entry, decks, lastDeckByLang)?.id ??
    ''
  );
}

/** Search results while something is typed, else the open browse list, else nothing. */
function visibleEntries(
  typed: boolean,
  results: DictionaryEntry[],
  browseSel: DictionaryBrowseSelection | null,
  browseEntries: DictionaryEntry[],
): DictionaryEntry[] {
  if (typed) return results;
  return browseSel ? browseEntries : [];
}

type PanelView = 'no-packs' | 'home' | 'list';

function panelView(
  noPacks: boolean,
  typed: boolean,
  browseSel: DictionaryBrowseSelection | null,
): PanelView {
  if (noPacks) return 'no-packs';
  return typed || browseSel ? 'list' : 'home';
}

function emptyListMessage(typed: boolean, query: string, browseLoading: boolean): string {
  if (typed) return `No offline dictionary matches found for “${query}”.`;
  return browseLoading ? 'Loading…' : 'No words here. Try another letter or filter.';
}

interface AddToDeckBarProps {
  entry: DictionaryEntry;
  decks: readonly Deck[];
  selectedDeckId: string;
  /** The entry's own card is already in the selected deck (adding it again would reset it). */
  alreadyAdded?: boolean;
  onChooseDeck: (deckId: string) => void;
  onAdd: (deckId: string) => void;
  onCreateDeckAndAdd: () => void;
}

/** Quick 1-tap Add to Deck confirmation bar. */
function AddToDeckBar({
  entry,
  decks,
  selectedDeckId,
  alreadyAdded = false,
  onChooseDeck,
  onAdd,
  onCreateDeckAndAdd,
}: Readonly<AddToDeckBarProps>) {
  return (
    <div
      data-testid={`dict-add-bar-${entry.headword}`}
      className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2 text-xs"
    >
      {decks.length > 0 && (
        <>
          <label className="flex items-center gap-1.5 text-[var(--muted)]">
            <span>Deck:</span>
            <select
              aria-label="Destination deck"
              data-testid="dict-add-deck-select"
              value={selectedDeckId}
              onChange={(e) => onChooseDeck(e.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
            >
              {decks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.language})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="dict-add-confirm-btn"
            disabled={alreadyAdded}
            onClick={() => {
              if (selectedDeckId) onAdd(selectedDeckId);
            }}
            className="rounded-lg bg-[var(--accent)] px-3 py-1 font-semibold text-white hover:opacity-90 disabled:cursor-default disabled:opacity-50"
          >
            {alreadyAdded ? 'Already in deck' : 'Add Card'}
          </button>
        </>
      )}
      <button
        type="button"
        data-testid="dict-add-new-deck-btn"
        onClick={onCreateDeckAndAdd}
        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 font-medium text-[var(--fg)] hover:bg-[var(--surface-2)]"
      >
        + New {PACK_SHORT_LABEL[entry.packId]} Deck
      </button>
    </div>
  );
}

interface DictionaryResultRowProps extends AddToDeckBarProps {
  direction: DictionaryDirection;
  pinyinToneColors: boolean;
  isSelected: boolean;
  isAdding: boolean;
  deckPresenceByDeck: DeckPresenceIndex;
  onLookup: (text: string) => void;
  onSelect: () => void;
  onToggleAdd: () => void;
}

/** One search or browse result: headline, senses, meta, Details and Add to Deck. */
function DictionaryResultRow({
  entry,
  direction,
  pinyinToneColors,
  isSelected,
  isAdding,
  deckPresenceByDeck,
  onLookup,
  onSelect,
  onToggleAdd,
  ...addBar
}: Readonly<DictionaryResultRowProps>) {
  const presence = addBar.selectedDeckId
    ? deckPresenceByDeck.get(addBar.selectedDeckId)
    : undefined;
  return (
    <article
      data-testid={`dict-entry-${entry.headword}`}
      data-selected={isSelected ? 'true' : undefined}
      className={`flex flex-col gap-2 rounded-xl border bg-[var(--bg)] p-3 ${
        isSelected ? SELECTED_ROW_CLASS : 'border-[var(--border)]'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {direction === 'from-english' && (
            <p
              data-testid={`dict-gloss-lead-${entry.headword}`}
              className="mb-1 text-sm font-semibold text-[var(--fg)]"
            >
              {entrySummary(entry)} →
            </p>
          )}
          <EntryHeadline
            entry={entry}
            lang={PACK_LANG[entry.packId]}
            pinyinToneColors={pinyinToneColors}
            onLookup={onLookup}
          />
          <div className="@lg:hidden">
            <EntrySenses entry={entry} onLookup={onLookup} />
          </div>
          {/* Split view: a one-line gloss; the full senses are in the detail pane */}
          <p className="mt-1 hidden truncate text-sm text-[var(--fg)] @lg:block">
            {entrySummary(entry)}
          </p>
          <EntryMetaRow entry={entry} alreadyInSelectedDeck={isEntryInDeck(entry, presence)} />
        </div>

        {/* Keyboard / D-pad way to pick the entry shown in the split-view detail pane */}
        <button
          type="button"
          data-testid={`dict-show-${entry.headword}`}
          aria-pressed={isSelected}
          aria-label={`Show details for ${entry.headword}`}
          onClick={onSelect}
          className="hidden shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-semibold text-[var(--fg)] hover:border-[var(--accent)] @lg:inline-flex @lg:items-center"
        >
          Details
        </button>

        <button
          type="button"
          data-testid={`dict-add-btn-${entry.headword}`}
          onClick={onToggleAdd}
          className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-semibold text-[var(--fg)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          {isAdding ? 'Cancel' : '+ Add to Deck'}
        </button>
      </div>

      {isAdding && (
        <AddToDeckBar
          entry={entry}
          {...addBar}
          alreadyAdded={presence?.sourceKeys.has(`dict:${entry.id}`) ?? false}
        />
      )}
    </article>
  );
}

/** Every installed pack's browse summary, plus the first Hanja for the home grid. */
async function loadBrowseHome(
  svc: DictionaryService,
  packs: readonly InstalledPackInfo[],
): Promise<{ summaries: DictionaryBrowseSummary[]; hanjaPreview: DictionaryEntry[] }> {
  const summaries = await Promise.all(
    packs.map((p) => svc.getBrowseSummary(p.id as DictionaryPackId)),
  );
  const hanja = summaries.find((x) => x.packId === 'dict-hanja-unihan');
  if (!hanja || hanja.total === 0) return { summaries, hanjaPreview: [] };
  const grade = hanja.grades[0]?.key;
  const page = await svc.browse({
    packId: 'dict-hanja-unihan',
    facet: grade ? { kind: 'grade', grade } : { kind: 'all' },
    limit: 48,
  });
  return { summaries, hanjaPreview: page.entries };
}

export function DictionaryPanel({
  initialQuery = '',
  initialDrawOpen = false,
  onOpenSettings,
}: DictionaryPanelProps) {
  const { platform, state, stateVersion, entitlement, emitEvents, getEventFactory } = useApp();
  const { createDeck } = useLibraryActions();
  const searchInputId = useId();

  const [installedPacks, setInstalledPacks] = useState<InstalledPackInfo[]>([]);
  const [packsLoaded, setPacksLoaded] = useState(false);
  const [selectedPack, setSelectedPack] = useState<DictionaryPackId | 'all'>('all');
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<DictionaryEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [showDraw, setShowDraw] = useState(initialDrawOpen);
  const {
    scripts: drawScripts,
    lang: drawLang,
    setLang: setDrawLang,
    show: languageShowsDrawTools,
  } = useDrawScripts();
  // A caller that explicitly opens the pad is honoured even when no CJK language is active.
  const showDrawTools = drawToolsVisible(languageShowsDrawTools, initialDrawOpen);
  const [direction, setDirection] = useState<DictionaryDirection>(readLookupDirection);
  const chooseDirection = (next: DictionaryDirection): void => {
    setDirection(next);
    writeLookupDirection(next);
  };
  const [recents, setRecents] = useState<string[]>(readRecentLookups);
  const rememberLookup = useCallback((q: string) => {
    setRecents((prev) => {
      const next = pushRecentLookup(prev, q);
      writeRecentLookups(next);
      return next;
    });
  }, []);

  // Browse without typing (home screen groups and the open browse list).
  const [summaries, setSummaries] = useState<DictionaryBrowseSummary[]>([]);
  const [hanjaPreview, setHanjaPreview] = useState<DictionaryEntry[]>([]);
  const [browseSel, setBrowseSel] = useState<DictionaryBrowseSelection | null>(null);
  const [browseEntries, setBrowseEntries] = useState<DictionaryEntry[]>([]);
  const [browseNext, setBrowseNext] = useState<string | undefined>(undefined);
  const [browseLoading, setBrowseLoading] = useState(false);

  // Quick "+ Add to Deck" state
  const [addingEntryId, setAddingEntryId] = useState<string | null>(null);
  const [lastDeckByLang, setLastDeckByLangState] =
    useState<Record<string, string>>(readRememberedDecks);
  // Remembered per device across reloads (§6.3 "remembering the last-used deck per language").
  const setLastDeckByLang = (
    update: (prev: Record<string, string>) => Record<string, string>,
  ): void => {
    setLastDeckByLangState((prev) => {
      const next = update(prev);
      writeRememberedDecks(next);
      return next;
    });
  };
  const [addedBanner, setAddedBanner] = useState<string | null>(null);
  // Tablet / desktop list + detail split view (Phase 13): the detail pane shows this entry.
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const typed = query.trim().length > 0;
  const listEntries = visibleEntries(typed, results, browseSel, browseEntries);
  const selectedEntry = listEntries.find((r) => r.id === selectedEntryId) ?? listEntries[0];

  // Sharded packs: the detail pane completes a stub row (its shard downloads on demand).
  useEffect(() => {
    const getService = platform.getDictionaryService;
    if (!selectedEntry?.stub || !getService) return undefined;
    let cancelled = false;
    void getService()
      .then((svc) => svc.loadFullEntries?.([selectedEntry]))
      .then((rows) => {
        const full = rows?.[0];
        if (cancelled || !full || full.stub) return;
        const swap = (list: DictionaryEntry[]) => list.map((e) => (e.id === full.id ? full : e));
        setResults(swap);
        setBrowseEntries(swap);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [platform, selectedEntry]);

  const decks = useMemo(
    () =>
      [...state.decks.values()]
        .filter((d) => !d.archived)
        .sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.id, b.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  // Duplicate detection, built per deck on first use after each collection change.
  const deckPresenceByDeck = useMemo(
    () => createDeckPresenceIndex(state.notes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  useEffect(() => {
    let cancelled = false;
    if (!platform.getDictionaryService) {
      setPacksLoaded(true);
      return undefined;
    }
    void platform
      .getDictionaryService()
      .then((svc) => svc.listInstalledDictionaryPacks())
      .then((packs) => {
        if (!cancelled) {
          setInstalledPacks(packs);
          setPacksLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setPacksLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  useEffect(() => {
    let cancelled = false;
    const getService = platform.getDictionaryService;
    if (!getService || installedPacks.length === 0) {
      setSummaries([]);
      setHanjaPreview([]);
      return undefined;
    }
    getService()
      .then((svc) => loadBrowseHome(svc, installedPacks))
      .then((home) => {
        if (cancelled) return;
        setSummaries(home.summaries);
        setHanjaPreview(home.hanjaPreview);
      })
      .catch(() => {
        if (!cancelled) setSummaries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [platform, installedPacks]);

  // UX #2: pack filters (and "All") cover the languages in use unless "Show all languages" is on.
  const {
    visiblePacks,
    hiddenPackCount,
    packFilter,
    allPackIdsKey,
    showAllLanguages,
    setShowAllLanguages,
  } = useVisiblePacks(installedPacks, selectedPack);

  const loadBrowsePage = useCallback(
    async (sel: DictionaryBrowseSelection, after?: string) => {
      if (!platform.getDictionaryService) return;
      setBrowseLoading(true);
      try {
        const svc = await platform.getDictionaryService();
        const page = await svc.browse({
          packId: sel.packId,
          facet: sel.facet,
          ...(sel.initial ? { initial: sel.initial } : {}),
          ...(sel.pos ? { pos: sel.pos } : {}),
          ...(after ? { after } : {}),
        });
        setBrowseEntries((prev) => (after ? [...prev, ...page.entries] : page.entries));
        setBrowseNext(page.next);
      } finally {
        setBrowseLoading(false);
      }
    },
    [platform],
  );

  const openBrowse = (sel: DictionaryBrowseSelection | null) => {
    setBrowseSel(sel);
    setBrowseEntries([]);
    setBrowseNext(undefined);
    setSelectedEntryId(null);
    if (sel) void loadBrowsePage(sel);
  };

  const lookUp = (text: string) => {
    setQuery(text);
    rememberLookup(text);
  };

  // Only the newest search shows its results: an earlier, slower one can finish last (C15).
  const searchLatest = useMemo(() => createLatestSearch(setResults, setSearching), []);
  const runSearch = useCallback(
    async (rawQuery: string, filter: DictionaryPackId | 'all') => {
      const trimmed = rawQuery.trim();
      const packIds = searchPackIds(filter, allPackIdsKey);
      const getService = platform.getDictionaryService;
      if (!trimmed || !getService || packIds?.length === 0) {
        await searchLatest(null);
        return;
      }
      await searchLatest(async () => {
        const svc = await getService();
        const scope = packIds ? { packIds } : undefined;
        return isSingleIdeograph(trimmed)
          ? svc.lookupCharacter(trimmed, scope)
          : svc.search(trimmed, { ...scope, limit: 60, direction });
      });
    },
    [platform, direction, allPackIdsKey, searchLatest],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runSearch(query, packFilter);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [query, runSearch, packFilter]);

  // A lookup that found something and stayed on screen goes into Recent.
  useEffect(() => {
    const q = query.trim();
    if (!q || searching || results.length === 0) return undefined;
    const timer = window.setTimeout(() => rememberLookup(q), 1200);
    return () => window.clearTimeout(timer);
  }, [query, searching, results, rememberLookup]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) rememberLookup(query);
    void runSearch(query, packFilter);
  };

  /** A sharded pack's stub row (no definitions or examples yet) is completed before it's added. */
  const withFullEntry = async (entry: DictionaryEntry): Promise<DictionaryEntry> => {
    if (!entry.stub || !platform.getDictionaryService) return entry;
    try {
      const svc = await platform.getDictionaryService();
      return (await svc.loadFullEntries?.([entry]))?.[0] ?? entry;
    } catch {
      return entry;
    }
  };

  const handleAddEntryToDeck = (entry: DictionaryEntry, deckId: string) => {
    const targetDeck = state.decks.get(deckId);
    if (!targetDeck) return;
    const noteType = state.noteTypes.get(targetDeck.note_type_id);
    const fields = mapEntryToNoteFields(entry, noteType);
    const sourceKey = `dict:${entry.id}`;
    const noteId = deriveNoteId(targetDeck.id, sourceKey);
    // The note id is derived from the entry, so adding it again would overwrite the user's edits
    // to that card's fields and tags (D17).
    if (state.notes.get(noteId)?.archived === false) {
      setAddingEntryId(null);
      setAddedBanner(`“${entry.headword}” is already in ${targetDeck.name}.`);
      return;
    }
    const factory = getEventFactory();
    const nowMs = Date.now();

    const ev = factory.create(
      'NoteUpserted',
      {
        note_id: noteId,
        deck_id: targetDeck.id,
        source_key: sourceKey,
        fields,
        tags: ['dictionary', PACK_SHORT_LABEL[entry.packId].toLowerCase()],
        provenance: { source: 'user', reviewed: true },
        created_order: nowMs,
      },
      nowMs,
    );
    emitEvents([ev]);
    setLastDeckByLang((prev) => ({ ...prev, [PACK_LANG[entry.packId]]: targetDeck.id }));
    setAddingEntryId(null);
    setAddedBanner(`Added “${entry.headword}” to ${targetDeck.name}.`);
  };

  const handleQuickCreateAndAdd = (entry: DictionaryEntry) => {
    const gate = canCreateOrImportDeck(decks.length, entitlement);
    if (!gate.allowed) {
      setAddedBanner(gate.reason ?? 'Free tier deck limit reached.');
      return;
    }
    const spec = defaultDeckSpecForPack(entry.packId);
    const newDeckId = createDeck(spec.name, spec.noteTypeId, spec.language);
    const noteType = state.noteTypes.get(spec.noteTypeId);
    const fields = mapEntryToNoteFields(entry, noteType);
    const sourceKey = `dict:${entry.id}`;
    const noteId = deriveNoteId(newDeckId, sourceKey);
    const factory = getEventFactory();
    const nowMs = Date.now();
    emitEvents([
      factory.create(
        'NoteUpserted',
        {
          note_id: noteId,
          deck_id: newDeckId,
          source_key: sourceKey,
          fields,
          tags: ['dictionary', PACK_SHORT_LABEL[entry.packId].toLowerCase()],
          provenance: { source: 'user', reviewed: true },
          created_order: nowMs,
        },
        nowMs,
      ),
    ]);
    setLastDeckByLang((prev) => ({ ...prev, [PACK_LANG[entry.packId]]: newDeckId }));
    setAddingEntryId(null);
    setAddedBanner(`Created “${spec.name}” and added “${entry.headword}”.`);
  };

  const targetName = directionTargetName(
    packFilter === 'all' ? visiblePacks.map((p) => p.language) : [PACK_LANG[packFilter]],
  );
  const homeSummaries = homeSummariesFor(summaries, packFilter, visiblePacks);
  const hanjaVisible = homeSummaries.some((x) => x.packId === 'dict-hanja-unihan');
  const browsePos = browseSel
    ? (summaries.find((x) => x.packId === browseSel.packId)?.pos ?? [])
    : [];
  const hanjaQuery = typed && isSingleIdeograph(query.trim()) ? query.trim() : null;
  const view = panelView(packsLoaded && installedPacks.length === 0, typed, browseSel);
  const firstWordIdx = hanjaQuery
    ? listEntries.findIndex((e) => e.headword !== hanjaQuery && [...e.headword].length > 1)
    : -1;

  return (
    <div data-testid="dictionary-panel" className="touch-scope @container flex flex-col gap-3">
      {/* Native dictation-safe & IME-safe search bar (§6.3, modern-web-guidance ime-safe-enter-submit) */}
      <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
        <label htmlFor={searchInputId} className="sr-only">
          Search offline dictionaries in English, Hangul (any form, 초성, or romanization), Hanja,
          Kanji, Kana, or Pinyin
        </label>
        <input
          id={searchInputId}
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          data-testid="dictionary-search-input"
          placeholder={
            direction === 'from-english'
              ? 'Type an English word: eat, school, blue…'
              : 'Search 한국어, ㅎㄱ, hanguk, Hanja, Kanji, Pinyin, or English…'
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-[14rem] flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none"
        />
        <button
          type="submit"
          data-testid="dictionary-search-submit"
          className="rounded-xl bg-[var(--accent)] px-3.5 py-2 text-xs font-semibold text-white hover:opacity-90"
        >
          Search
        </button>
        {showDrawTools && (
          <button
            type="button"
            data-testid="dictionary-toggle-draw"
            aria-pressed={showDraw}
            onClick={() => setShowDraw((v) => !v)}
            className={`rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
              showDraw
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] hover:bg-[var(--surface-2)]'
            }`}
          >
            ✎ Draw Lookup
          </button>
        )}
      </form>

      {/* Lookup direction (remembered on this device) */}
      <div
        role="radiogroup"
        aria-label="Lookup direction"
        className="inline-flex w-fit rounded-xl border border-[var(--border)] bg-[var(--surface)] p-0.5 text-xs font-semibold"
      >
        {(['to-english', 'from-english'] as const).map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={direction === d}
            data-testid={`dict-direction-${d}`}
            onClick={() => chooseDirection(d)}
            className={`min-h-9 rounded-lg px-3 py-1 ${
              direction === d
                ? 'bg-[var(--accent)] text-white'
                : 'text-[var(--muted)] hover:text-[var(--fg)]'
            }`}
          >
            {d === 'to-english' ? `${targetName} → English` : `English → ${targetName}`}
          </button>
        ))}
      </div>

      {/* Pack filter strip */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSelectedPack('all')}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              packFilter === 'all'
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--fg)]'
            }`}
          >
            All ({visiblePacks.length})
          </button>
          {visiblePacks.map((pack) => {
            const packId = pack.id as DictionaryPackId;
            return (
              <button
                key={pack.id}
                type="button"
                data-testid={`dict-filter-${pack.id}`}
                onClick={() => setSelectedPack(packId)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  packFilter === packId
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--fg)]'
                }`}
              >
                {PACK_SHORT_LABEL[packId] ?? pack.name}
              </button>
            );
          })}
          {installedPacks.length > 0 && (
            <ShowAllLanguagesSwitch
              testId="dict-show-all-languages"
              checked={showAllLanguages}
              onChange={setShowAllLanguages}
              hiddenCount={hiddenPackCount}
            />
          )}
        </div>

        {showDraw && showDrawTools && drawScripts.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <span>Draw script:</span>
            <select
              aria-label="Draw lookup language"
              value={drawLang}
              onChange={(e) => setDrawLang(e.target.value as DrawScriptLang)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
            >
              {drawScripts.map((s) => (
                <option key={s.lang} value={s.lang}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {addedBanner && (
        <div
          role="status"
          data-testid="dict-added-banner"
          className="flex items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs text-emerald-700 dark:text-emerald-300"
        >
          <span>{addedBanner}</span>
          <button
            type="button"
            onClick={() => setAddedBanner(null)}
            className="font-semibold underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Collapsible Draw-to-Lookup handwriting surface */}
      {showDraw && showDrawTools && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <DrawLookupPanel
            lang={drawLang}
            size={210}
            onSelectCandidate={(ch) => {
              lookUp(ch);
              void runSearch(ch, packFilter);
            }}
            testIdPrefix="browse-draw-lookup"
          />
        </div>
      )}

      {/* Empty state if no offline dictionary packs installed yet */}
      {view === 'no-packs' && (
        <div
          data-testid="dict-empty-packs"
          className="flex flex-col items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center"
        >
          <h2 className="text-base font-semibold">No Offline Dictionaries Installed</h2>
          <p className="max-w-md text-xs text-[var(--muted)]">
            Download standalone offline dictionaries (KRDict Korean, Hanja / Unihan, KANJIDIC2,
            CC-CEDICT, JMdict) once to look up any word or character offline—even terms not in your
            decks—and add them to your study decks in one tap.
          </p>
          {onOpenSettings && (
            <button
              type="button"
              data-testid="dict-go-settings-btn"
              onClick={onOpenSettings}
              className="rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
            >
              Install Offline Dictionaries in Settings
            </button>
          )}
        </div>
      )}
      {view === 'home' && (
        <DictionaryHome
          summaries={homeSummaries}
          hanjaPreview={hanjaVisible ? hanjaPreview : []}
          recents={recents}
          onLookup={lookUp}
          onClearRecents={() => {
            setRecents([]);
            writeRecentLookups([]);
          }}
          onBrowse={openBrowse}
        />
      )}
      {view === 'list' && (
        <div className="flex flex-col gap-3">
          {!typed && browseSel && (
            <DictionaryBrowseHeader
              selection={browseSel}
              posOptions={browsePos}
              onChange={openBrowse}
              onBack={() => openBrowse(null)}
            />
          )}
          {/* Results list, plus a detail pane beside it once the panel is tablet-wide (@lg = 32rem) */}
          <div className="grid items-start gap-3 @lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div
              data-testid="dictionary-results"
              className="flex min-w-0 flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              {typed && searching && (
                <div className="py-8 text-center text-xs text-[var(--muted)]">Searching…</div>
              )}
              {!(typed && searching) && listEntries.length === 0 && (
                <div
                  data-testid="dict-no-results"
                  className="py-8 text-center text-xs text-[var(--muted)]"
                >
                  {emptyListMessage(typed, query, browseLoading)}
                </div>
              )}
              {!(typed && searching) &&
                listEntries.map((entry, entryIdx) => (
                  <Fragment key={entry.id}>
                    {entryIdx === firstWordIdx && hanjaQuery && (
                      <h3
                        data-testid="dict-words-with-hanja"
                        lang="ko"
                        className="px-1 pt-1 text-xs font-semibold text-[var(--muted)]"
                      >
                        Words written with {hanjaQuery}
                      </h3>
                    )}
                    <DictionaryResultRow
                      entry={entry}
                      direction={direction}
                      pinyinToneColors={state.preferences.pinyin_tone_colors}
                      isSelected={selectedEntry?.id === entry.id}
                      isAdding={addingEntryId === entry.id}
                      decks={decks}
                      selectedDeckId={rowDeckId(entry, decks, lastDeckByLang)}
                      deckPresenceByDeck={deckPresenceByDeck}
                      onLookup={lookUp}
                      onSelect={() => setSelectedEntryId(entry.id)}
                      onToggleAdd={() =>
                        setAddingEntryId(addingEntryId === entry.id ? null : entry.id)
                      }
                      onChooseDeck={(deckId) =>
                        setLastDeckByLang((prev) => ({
                          ...prev,
                          [PACK_LANG[entry.packId]]: deckId,
                        }))
                      }
                      onAdd={(deckId) =>
                        void withFullEntry(entry).then((e) => handleAddEntryToDeck(e, deckId))
                      }
                      onCreateDeckAndAdd={() =>
                        void withFullEntry(entry).then((e) => handleQuickCreateAndAdd(e))
                      }
                    />
                  </Fragment>
                ))}
              {!typed && browseSel && browseNext && (
                <button
                  type="button"
                  data-testid="dict-browse-more"
                  disabled={browseLoading}
                  onClick={() => void loadBrowsePage(browseSel, browseNext)}
                  className="min-h-10 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs font-semibold text-[var(--fg)] hover:border-[var(--accent)] disabled:opacity-60"
                >
                  {browseLoading ? 'Loading…' : 'Show more'}
                </button>
              )}
            </div>
            {!(typed && searching) && selectedEntry && (
              <DictionaryEntryDetail
                entry={selectedEntry}
                pinyinToneColors={state.preferences.pinyin_tone_colors}
                onLookup={lookUp}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** First gloss, for the compact list row in split view. */
function entrySummary(entry: DictionaryEntry): string {
  const first = entry.senses?.[0];
  if (first && first.equivalents.length > 0) return first.equivalents.join('; ');
  if (first?.definition) return first.definition;
  return entry.meanings.join('; ');
}

/** The detail pane's reading line (no test ids: the list row keeps those, so each exists once). */
function DetailReading({ entry, lang, pinyinToneColors }: EntryLangProps) {
  if (entry.eumhun && entry.eumhun.length > 0) {
    return (
      <span lang="ko" className="text-lg font-semibold text-[var(--accent)]">
        {entry.eumhun.join(' · ')}
      </span>
    );
  }
  if (entry.readings.length === 0) return null;
  if (entry.packId === 'dict-cc-cedict') {
    return (
      <span className="text-lg font-medium text-[var(--accent)]">
        <RichText
          text={entry.readings.join(' · ')}
          lang="zh-Latn-pinyin"
          hideRuby={false}
          pinyinToneColors={pinyinToneColors}
        />
      </span>
    );
  }
  const text = isKoreanWordPack(entry.packId)
    ? `[${entry.readings.join(', ')}]`
    : entry.readings.join(' · ');
  return (
    <span lang={lang} className="text-lg font-medium text-[var(--accent)]">
      {text}
    </span>
  );
}

function DetailMeta({ entry }: { entry: DictionaryEntry }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--muted)]">
      <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-semibold">
        {PACK_SHORT_LABEL[entry.packId]}
      </span>
      {entry.pos && entry.pos.length > 0 && <span className="italic">{entry.pos.join(', ')}</span>}
      {entry.level && (
        <span className={`rounded-full px-2 py-0.5 font-semibold ${LEVEL_CLASS[entry.level]}`}>
          {LEVEL_LABEL[entry.level]}
        </span>
      )}
      {entry.origin && !entry.altForms?.length && <span lang="ko">원어 {entry.origin}</span>}
      {entry.radical && <span>Radical: {entry.radical}</span>}
      {entry.strokeCount && <span>{entry.strokeCount} strokes</span>}
      {entry.grade && <span>· {entry.grade}</span>}
    </div>
  );
}

function DetailSense({
  sense,
  index,
  onLookup,
}: {
  sense: DictionarySense;
  index: number;
  onLookup: (text: string) => void;
}) {
  return (
    <li className="text-base">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className="text-xs font-semibold text-[var(--muted)]">{index + 1}.</span>
        <span className="font-semibold text-[var(--fg)]">
          {sense.equivalents.length > 0 ? sense.equivalents.join('; ') : sense.definition}
        </span>
        {sense.source && <SenseSourceBadge source={sense.source} testId={false} />}
      </div>
      {sense.definition && sense.equivalents.length > 0 && (
        <p className="text-sm text-[var(--muted)]">{sense.definition}</p>
      )}
      <SenseExtras sense={sense} onLookup={onLookup} testIds={false} textClass="text-sm" />
      {sense.examples && sense.examples.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1 border-l-2 border-[var(--border)] pl-3 text-sm">
          {sense.examples.map((ex, exIdx) => (
            <li key={exIdx}>
              <span lang="ko" className="text-[var(--fg)]">
                {ex.text}
              </span>
              {ex.translation && (
                <span lang="en" className="text-[var(--muted)]">
                  {' — '}
                  {ex.translation}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Detail pane of the dictionary split view (tablets, foldables, desktop). Hidden below the
 * `@lg` container width, where every list entry already shows its full senses inline.
 * Read-only: Add to Deck stays on the list row so each control exists exactly once.
 */
function DictionaryEntryDetail({
  entry,
  pinyinToneColors,
  onLookup,
}: {
  entry: DictionaryEntry;
  pinyinToneColors: boolean;
  onLookup: (text: string) => void;
}) {
  const lang = PACK_LANG[entry.packId];
  return (
    <section
      data-testid="dictionary-detail"
      aria-label={`Details: ${entry.headword}`}
      className="hidden min-w-0 flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 @lg:sticky @lg:top-3 @lg:flex @lg:max-h-[calc(100dvh-1.5rem)] @lg:overflow-y-auto"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3
          lang={lang}
          data-testid="dict-detail-headword"
          className="text-5xl font-bold leading-tight text-[var(--fg)]"
        >
          {entry.headword}
        </h3>
        {entry.altForms && entry.altForms.length > 0 && (
          <span lang={lang} className="text-lg text-[var(--muted)]">
            (
            {isKoreanWordPack(entry.packId) ? (
              <HanjaLinks text={entry.altForms.join(', ')} onLookup={onLookup} testIds={false} />
            ) : (
              entry.altForms.join(', ')
            )}
            )
          </span>
        )}
        <DetailReading entry={entry} lang={lang} pinyinToneColors={pinyinToneColors} />
      </div>
      <DetailMeta entry={entry} />
      {entry.senses && entry.senses.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {entry.senses.map((sense, senseIdx) => (
            <DetailSense key={senseIdx} sense={sense} index={senseIdx} onLookup={onLookup} />
          ))}
        </ol>
      ) : (
        <p className="text-base text-[var(--fg)]">{entry.meanings.join('; ')}</p>
      )}
    </section>
  );
}
