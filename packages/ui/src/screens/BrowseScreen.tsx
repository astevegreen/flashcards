import { stripCloze, stripRuby, type Note } from '@flash/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { NoteEditDialog } from '../components/NoteEditDialog.tsx';
import { RichText } from '../components/RichText.tsx';
import { useApp } from '../state/AppContext.tsx';

export function BrowseScreen() {
  const { state, stateVersion, updateNote, markNoteReviewed } = useApp();
  const [query, setQuery] = useState('');
  const [deckFilter, setDeckFilter] = useState('');
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const parentRef = useRef<HTMLDivElement | null>(null);

  const decks = useMemo(
    () =>
      [...state.decks.values()]
        .filter((d) => !d.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

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

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    const isTagOnlyQuery = q.startsWith('#');
    const tagNeedle = isTagOnlyQuery ? q.slice(1) : q;
    const list: Note[] = [];
    for (const note of state.notes.values()) {
      if (note.archived) continue;
      if (deckFilter && note.deck_id !== deckFilter) continue;
      if (needsReviewOnly && !(note.provenance.source === 'ai' && !note.provenance.reviewed)) {
        continue;
      }
      if (q) {
        const matchesTag =
          tagNeedle.length > 0 && note.tags.some((t) => t.toLowerCase().includes(tagNeedle));
        if (isTagOnlyQuery) {
          if (!matchesTag) continue;
        } else {
          const matchesField = Object.values(note.fields).some((val) => {
            if (val.toLowerCase().includes(q)) return true;
            if (val.includes('[') || val.includes('{')) {
              return stripRuby(stripCloze(val)).toLowerCase().includes(q);
            }
            return false;
          });
          if (!matchesField && !matchesTag) continue;
        }
      }
      list.push(note);
    }
    list.sort((a, b) => a.created_order - b.created_order || (a.id < b.id ? -1 : 1));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, query, deckFilter, needsReviewOnly]);

  const rowVirtualizer = useVirtualizer({
    count: filteredNotes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 74,
    overscan: 8,
  });

  return (
    <section className="flex flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold tracking-tight">
          Browse{' '}
          <span className="text-sm font-normal text-[var(--muted)]">({filteredNotes.length})</span>
        </h1>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2 sm:flex-none">
          <input
            type="search"
            aria-label="Search notes by text or tag"
            placeholder="Search fields or #tags..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-[12rem] flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm sm:w-64 sm:flex-none"
          />
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
        </div>
      </div>

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
                  (f) => f.key === 'meaning' || f.key === 'translation' || f.key === 'explanation',
                )?.key ??
                nt?.fields[1]?.key ??
                Object.keys(note.fields)[1] ??
                '';
              const primaryLang = nt?.fields[0]?.lang ?? deck?.language ?? 'en';
              const secondaryMeta = nt?.fields.find((f) => f.key === secondaryKey);
              const needsReview = note.provenance.source === 'ai' && !note.provenance.reviewed;

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

                  {needsReview && (
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
        onSave={(note, fields, tags) => updateNote(note, fields, tags)}
        onClose={() => setEditingNote(null)}
      />
    </section>
  );
}
