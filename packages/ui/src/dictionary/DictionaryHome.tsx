import {
  CHOSEONG_JUMP_JAMO,
  type DictionaryBrowseCount,
  type DictionaryBrowseSummary,
  type DictionaryLevel,
} from '@flash/core/dictionary';
import type { DictionaryEntry, DictionaryPackId } from '@flash/platform';
import { useState, type ReactNode } from 'react';
import {
  partOfSpeechLabel,
  topicLabel,
  type DictionaryBrowseSelection,
} from './dictionary-home-model.ts';

const LEVEL_TITLE: Record<DictionaryLevel, string> = {
  beginner: 'Beginner · 초급',
  intermediate: 'Intermediate · 중급',
  advanced: 'Advanced · 고급',
};

/** Home sections in this order; packs not listed keep catalog order after them. */
const PACK_ORDER: readonly DictionaryPackId[] = [
  'dict-krdict',
  'dict-kaikki-ko',
  'dict-urimalsam',
  'dict-hanja-unihan',
  'dict-kanjidic2',
  'dict-jmdict',
  'dict-cc-cedict',
];

const SECTION_TITLE: Record<DictionaryPackId, string> = {
  'dict-krdict': 'Korean words',
  'dict-kaikki-ko': 'Korean (Wiktionary)',
  'dict-urimalsam': 'Korean (우리말샘)',
  'dict-hanja-unihan': 'Hanja',
  'dict-kanjidic2': 'Kanji',
  'dict-jmdict': 'Japanese words',
  'dict-cc-cedict': 'Chinese words',
};

/** Label of the whole-pack list: 가나다 order for Korean, code-point order otherwise. */
const ALL_LABEL: Record<DictionaryPackId, string> = {
  'dict-krdict': 'All words · 가나다',
  'dict-kaikki-ko': 'All words · 가나다',
  'dict-urimalsam': 'All words · 가나다',
  'dict-hanja-unihan': 'All Hanja',
  'dict-kanjidic2': 'All Kanji',
  'dict-jmdict': 'All words',
  'dict-cc-cedict': 'All words',
};

const TOPICS_SHOWN = 12;
const NUMBER = new Intl.NumberFormat('en');

export interface DictionaryHomeProps {
  summaries: readonly DictionaryBrowseSummary[];
  /** First Hanja of the Hanja pack, shown as a tap-to-look-up grid. */
  hanjaPreview: readonly DictionaryEntry[];
  recents: readonly string[];
  onLookup: (query: string) => void;
  onClearRecents: () => void;
  onBrowse: (selection: DictionaryBrowseSelection) => void;
}

function Chip({
  testId,
  onClick,
  children,
  count,
}: Readonly<{
  testId: string;
  onClick: () => void;
  children: ReactNode;
  count?: number;
}>) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg)] px-3 py-1 text-xs font-medium text-[var(--fg)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
    >
      <span>{children}</span>
      {count !== undefined && (
        <span className="text-[10px] font-semibold text-[var(--muted)]">
          {NUMBER.format(count)}
        </span>
      )}
    </button>
  );
}

function SubHeading({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
      {children}
    </h4>
  );
}

