import {
  filterBrowseNoteIds,
  isCardSuspended,
  isLeechCard,
  LEECH_CATEGORY,
  listCategories,
  matchesCategoryCriterion,
  normalizeCardFilter,
  normalizeTagList,
  stripCloze,
  stripRuby,
  type CardStateKind,
  type CategoryCriterion,
  type KnownEvent,
  type Note,
} from '@flash/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { NoteEditDialog } from '../components/NoteEditDialog.tsx';
import { RichText } from '../components/RichText.tsx';
import { useApp } from '../state/AppContext.tsx';
import { CategoryPicker } from '../study/CategoryPicker.tsx';
import { setBrowseFilter } from '../study/filterStore.ts';

const STATE_FILTER_OPTIONS: ReadonlyArray<{ value: CardStateKind; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'learning', label: 'Learning' },
  { value: 'due', label: 'Due today' },
  { value: 'review', label: 'Review' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'leech', label: 'Leech' },
];

const lower = (t: string) => t.toLowerCase();

const isUnreviewedAiNote = (note: Note) =>
  note.provenance.source === 'ai' && !note.provenance.reviewed;

/** Field text match, also against the ruby / cloze-stripped text of marked-up fields. */
function fieldMatchesQuery(val: string, q: string): boolean {
  if (val.toLowerCase().includes(q)) return true;
  if (val.includes('[') || val.includes('{')) {
    return stripRuby(stripCloze(val)).toLowerCase().includes(q);
  }
  return false;
}

/** Search box match for a non-empty, lowercased query. */
function noteMatchesQuery(note: Note, q: string): boolean {
  if (q.startsWith('#')) {
    // `#tag` shortcut: same category matching as the picker (exact tag or `tag::child`).
    const tagNeedle = q.slice(1);
    const tagCriterion: CategoryCriterion = { mode: 'any', tags: [tagNeedle] };
    return tagNeedle !== '' && matchesCategoryCriterion(note.tags.map(lower), tagCriterion);
  }
  return (
    Object.values(note.fields).some((val) => fieldMatchesQuery(val, q)) ||
    note.tags.some((t) => t.toLowerCase().includes(q))
  );
}

const LazyDictionaryPanel = lazy(() =>
  import('../dictionary/DictionaryPanel.tsx').then((m) => ({ default: m.DictionaryPanel })),
);
const LazyDrawLookupPanel = lazy(() =>
  import('../drawing/DrawLookupPanel.tsx').then((m) => ({ default: m.DrawLookupPanel })),
);
const LazyTagManagerPanel = lazy(() =>
  import('../browse/TagManagerPanel.tsx').then((m) => ({ default: m.TagManagerPanel })),
);
const LazyBulkEditBar = lazy(() =>
  import('../browse/BulkEditBar.tsx').then((m) => ({ default: m.BulkEditBar })),
);

export interface BrowseScreenProps {
  onOpenSettings?: () => void;
}

