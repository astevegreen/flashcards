import {
  BUILTIN_NOTE_TYPE_IDS,
  deriveNoteId,
  stripRuby,
  type Deck,
  type NoteType,
} from '@flash/core';
import { canCreateOrImportDeck } from '@flash/core/license';
import type { DictionaryEntry, DictionaryPackId, InstalledPackInfo } from '@flash/platform';
import type { DictionaryLevel, DictionarySenseSource } from '@flash/core/dictionary';
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { RichText } from '../components/RichText.tsx';
import { DrawLookupPanel } from '../drawing/DrawLookupPanel.tsx';
import { useApp } from '../state/AppContext.tsx';

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
};

/** Per-sense source badge (Phase 10: every sense shows where it came from). */
const SENSE_SOURCE_LABEL: Record<DictionarySenseSource, string> = {
  krdict: 'KRDict',
};

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
};

function mapEntryToNoteFields(
  entry: DictionaryEntry,
  noteType: NoteType | undefined,
): Record<string, string> {
  const meaningText = entry.meanings.join('; ');
  const readingText = entry.readings.join(', ');
  const eumhunText = entry.eumhun?.join(', ') || readingText;
  const metaNotesParts: string[] = [];
  if (entry.radical) metaNotesParts.push(`Radical: ${entry.radical}`);
  if (entry.strokeCount) metaNotesParts.push(`Strokes: ${entry.strokeCount}`);
  if (entry.grade) metaNotesParts.push(entry.grade);
  const metaNotes = metaNotesParts.join(' · ');

  const keys = new Set((noteType?.fields ?? []).map((f) => f.key));

  // Korean word packs (KRDict) → Korean vocabulary note type: word / Hanja / meaning / example / notes.
  if (entry.packId === 'dict-krdict' && keys.has('word') && keys.has('hanja')) {
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

  if (keys.has('character') && keys.has('eumhun')) {
    return {
      character: entry.headword,
      eumhun: eumhunText,
      meaning: meaningText,
      notes: metaNotes,
    };
  }
  if (keys.has('word') && keys.has('hanja')) {
    return {
      word: entry.eumhun?.[0] ? `${entry.eumhun[0]} (${entry.headword})` : entry.headword,
      hanja: eumhunText ? `${entry.headword} · ${eumhunText}` : entry.headword,
      meaning: meaningText,
      notes: metaNotes,
    };
  }
  if (keys.has('word') && keys.has('reading')) {
    return {
      word: entry.headword,
      reading: readingText,
      meaning: meaningText,
      notes: metaNotes,
    };
  }
  if (keys.has('sentence') && keys.has('translation')) {
    return {
      sentence: entry.headword,
      reading: readingText,
      translation: meaningText,
      notes: metaNotes,
    };
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

export function DictionaryPanel({
  initialQuery = '',
  initialDrawOpen = false,
  onOpenSettings,
}: DictionaryPanelProps) {
  const { platform, state, stateVersion, entitlement, emitEvents, getEventFactory, createDeck } =
    useApp();
  const searchInputId = useId();

  const [installedPacks, setInstalledPacks] = useState<InstalledPackInfo[]>([]);
  const [packsLoaded, setPacksLoaded] = useState(false);
  const [selectedPack, setSelectedPack] = useState<DictionaryPackId | 'all'>('all');
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<DictionaryEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [showDraw, setShowDraw] = useState(initialDrawOpen);
  const [drawLang, setDrawLang] = useState<'ko' | 'ja' | 'zh-Hans'>('ko');

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

  const decks = useMemo(
    () =>
      [...state.decks.values()]
        .filter((d) => !d.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  // Build fast duplicate-detection index per deck (matches `source_key`, exact field, or parenthesized Hanja)
  const deckPresenceByDeck = useMemo(() => {
    const map = new Map<string, { exact: Set<string>; sourceKeys: Set<string> }>();
    for (const note of state.notes.values()) {
      if (note.archived) continue;
      let bucket = map.get(note.deck_id);
      if (!bucket) {
        bucket = { exact: new Set<string>(), sourceKeys: new Set<string>() };
        map.set(note.deck_id, bucket);
      }
      if (note.source_key) bucket.sourceKeys.add(note.source_key);
      for (const val of Object.values(note.fields)) {
        const plain = stripRuby(val).trim();
        if (!plain) continue;
        bucket.exact.add(plain);
        // Extract parenthesized Hanja/compound tokens like `한 일 (一)` -> `一`
        for (const m of plain.matchAll(/\(([^)]+)\)/g)) {
          if (m[1]?.trim()) bucket.exact.add(m[1].trim());
        }
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion]);

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

  const runSearch = useCallback(
    async (rawQuery: string, packFilter: DictionaryPackId | 'all') => {
      const trimmed = rawQuery.trim();
      if (!trimmed || !platform.getDictionaryService) {
        setResults([]);
        return;
      }
      setSearching(true);
      try {
        const svc = await platform.getDictionaryService();
        const packIds = packFilter === 'all' ? undefined : [packFilter];
        const found = isSingleIdeograph(trimmed)
          ? await svc.lookupCharacter(trimmed, packIds ? { packIds } : undefined)
          : await svc.search(trimmed, { ...(packIds ? { packIds } : {}), limit: 60 });
        setResults(found);
      } finally {
        setSearching(false);
      }
    },
    [platform],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runSearch(query, selectedPack);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [query, runSearch, selectedPack]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void runSearch(query, selectedPack);
  };

  const resolveDefaultDeckForEntry = (entry: DictionaryEntry): Deck | undefined => {
    const lang = PACK_LANG[entry.packId];
    const rememberedId = lastDeckByLang[lang];
    if (rememberedId) {
      const found = decks.find((d) => d.id === rememberedId);
      if (found) return found;
    }
    if (entry.packId === 'dict-hanja-unihan') {
      const hanjaDeck = decks.find((d) => d.note_type_id === BUILTIN_NOTE_TYPE_IDS.HANJA);
      if (hanjaDeck) return hanjaDeck;
    }
    if (entry.packId === 'dict-krdict') {
      const koDeck = decks.find((d) => d.note_type_id === BUILTIN_NOTE_TYPE_IDS.VOCAB_KO);
      if (koDeck) return koDeck;
    }
    return decks.find((d) => d.language === lang) ?? decks[0];
  };

  const handleAddEntryToDeck = (entry: DictionaryEntry, deckId: string) => {
    const targetDeck = state.decks.get(deckId);
    if (!targetDeck) return;
    const noteType = state.noteTypes.get(targetDeck.note_type_id);
    const fields = mapEntryToNoteFields(entry, noteType);
    const sourceKey = `dict:${entry.id}`;
    const noteId = deriveNoteId(targetDeck.id, sourceKey);
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

  return (
    <div data-testid="dictionary-panel" className="flex flex-col gap-3">
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
          placeholder="Search 한국어, ㅎㄱ, hanguk, Hanja, Kanji, Pinyin, or English…"
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
      </form>

      {/* Pack filter strip */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSelectedPack('all')}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              selectedPack === 'all'
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--fg)]'
            }`}
          >
            All ({installedPacks.length})
          </button>
          {installedPacks.map((pack) => {
            const packId = pack.id as DictionaryPackId;
            return (
              <button
                key={pack.id}
                type="button"
                data-testid={`dict-filter-${pack.id}`}
                onClick={() => setSelectedPack(packId)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  selectedPack === packId
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--fg)]'
                }`}
              >
                {PACK_SHORT_LABEL[packId] ?? pack.name}
              </button>
            );
          })}
        </div>

        {showDraw && (
          <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <span>Draw script:</span>
            <select
              aria-label="Draw lookup language"
              value={drawLang}
              onChange={(e) => setDrawLang(e.target.value as 'ko' | 'ja' | 'zh-Hans')}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
            >
              <option value="ko">Hanja (Korean)</option>
              <option value="ja">Kanji (Japanese)</option>
              <option value="zh-Hans">Hanzi (Chinese)</option>
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
      {showDraw && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <DrawLookupPanel
            lang={drawLang}
            size={210}
            onSelectCandidate={(ch) => {
              setQuery(ch);
              void runSearch(ch, selectedPack);
            }}
            testIdPrefix="browse-draw-lookup"
          />
        </div>
      )}

      {/* Empty state if no offline dictionary packs installed yet */}
      {packsLoaded && installedPacks.length === 0 ? (
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
      ) : (
        /* Dictionary Results List */
        <div
          data-testid="dictionary-results"
          className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3"
        >
          {searching ? (
            <div className="py-8 text-center text-xs text-[var(--muted)]">Searching…</div>
          ) : !query.trim() ? (
            <div className="py-8 text-center text-xs text-[var(--muted)]">
              Type any English word, a Korean word in any form (먹었어요), 초성 (ㅎㄱ), romanization
              (hanguk), a reading (Kana / Pinyin), or draw a character to look up definitions
              offline.
            </div>
          ) : results.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--muted)]">
              No offline dictionary matches found for “{query}”.
            </div>
          ) : (
            results.map((entry) => {
              const lang = PACK_LANG[entry.packId];
              const defaultDeck = resolveDefaultDeckForEntry(entry);
              const isAdding = addingEntryId === entry.id;
              const selectedDeckId = lastDeckByLang[lang] ?? defaultDeck?.id ?? decks[0]?.id ?? '';
              const deckPresence = selectedDeckId
                ? deckPresenceByDeck.get(selectedDeckId)
                : undefined;
              const alreadyInSelectedDeck = Boolean(
                deckPresence &&
                (deckPresence.sourceKeys.has(`dict:${entry.id}`) ||
                  deckPresence.exact.has(entry.headword)),
              );

              return (
                <article
                  key={entry.id}
                  data-testid={`dict-entry-${entry.headword}`}
                  className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span
                          lang={lang}
                          className="text-2xl font-bold leading-none text-[var(--fg)]"
                        >
                          {entry.headword}
                        </span>
                        {entry.homonym !== undefined && entry.homonym > 0 && (
                          <sup className="text-xs text-[var(--muted)]">{entry.homonym}</sup>
                        )}
                        {entry.altForms && entry.altForms.length > 0 && (
                          <span
                            lang={lang}
                            data-testid={`dict-alt-${entry.headword}`}
                            title={entry.packId === 'dict-krdict' ? 'Hanja (원어)' : undefined}
                            className="text-xs text-[var(--muted)]"
                          >
                            ({entry.altForms.join(', ')})
                          </span>
                        )}
                        {entry.eumhun && entry.eumhun.length > 0 ? (
                          <span lang="ko" className="text-sm font-semibold text-[var(--accent)]">
                            {entry.eumhun.join(' · ')}
                          </span>
                        ) : entry.readings.length > 0 ? (
                          <span className="text-sm font-medium text-[var(--accent)]">
                            {entry.packId === 'dict-krdict' ? (
                              <span
                                lang="ko"
                                data-testid={`dict-pron-${entry.headword}`}
                                title="Standard pronunciation (표준 발음)"
                              >
                                [{entry.readings.join(', ')}]
                              </span>
                            ) : entry.packId === 'dict-cc-cedict' ? (
                              <RichText
                                text={entry.readings.join(' · ')}
                                lang="zh-Latn-pinyin"
                                hideRuby={false}
                                pinyinToneColors={state.preferences.pinyin_tone_colors}
                              />
                            ) : (
                              <span lang={lang}>{entry.readings.join(' · ')}</span>
                            )}
                          </span>
                        ) : null}
                      </div>

                      {entry.senses && entry.senses.length > 0 ? (
                        <ol
                          data-testid={`dict-senses-${entry.headword}`}
                          className="mt-1.5 flex flex-col gap-1.5"
                        >
                          {entry.senses.map((sense, senseIdx) => (
                            <li key={senseIdx} className="text-sm">
                              <div className="flex flex-wrap items-baseline gap-1.5">
                                <span className="text-[11px] font-semibold text-[var(--muted)]">
                                  {senseIdx + 1}.
                                </span>
                                <span className="font-semibold text-[var(--fg)]">
                                  {sense.equivalents.length > 0
                                    ? sense.equivalents.join('; ')
                                    : sense.definition}
                                </span>
                                {sense.source && (
                                  <span
                                    data-testid="dict-sense-source"
                                    className="rounded bg-[var(--surface-2)] px-1 py-0.5 text-[10px] font-semibold text-[var(--muted)]"
                                  >
                                    {SENSE_SOURCE_LABEL[sense.source]}
                                  </span>
                                )}
                              </div>
                              {sense.definition && sense.equivalents.length > 0 && (
                                <p className="text-xs text-[var(--muted)]">{sense.definition}</p>
                              )}
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
                          ))}
                        </ol>
                      ) : (
                        <p className="mt-1 text-sm text-[var(--fg)]">{entry.meanings.join('; ')}</p>
                      )}

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
                        {entry.origin && !entry.altForms?.length && (
                          <span lang="ko">원어 {entry.origin}</span>
                        )}
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
                    </div>

                    <button
                      type="button"
                      data-testid={`dict-add-btn-${entry.headword}`}
                      onClick={() => setAddingEntryId(isAdding ? null : entry.id)}
                      className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-semibold text-[var(--fg)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                    >
                      {isAdding ? 'Cancel' : '+ Add to Deck'}
                    </button>
                  </div>

                  {/* Quick 1-tap Add to Deck confirmation bar */}
                  {isAdding && (
                    <div
                      data-testid={`dict-add-bar-${entry.headword}`}
                      className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2 text-xs"
                    >
                      {decks.length > 0 ? (
                        <>
                          <label className="flex items-center gap-1.5 text-[var(--muted)]">
                            <span>Deck:</span>
                            <select
                              aria-label="Destination deck"
                              data-testid="dict-add-deck-select"
                              value={selectedDeckId}
                              onChange={(e) =>
                                setLastDeckByLang((prev) => ({
                                  ...prev,
                                  [lang]: e.target.value,
                                }))
                              }
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
                            onClick={() => {
                              if (selectedDeckId) handleAddEntryToDeck(entry, selectedDeckId);
                            }}
                            className="rounded-lg bg-[var(--accent)] px-3 py-1 font-semibold text-white hover:opacity-90"
                          >
                            Add Card
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        data-testid="dict-add-new-deck-btn"
                        onClick={() => handleQuickCreateAndAdd(entry)}
                        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 font-medium text-[var(--fg)] hover:bg-[var(--surface-2)]"
                      >
                        + New {PACK_SHORT_LABEL[entry.packId]} Deck
                      </button>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