function TopicChips({
  summary,
  onBrowse,
}: Readonly<{
  summary: DictionaryBrowseSummary;
  onBrowse: DictionaryHomeProps['onBrowse'];
}>) {
  const [expanded, setExpanded] = useState(false);
  const shown: DictionaryBrowseCount[] = expanded
    ? summary.topics
    : summary.topics.slice(0, TOPICS_SHOWN);
  return (
    <div className="flex flex-col gap-1.5">
      <SubHeading>By topic</SubHeading>
      <div className="flex flex-wrap gap-1.5">
        {shown.map(({ key, count }) => (
          <Chip
            key={key}
            testId={`dict-browse-${summary.packId}-topic-${key}`}
            count={count}
            onClick={() =>
              onBrowse({
                packId: summary.packId,
                facet: { kind: 'topic', topic: key },
                title: topicLabel(key),
              })
            }
          >
            <span lang="ko">{topicLabel(key)}</span>
          </Chip>
        ))}
        {summary.topics.length > TOPICS_SHOWN && (
          <button
            type="button"
            data-testid={`dict-topics-more-${summary.packId}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="min-h-9 rounded-full px-3 py-1 text-xs font-semibold text-[var(--accent)] underline"
          >
            {expanded ? 'Fewer topics' : `All ${NUMBER.format(summary.topics.length)} topics`}
          </button>
        )}
      </div>
    </div>
  );
}

function HanjaGrid({
  entries,
  onLookup,
}: Readonly<{
  entries: readonly DictionaryEntry[];
  onLookup: DictionaryHomeProps['onLookup'];
}>) {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <SubHeading>Tap a Hanja to see its words</SubHeading>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(3.25rem,1fr))] gap-1.5">
        {entries.map((e) => (
          <button
            key={e.id}
            type="button"
            data-testid={`dict-hanja-tile-${e.headword}`}
            aria-label={`${e.headword} ${e.eumhun?.[0] ?? e.meanings[0] ?? ''}`}
            onClick={() => onLookup(e.headword)}
            className="flex min-h-14 flex-col items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg)] p-1 hover:border-[var(--accent)]"
          >
            <span lang="ko" className="text-2xl leading-none text-[var(--fg)]">
              {e.headword}
            </span>
            {e.eumhun?.[0] && (
              <span lang="ko" className="mt-0.5 truncate text-[10px] text-[var(--muted)]">
                {e.eumhun[0]}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function PackSection({
  summary,
  hanjaPreview,
  onLookup,
  onBrowse,
}: Readonly<{
  summary: DictionaryBrowseSummary;
  hanjaPreview: readonly DictionaryEntry[];
  onLookup: DictionaryHomeProps['onLookup'];
  onBrowse: DictionaryHomeProps['onBrowse'];
}>) {
  const { packId } = summary;
  if (summary.total === 0) return null;
  return (
    <section
      data-testid={`dict-home-${packId}`}
      aria-label={SECTION_TITLE[packId]}
      className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <h3 className="text-sm font-semibold text-[var(--fg)]">{SECTION_TITLE[packId]}</h3>

      {summary.levels.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SubHeading>By level</SubHeading>
          <div className="flex flex-wrap gap-1.5">
            {summary.levels.map(({ key, count }) => {
              const level = key as DictionaryLevel;
              return (
                <Chip
                  key={key}
                  testId={`dict-browse-${packId}-level-${key}`}
                  count={count}
                  onClick={() =>
                    onBrowse({ packId, facet: { kind: 'level', level }, title: LEVEL_TITLE[level] })
                  }
                >
                  {LEVEL_TITLE[level]}
                </Chip>
              );
            })}
          </div>
        </div>
      )}

      {summary.topics.length > 0 && <TopicChips summary={summary} onBrowse={onBrowse} />}

      {packId === 'dict-hanja-unihan' && <HanjaGrid entries={hanjaPreview} onLookup={onLookup} />}

      {summary.grades.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SubHeading>By grade</SubHeading>
          <div className="flex flex-wrap gap-1.5">
            {summary.grades.map(({ key, count }) => (
              <Chip
                key={key}
                testId={`dict-browse-${packId}-grade-${key}`}
                count={count}
                onClick={() =>
                  onBrowse({ packId, facet: { kind: 'grade', grade: key }, title: key })
                }
              >
                {key}
              </Chip>
            ))}
          </div>
        </div>
      )}

      <div>
        <Chip
          testId={`dict-browse-${packId}-all`}
          count={summary.total}
          onClick={() => onBrowse({ packId, facet: { kind: 'all' }, title: ALL_LABEL[packId] })}
        >
          {ALL_LABEL[packId]}
        </Chip>
      </div>
    </section>
  );
}

function orderOf(packId: DictionaryPackId): number {
  const i = PACK_ORDER.indexOf(packId);
  return i < 0 ? PACK_ORDER.length : i;
}

/**
 * What the dictionary shows before anything is typed: recent lookups, then every installed
 * pack's browse groups (level, topic, grade, everything) and a Hanja grid.
 */
export function DictionaryHome({
  summaries,
  hanjaPreview,
  recents,
  onLookup,
  onClearRecents,
  onBrowse,
}: Readonly<DictionaryHomeProps>) {
  const ordered = [...summaries].sort((a, b) => orderOf(a.packId) - orderOf(b.packId));
  return (
    <div data-testid="dictionary-home" className="flex flex-col gap-3">
      {recents.length > 0 && (
        <section
          aria-label="Recent lookups"
          className="flex flex-col gap-1.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <SubHeading>Recent</SubHeading>
            <button
              type="button"
              data-testid="dict-recent-clear"
              onClick={onClearRecents}
              className="text-[11px] font-semibold text-[var(--muted)] underline"
            >
              Clear
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {recents.map((q) => (
              <Chip key={q} testId={`dict-recent-${q}`} onClick={() => onLookup(q)}>
                <span lang="ko">{q}</span>
              </Chip>
            ))}
          </div>
        </section>
      )}
      {ordered.map((summary) => (
        <PackSection
          key={summary.packId}
          summary={summary}
          hanjaPreview={hanjaPreview}
          onLookup={onLookup}
          onBrowse={onBrowse}
        />
      ))}
      <p className="px-1 text-xs text-[var(--muted)]">
        Or type any word: English, Korean in any form (먹었어요), 초성 (ㅎㄱ), romanization
        (hanguk), Kana or Pinyin, or draw a character.
      </p>
    </div>
  );
}

const POS_SHOWN = 6;

/**
 * Header of an open browse list: back to the home, the group's name, a 가나다 jump bar for
 * Korean packs, and part-of-speech filters.
 */
export function DictionaryBrowseHeader({
  selection,
  posOptions,
  onChange,
  onBack,
}: Readonly<{
  selection: DictionaryBrowseSelection;
  posOptions: readonly DictionaryBrowseCount[];
  onChange: (selection: DictionaryBrowseSelection) => void;
  onBack: () => void;
}>) {
  const hangul =
    selection.packId === 'dict-krdict' ||
    selection.packId === 'dict-urimalsam' ||
    selection.packId === 'dict-kaikki-ko';
  const pill = (active: boolean) =>
    `min-h-9 min-w-9 rounded-full px-2.5 py-1 text-xs font-medium ${
      active
        ? 'bg-[var(--accent)] text-white'
        : 'bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--fg)]'
    }`;
  const without = (key: 'initial' | 'pos'): DictionaryBrowseSelection => {
    const { [key]: _drop, ...rest } = selection;
    return rest;
  };
  return (
    <div
      data-testid="dict-browse-header"
      className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="dict-browse-back"
          onClick={onBack}
          className="min-h-9 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1 text-xs font-semibold text-[var(--fg)] hover:border-[var(--accent)]"
        >
          ← Browse
        </button>
        <h3 data-testid="dict-browse-title" lang="ko" className="text-sm font-semibold">
          {selection.title}
        </h3>
      </div>
      {hangul && (
        <nav aria-label="Jump to initial consonant" className="flex flex-wrap gap-1">
          <button
            type="button"
            aria-pressed={!selection.initial}
            onClick={() => onChange(without('initial'))}
            className={pill(!selection.initial)}
          >
            All
          </button>
          {CHOSEONG_JUMP_JAMO.map((jamo) => (
            <button
              key={jamo}
              type="button"
              lang="ko"
              data-testid={`dict-jump-${jamo}`}
              aria-pressed={selection.initial === jamo}
              onClick={() => onChange({ ...selection, initial: jamo })}
              className={pill(selection.initial === jamo)}
            >
              {jamo}
            </button>
          ))}
        </nav>
      )}
      {posOptions.length > 1 && (
        <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0">
          <legend className="sr-only">Part of speech</legend>
          <button
            type="button"
            aria-pressed={!selection.pos}
            onClick={() => onChange(without('pos'))}
            className={pill(!selection.pos)}
          >
            All kinds
          </button>
          {posOptions.slice(0, POS_SHOWN).map(({ key }) => (
            <button
              key={key}
              type="button"
              data-testid={`dict-pos-filter-${key}`}
              aria-pressed={selection.pos === key}
              onClick={() => onChange({ ...selection, pos: key })}
              className={pill(selection.pos === key)}
            >
              {partOfSpeechLabel(key)}
            </button>
          ))}
        </fieldset>
      )}
    </div>
  );
}