export function BrowseScreen({ onOpenSettings }: BrowseScreenProps = {}) {
  const {
    state,
    stateVersion,
    updateNote,
    setNoteArchived,
    markNoteReviewed,
    emitEvents,
    getEventFactory,
  } = useApp();
  const [browseMode, setBrowseMode] = useState<'notes' | 'dictionary'>('notes');
  const [query, setQuery] = useState('');
  const [deckFilter, setDeckFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<CategoryCriterion | undefined>(undefined);
  const [stateFilter, setStateFilter] = useState<CardStateKind | ''>('');
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [showArchivedOnly, setShowArchivedOnly] = useState(false);
  const [showNotesDraw, setShowNotesDraw] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [showTagManager, setShowTagManager] = useState(false);
  // Bulk edit selection (Phase 9). Only notes in the visible list count; see `selectedVisible`.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const parentRef = useRef<HTMLDivElement | null>(null);

  const decks = useMemo(
    () =>
      [...state.decks.values()]
        .filter((d) => !d.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  // Phase 9 shared filter model (decks + categories + card state), also offered in Study.
  const cardFilter = useMemo(
    () =>
      normalizeCardFilter({
        deckIds: deckFilter ? [deckFilter] : [],
        categories: categoryFilter,
        states: stateFilter ? [stateFilter] : [],
      }),
    [deckFilter, categoryFilter, stateFilter],
  );

  useEffect(() => {
    setBrowseFilter(cardFilter);
  }, [cardFilter]);

  const categories = useMemo(
    () => listCategories(state, deckFilter ? { deckIds: [deckFilter] } : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion, deckFilter],
  );

  const leechCategory = useMemo(() => {
    const leechNotes = new Set<string>();
    for (const card of state.cards.values()) {
      if (deckFilter && card.deck_id !== deckFilter) continue;
      if (isLeechCard(card)) leechNotes.add(card.note_id);
    }
    // A real `leech` tag (e.g. from an Anki import) is already listed with the note tags.
    return leechNotes.size > 0 && !categories.some((c) => c.tag === LEECH_CATEGORY)
      ? [{ tag: LEECH_CATEGORY, noteCount: leechNotes.size }]
      : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, deckFilter, categories]);

  const needsReviewCount = useMemo(() => {
    let count = 0;
    for (const note of state.notes.values()) {
      if (note.archived) continue;
      if (deckFilter && note.deck_id !== deckFilter) continue;
      if (note.provenance.source === 'ai' && !note.provenance.reviewed) {
        count += 1;
      }
    }
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, deckFilter]);

  const archivedNotesCount = useMemo(() => {
    let count = 0;
    for (const note of state.notes.values()) {
      if (!note.archived) continue;
      if (deckFilter && note.deck_id !== deckFilter) continue;
      count += 1;
    }
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, deckFilter]);

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    const nowMs = Date.now();
    // "Due today" leaves suspended cards out, like Study (Phase 9).
    const matchingNoteIds = filterBrowseNoteIds(
      state,
      cardFilter,
      { nowMs, tzOffsetMinutes: -new Date(nowMs).getTimezoneOffset() },
      { archived: showArchivedOnly },
    );
    const list: Note[] = [];
    for (const note of state.notes.values()) {
      if (!matchingNoteIds.has(note.id)) continue;
      if (needsReviewOnly && !isUnreviewedAiNote(note)) continue;
      if (q && !noteMatchesQuery(note, q)) continue;
      list.push(note);
    }
    list.sort((a, b) => a.created_order - b.created_order || (a.id < b.id ? -1 : 1));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, query, cardFilter, needsReviewOnly, showArchivedOnly]);

  /** Suspends / unsuspends every card of a note (one `CardSuspended` event per changed card). */
  const setNoteCardsSuspended = (noteId: string, suspended: boolean) => {
    const cardIds = [...(state.cardIdsByNote.get(noteId) ?? [])].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const factory = getEventFactory();
    const nowMs = Date.now();
    const events: KnownEvent[] = [];
    for (const cardId of cardIds) {
      if (isCardSuspended(state, cardId) === suspended) continue;
      const type = suspended ? 'CardSuspended' : 'CardUnsuspended';
      events.push(factory.create(type, { card_id: cardId }, nowMs));
    }
    emitEvents(events);
  };

  const selectedVisible = useMemo(
    () => filteredNotes.filter((n) => selected.has(n.id)).map((n) => n.id),
    [filteredNotes, selected],
  );
  const allVisibleSelected =
    filteredNotes.length > 0 && selectedVisible.length === filteredNotes.length;

  const toggleSelected = (noteId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const n of filteredNotes) next.delete(n.id);
      else for (const n of filteredNotes) next.add(n.id);
      return next;
    });
  };

  const rowVirtualizer = useVirtualizer({
    count: filteredNotes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 74,
    overscan: 8,
  });

  return (
    <section className="flex flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight">
            {browseMode === 'notes' ? (
              <>
                Browse{' '}
                <span className="text-sm font-normal text-[var(--muted)]">
                  ({filteredNotes.length})
                </span>
              </>
            ) : (
              'Dictionary & Draw'
            )}
          </h1>

          {/* Mode switcher: Notes | Dictionary & Draw (§6.3, §6.4) */}
          <div
            role="tablist"
            aria-label="Browse mode"
            className="inline-flex rounded-xl border border-[var(--border)] bg-[var(--surface)] p-0.5 text-xs font-semibold"
          >
            <button
              type="button"
              role="tab"
              aria-selected={browseMode === 'notes'}
              data-testid="browse-tab-notes"
              onClick={() => setBrowseMode('notes')}
              className={`rounded-lg px-2.5 py-1 transition-colors ${
                browseMode === 'notes'
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:text-[var(--fg)]'
              }`}
            >
              Notes
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={browseMode === 'dictionary'}
              data-testid="browse-tab-dictionary"
              onClick={() => setBrowseMode('dictionary')}
              className={`rounded-lg px-2.5 py-1 transition-colors ${
                browseMode === 'dictionary'
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:text-[var(--fg)]'
              }`}
            >
              Dictionary &amp; Draw
            </button>
          </div>
        </div>

        {browseMode === 'notes' && (
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2 sm:flex-none">
            <input
              type="search"
              enterKeyHint="search"
              aria-label="Search notes by text or tag"
              placeholder="Search fields or #tags..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-[12rem] flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm sm:w-56 sm:flex-none"
            />
            <button
              type="button"
              data-testid="browse-notes-draw-btn"
              aria-pressed={showNotesDraw}
              onClick={() => setShowNotesDraw((v) => !v)}
              title="Draw a character to filter notes"
              className={`rounded-xl border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                showNotesDraw
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--fg)]'
              }`}
            >
              ✎ Draw
            </button>
            <select
              aria-label="Filter by deck"
              value={deckFilter}
              onChange={(e) => setDeckFilter(e.target.value)}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm"
            >
              <option value="">All Decks</option>
              {decks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by card state"
              data-testid="browse-state-filter"
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value as CardStateKind | '')}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm"
            >
              <option value="">Any state</option>
              {STATE_FILTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="needs-review-filter"
              aria-pressed={needsReviewOnly}
              onClick={() => setNeedsReviewOnly((prev) => !prev)}
              className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
                needsReviewOnly
                  ? 'border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-300'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--fg)]'
              }`}
            >
              Needs review ({needsReviewCount})
            </button>
            {(archivedNotesCount > 0 || showArchivedOnly) && (
              <button
                type="button"
                data-testid="archived-notes-filter"
                aria-pressed={showArchivedOnly}
                onClick={() => {
                  setShowArchivedOnly((prev) => !prev);
                  setSelected(new Set());
                }}
                className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  showArchivedOnly
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--fg)]'
                }`}
              >
                Archived ({archivedNotesCount})
              </button>
            )}
          </div>
        )}
      </div>

      {browseMode === 'dictionary' ? (
        <Suspense
          fallback={
            <div className="py-12 text-center text-sm text-[var(--muted)]">
              Loading offline dictionary…
            </div>
          }
        >
          <LazyDictionaryPanel
            initialQuery={query}
            {...(onOpenSettings ? { onOpenSettings } : {})}
          />
        </Suspense>
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <CategoryPicker
                categories={categories}
                virtualCategories={leechCategory}
                value={categoryFilter}
                onChange={setCategoryFilter}
                testIdPrefix="browse-category"
              />
            </div>
            <button
              type="button"
              data-testid="open-tag-manager"
              aria-expanded={showTagManager}
              onClick={() => setShowTagManager((v) => !v)}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Manage categories
            </button>
          </div>

          {showTagManager && (
            <Suspense
              fallback={
                <div className="py-6 text-center text-xs text-[var(--muted)]">
                  Loading categories…
                </div>
              }
            >
              <LazyTagManagerPanel onClose={() => setShowTagManager(false)} />
            </Suspense>
          )}

          {showNotesDraw && (
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <Suspense
                fallback={
                  <div className="py-6 text-center text-xs text-[var(--muted)]">
                    Loading handwriting canvas…
                  </div>
                }
              >
                <LazyDrawLookupPanel
                  lang="ko"
                  size={200}
                  onSelectCandidate={(ch) => setQuery(ch)}
                  testIdPrefix="notes-draw-lookup"
                />
              </Suspense>
            </div>
          )}

          <div className="flex items-center gap-2 px-1 text-xs text-[var(--muted)]">
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                data-testid="browse-select-all"
                aria-label="Select all visible notes"
                checked={allVisibleSelected}
                disabled={filteredNotes.length === 0}
                onChange={toggleSelectAllVisible}
              />
              Select all ({filteredNotes.length})
            </label>
          </div>

          {selectedVisible.length > 0 && (
            <Suspense fallback={null}>
              <LazyBulkEditBar
                noteIds={selectedVisible}
                showingArchived={showArchivedOnly}
                onClear={() => setSelected(new Set())}
              />
            </Suspense>
          )}

          {/* Virtualized scroll container (§8) */}
          <div
            ref={parentRef}
            data-testid="browse-list"
            className="h-[calc(100dvh-13rem)] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
          >
            {filteredNotes.length === 0 ? (
              <div className="flex h-full items-center justify-center p-8 text-sm text-[var(--muted)]">
                No matching notes found.
              </div>
            ) : (
              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const note = filteredNotes[virtualRow.index];
                  if (!note) return null;
                  const deck = state.decks.get(note.deck_id);
                  const nt = deck ? state.noteTypes.get(deck.note_type_id) : undefined;
                  const primaryKey = nt?.fields[0]?.key ?? Object.keys(note.fields)[0] ?? '';
                  const secondaryKey =
                    nt?.fields.find(
                      (f) =>
                        f.key === 'meaning' || f.key === 'translation' || f.key === 'explanation',
                    )?.key ??
                    nt?.fields[1]?.key ??
                    Object.keys(note.fields)[1] ??
                    '';
                  const primaryLang = nt?.fields[0]?.lang ?? deck?.language ?? 'en';
                  const secondaryMeta = nt?.fields.find((f) => f.key === secondaryKey);
                  const needsReview = note.provenance.source === 'ai' && !note.provenance.reviewed;
                  const noteCardIds = state.cardIdsByNote.get(note.id);
                  const cardCount = noteCardIds?.size ?? 0;
                  let suspendedCount = 0;
                  let isLeech = false;
                  for (const cardId of noteCardIds ?? []) {
                    if (isCardSuspended(state, cardId)) suspendedCount += 1;
                    const card = state.cards.get(cardId);
                    if (card && isLeechCard(card)) isLeech = true;
                  }
                  const allSuspended = cardCount > 0 && suspendedCount === cardCount;

                  return (
                    <div
                      key={note.id}
                      data-testid={`browse-row-${note.id}`}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                      className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4"
                    >
                      <input
                        type="checkbox"
                        data-testid={`browse-select-${note.id}`}
                        aria-label="Select note"
                        checked={selected.has(note.id)}
                        onChange={() => toggleSelected(note.id)}
                        className="shrink-0"
                      />
                      <button
                        type="button"
                        onClick={() => setEditingNote(note)}
                        className="flex h-full min-w-0 flex-1 items-center justify-between gap-4 text-left hover:opacity-80"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-base font-medium">
                            <RichText
                              text={stripCloze(note.fields[primaryKey] ?? '(empty)')}
                              lang={primaryLang}
                              hideRuby={false}
                              pinyinToneColors={state.preferences.pinyin_tone_colors}
                            />
                          </div>
                          <div className="truncate text-xs text-[var(--muted)]">
                            <RichText
                              text={stripCloze(note.fields[secondaryKey] ?? '')}
                              lang={secondaryMeta?.lang ?? 'en'}
                              hideRuby={false}
                              pinyinToneColors={state.preferences.pinyin_tone_colors}
                            />
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                          {needsReview && (
                            <span
                              data-testid="browse-needs-review-badge"
                              className="rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300"
                            >
                              Needs review
                            </span>
                          )}
                          {suspendedCount > 0 && (
                            <span
                              data-testid="browse-suspended-badge"
                              className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[11px] font-semibold text-[var(--muted)]"
                            >
                              {allSuspended ? 'Suspended' : `${suspendedCount} suspended`}
                            </span>
                          )}
                          {isLeech && (
                            <span
                              data-testid="browse-leech-badge"
                              className="rounded-full border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:text-rose-300"
                            >
                              Leech
                            </span>
                          )}
                          {note.tags.slice(0, 2).map((tag) => (
                            <span
                              key={tag}
                              className="hidden rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] text-[var(--muted)] sm:inline"
                            >
                              #{tag}
                            </span>
                          ))}
                          <span className="rounded-md bg-[var(--surface-2)] px-2 py-0.5 text-[11px] text-[var(--muted)]">
                            {deck?.language ?? ''}
                          </span>
                        </div>
                      </button>

                      {note.archived && (
                        <button
                          type="button"
                          data-testid={`browse-restore-note-${note.id}`}
                          onClick={() => setNoteArchived(note.id, false)}
                          className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-semibold text-[var(--fg)] hover:opacity-90"
                        >
                          Restore
                        </button>
                      )}

                      {!note.archived && cardCount > 0 && (
                        <button
                          type="button"
                          data-testid={`browse-suspend-note-${note.id}`}
                          aria-pressed={allSuspended}
                          title={
                            allSuspended
                              ? 'Unsuspend: show these cards in Study again'
                              : 'Suspend: hide these cards from Study until unsuspended'
                          }
                          onClick={() => setNoteCardsSuspended(note.id, !allSuspended)}
                          className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-semibold text-[var(--fg)] hover:opacity-90"
                        >
                          {allSuspended ? 'Unsuspend' : 'Suspend'}
                        </button>
                      )}

                      {needsReview && !note.archived && (
                        <button
                          type="button"
                          data-testid={`browse-mark-reviewed-${note.id}`}
                          onClick={() => markNoteReviewed(note)}
                          className="shrink-0 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300"
                        >
                          Mark reviewed
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <NoteEditDialog
            note={editingNote}
            noteType={
              editingNote
                ? state.noteTypes.get(state.decks.get(editingNote.deck_id)?.note_type_id ?? '')
                : undefined
            }
            {...(editingNote && state.decks.get(editingNote.deck_id)?.source !== undefined
              ? { deckSource: state.decks.get(editingNote.deck_id)?.source }
              : {})}
            onSave={(note, fields, tags) => updateNote(note, fields, normalizeTagList(tags))}
            onClose={() => setEditingNote(null)}
          />
        </>
      )}
    </section>
  );
}
