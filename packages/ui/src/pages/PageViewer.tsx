import {
  deriveCardId,
  getEnabledLayoutsForDeck,
  stripCloze,
  type Card,
  type Deck,
  type Note,
  type Page,
  type ReviewRating,
  deckNoteType,
  noteField,
} from '@flash/core';
import { isStrictHttpsUrl } from '@flash/core/sources';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MediaImage } from '../components/MediaImage.tsx';
import { RichText } from '../components/RichText.tsx';
import { useApp } from '../state/AppContext.tsx';
import { useLibraryActions } from '../state/libraryActions.ts';
import { parsePageMarkdownToAst, type AstNode } from './markdownAst.ts';

// Now and the UTC offset, read outside the component body: the React Compiler's purity check
// cannot tell a handler or a memo there from render code. Kept per file so it adds no shared chunk.
const readClock = (nowMs = Date.now()) => ({
  nowMs,
  tzOffsetMinutes: -new Date(nowMs).getTimezoneOffset(),
});

export interface PageViewerProps {
  page: Page;
  onBack?: () => void;
  onEdit?: (page: Page) => void;
  onStudyDeck?: (deckId: string) => void;
  /** When true (e.g. live editor preview), hides Mark as Read controls and scroll-read trigger. */
  previewMode?: boolean;
}

function extractPlainText(node: AstNode): string {
  if (typeof node.value === 'string') return node.value;
  if (!node.children) return '';
  return node.children.map(extractPlainText).join('');
}

function findDeckByRef(decks: Iterable<Deck>, ref: string): Deck | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  for (const d of decks) {
    if (d.archived) continue;
    if (d.id === trimmed || d.name.toLowerCase() === lower) {
      return d;
    }
  }
  return undefined;
}

function ExampleDirectiveBox({
  node,
  pageLang,
  renderChildren,
  pinyinToneColors,
}: {
  node: AstNode;
  pageLang: string;
  renderChildren: (nodes: readonly AstNode[], keyPrefix: string) => ReactNode;
  pinyinToneColors: boolean;
}) {
  const [showTranslation, setShowTranslation] = useState(false);
  const children = node.children ?? [];
  const sepIndex = children.findIndex((c) => c.type === 'thematicBreak');
  const attrTranslation = node.attributes?.['translation']?.trim() || '';

  const mainNodes = sepIndex >= 0 ? children.slice(0, sepIndex) : children;
  const translationNodes = sepIndex >= 0 ? children.slice(sepIndex + 1) : [];
  const hasTranslation = translationNodes.length > 0 || attrTranslation.length > 0;

  return (
    <div
      data-testid="directive-example"
      className="my-4 rounded-2xl border border-[var(--border)] bg-[var(--bg)] p-4"
    >
      <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--accent)]">
        Example
      </div>
      <div lang={pageLang} className="space-y-2 text-base leading-relaxed">
        {renderChildren(mainNodes, 'ex-main')}
      </div>
      {hasTranslation && (
        <div className="mt-3 border-t border-[var(--border)] pt-2.5">
          <button
            type="button"
            data-testid="directive-example-toggle"
            onClick={() => setShowTranslation((prev) => !prev)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-medium text-[var(--muted)] hover:text-[var(--fg)]"
          >
            {showTranslation ? 'Hide translation' : 'Show translation'}
          </button>
          {showTranslation && (
            <div
              data-testid="directive-example-translation"
              className="mt-2 space-y-1 text-sm text-[var(--muted)]"
            >
              {translationNodes.length > 0 ? (
                renderChildren(translationNodes, 'ex-tr')
              ) : (
                <RichText
                  text={attrTranslation}
                  lang="en"
                  hideRuby={false}
                  pinyinToneColors={pinyinToneColors}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InlineCardsWidget({
  deckRef,
  tagFilter,
  onStudyDeck,
  previewMode = false,
}: {
  deckRef: string;
  tagFilter?: string;
  onStudyDeck?: ((deckId: string) => void) | undefined;
  /** Editor preview: flip-through only, never records reviews. */
  previewMode?: boolean;
}) {
  const { state, stateVersion, rateCard } = useApp();
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);
  // When the current card was shown: the first at mount, each next one when it is flipped to.
  const [mountedAtMs] = useState(() => Date.now());
  const shownAtRef = useRef(mountedAtMs);

  const { deck, notes } = useMemo(() => {
    const matchedDeck = findDeckByRef(state.decks.values(), deckRef);
    const list: Note[] = [];
    if (matchedDeck) {
      const wantTag = tagFilter?.trim().toLowerCase();
      for (const note of state.notes.values()) {
        if (note.archived || note.deck_id !== matchedDeck.id) continue;
        if (wantTag && !note.tags.some((t) => t.toLowerCase() === wantTag)) continue;
        list.push(note);
      }
      list.sort((a, b) => a.created_order - b.created_order || (a.id < b.id ? -1 : 1));
    }
    return { deck: matchedDeck, notes: list };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, deckRef, tagFilter]);

  if (!deck) {
    return (
      <div
        data-testid="directive-cards"
        className="my-4 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg)] p-4 text-xs text-[var(--muted)]"
      >
        Mini-study cards: deck &ldquo;{deckRef}&rdquo; not found in library.
      </div>
    );
  }

  if (notes.length === 0) {
    return (
      <div
        data-testid="directive-cards"
        className="my-4 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg)] p-4 text-xs text-[var(--muted)]"
      >
        No matching cards found in {deck.name}
        {tagFilter ? ` (#${tagFilter})` : ''}.
      </div>
    );
  }

  const safeIndex = index % notes.length;
  const note = notes[safeIndex];
  if (!note) return null;
  const noteType = deckNoteType(state, deck);
  const frontKey = noteType?.fields[0]?.key ?? Object.keys(note.fields)[0] ?? '';
  const backKey =
    noteType?.fields.find(
      (f) => f.key === 'meaning' || f.key === 'translation' || f.key === 'explanation',
    )?.key ??
    noteType?.fields[1]?.key ??
    Object.keys(note.fields)[1] ??
    '';
  const frontLang = noteType?.fields[0]?.lang ?? deck.language;
  const frontRaw = noteField(note, frontKey) ?? '';
  const backRaw = noteField(note, backKey) ?? '';

  // Rate against the deck's flip layout (else its first enabled layout), so a review here is
  // the same FSRS review the Study screen would record for that card (§2.3 inline mini-study).
  const enabledLayouts = getEnabledLayoutsForDeck(state, deck);
  const studyLayout =
    enabledLayouts.find((l) => l.answer_mode === 'flip') ?? enabledLayouts[0] ?? undefined;
  // Cloze layouts number their cards by blank (c1, c2, …), every other layout uses variant 0.
  let studyCard: Card | undefined;
  if (studyLayout) {
    for (let variant = 0; variant <= 20 && !studyCard; variant++) {
      studyCard = state.cards.get(deriveCardId(note.id, studyLayout.id, variant));
    }
  }
  const ratingMode = state.preferences.rating_button_mode;
  const ratingButtons: Array<{ rating: ReviewRating; label: string }> = [
    { rating: 1, label: 'Again' },
    ...(ratingMode === '4' ? [{ rating: 2 as ReviewRating, label: 'Hard' }] : []),
    { rating: 3, label: 'Good' },
    ...(ratingMode !== '2' ? [{ rating: 4 as ReviewRating, label: 'Easy' }] : []),
  ];

  const goNext = () => {
    setIndex((prev) => (prev + 1) % notes.length);
    setRevealed(false);
    shownAtRef.current = readClock().nowMs;
  };

  const handleRate = (rating: ReviewRating) => {
    if (!studyCard) return;
    rateCard(studyCard, rating, readClock().nowMs - shownAtRef.current);
    setReviewedCount((n) => n + 1);
    goNext();
  };

  return (
    <div
      data-testid="directive-cards"
      className="my-4 flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]">
        <span className="font-semibold text-[var(--fg)]">
          Mini-Study · {deck.name}
          {tagFilter ? ` (#${tagFilter})` : ''}
        </span>
        <span>
          Card {safeIndex + 1} / {notes.length}
          {reviewedCount > 0 && (
            <span data-testid="directive-cards-reviewed"> · {reviewedCount} reviewed</span>
          )}
        </span>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-center">
        <div className="text-lg font-semibold">
          <RichText
            text={stripCloze(frontRaw)}
            lang={frontLang}
            hideRuby={!revealed}
            pinyinToneColors={state.preferences.pinyin_tone_colors}
          />
        </div>
        {revealed && backRaw && (
          <div
            data-testid="directive-cards-back"
            className="mt-2 border-t border-[var(--border)] pt-2 text-sm text-[var(--muted)]"
          >
            <RichText
              text={stripCloze(backRaw)}
              lang="en"
              hideRuby={false}
              pinyinToneColors={state.preferences.pinyin_tone_colors}
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="directive-cards-flip"
            onClick={() => setRevealed((prev) => !prev)}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
          >
            {revealed ? 'Hide' : 'Flip Card'}
          </button>
          <button
            type="button"
            data-testid="directive-cards-next"
            onClick={goNext}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--surface-2)]"
          >
            Next Card →
          </button>
        </div>

        {revealed && studyCard && !previewMode && (
          <div className="flex flex-wrap gap-1.5" data-testid="directive-cards-ratings">
            {ratingButtons.map((b) => (
              <button
                key={b.rating}
                type="button"
                data-testid={`directive-cards-rate-${b.rating}`}
                onClick={() => handleRate(b.rating)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                  b.rating === 1
                    ? 'bg-rose-500/15 text-rose-700 hover:bg-rose-500/25 dark:text-rose-300'
                    : 'border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)]'
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>
        )}

        {onStudyDeck && (
          <button
            type="button"
            onClick={() => onStudyDeck(deck.id)}
            className="text-xs font-semibold text-[var(--accent)] hover:underline"
          >
            Open Full Deck ↗
          </button>
        )}
      </div>
    </div>
  );
}

function SayDirectiveButton({
  textToSpeak,
  sayLang,
  pinyinToneColors,
}: {
  textToSpeak: string;
  sayLang: string;
  pinyinToneColors: boolean;
}) {
  const { audio } = useApp();
  const timerRef = useRef<number | null>(null);
  const pressOriginRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const longPressFiredRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const triggerSpeak = (rate: number) => {
    audio.unlock();
    void audio.speakText(textToSpeak, sayLang, rate);
  };

  return (
    <button
      type="button"
      data-testid="directive-say"
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        longPressFiredRef.current = false;
        pressOriginRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
        clearTimer();
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          longPressFiredRef.current = true;
          triggerSpeak(0.75);
        }, 450);
      }}
      onPointerMove={(e) => {
        const origin = pressOriginRef.current;
        if (!origin || origin.pointerId !== e.pointerId) return;
        if (Math.abs(e.clientX - origin.x) > 10 || Math.abs(e.clientY - origin.y) > 10) {
          clearTimer();
          pressOriginRef.current = null;
        }
      }}
      onPointerUp={() => {
        clearTimer();
        pressOriginRef.current = null;
      }}
      onPointerCancel={() => {
        clearTimer();
        pressOriginRef.current = null;
        longPressFiredRef.current = false;
      }}
      onPointerLeave={() => {
        clearTimer();
        pressOriginRef.current = null;
      }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        if (longPressFiredRef.current) {
          longPressFiredRef.current = false;
          return;
        }
        triggerSpeak(e.shiftKey ? 0.75 : 1.0);
      }}
      title={`Speak (${sayLang}) — Shift+click or hold for 0.75×`}
      className="mx-0.5 inline-flex select-none items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-sm font-medium text-[var(--fg)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
    >
      <span aria-hidden="true">🔊</span>
      <RichText
        text={textToSpeak}
        lang={sayLang}
        hideRuby={false}
        pinyinToneColors={pinyinToneColors}
      />
    </button>
  );
}

/**
 * Untrusted-safe declarative Markdown Lesson Page renderer (§2.3, §8, §13).
 * Renders AST nodes purely as React JSX — zero `dangerouslySetInnerHTML`, drops any `html` node.
 */
export function PageViewer({
  page,
  onBack,
  onEdit,
  onStudyDeck,
  previewMode = false,
}: PageViewerProps) {
  const { state } = useApp();
  const { markPageRead } = useLibraryActions();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledRef = useRef(false);
  const autoMarkedRef = useRef(false);

  const pageLang = page.lang ?? 'en';
  const pinyinToneColors = state.preferences.pinyin_tone_colors;
  const isRead = page.read_at !== undefined;

  useEffect(() => {
    hasScrolledRef.current = false;
    autoMarkedRef.current = isRead;
  }, [page.id, isRead]);

  const ast = useMemo(() => parsePageMarkdownToAst(page.markdown), [page.markdown]);

  // Active scroll-to-bottom PageRead detection on genuinely scrollable pages (never auto-fires on mount)
  const handleScroll = () => {
    if (previewMode || isRead || autoMarkedRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop > 24) {
      hasScrolledRef.current = true;
    }
    const isScrollable = el.scrollHeight - el.clientHeight > 60;
    if (
      isScrollable &&
      hasScrolledRef.current &&
      el.scrollTop + el.clientHeight >= el.scrollHeight - 24
    ) {
      autoMarkedRef.current = true;
      markPageRead(page.id);
    }
  };

  const renderNodes = (nodes: readonly AstNode[] | undefined, prefix: string): ReactNode => {
    if (!nodes || nodes.length === 0) return null;
    return nodes.map((node, idx) => renderNode(node, `${prefix}-${idx}`));
  };

  const renderNode = (node: AstNode, key: string): ReactNode => {
    switch (node.type) {
      // §13 Security: unconditionally drop any raw HTML AST node
      case 'html':
        return null;

      case 'root':
        return <>{renderNodes(node.children, key)}</>;

      case 'text':
        return (
          <RichText
            key={key}
            text={node.value ?? ''}
            lang={pageLang}
            hideRuby={false}
            pinyinToneColors={pinyinToneColors}
          />
        );

      case 'paragraph':
        return (
          <p key={key} className="my-3 leading-relaxed">
            {renderNodes(node.children, key)}
          </p>
        );

      case 'heading': {
        const depth = node.depth ?? 2;
        const content = renderNodes(node.children, key);
        if (depth === 1) {
          return (
            <h1 key={key} className="mb-3 mt-1 text-2xl font-bold tracking-tight">
              {content}
            </h1>
          );
        }
        if (depth === 2) {
          return (
            <h2 key={key} className="mb-2 mt-6 text-xl font-bold tracking-tight">
              {content}
            </h2>
          );
        }
        return (
          <h3 key={key} className="mb-2 mt-5 text-base font-semibold">
            {content}
          </h3>
        );
      }

      case 'strong':
        return (
          <strong key={key} className="font-semibold">
            {renderNodes(node.children, key)}
          </strong>
        );

      case 'emphasis':
        return (
          <em key={key} className="italic">
            {renderNodes(node.children, key)}
          </em>
        );

      case 'inlineCode':
        return (
          <code
            key={key}
            className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[0.9em]"
          >
            {node.value ?? ''}
          </code>
        );

      case 'code':
        return (
          <pre
            key={key}
            className="my-3 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs"
          >
            <code>{node.value ?? ''}</code>
          </pre>
        );

      case 'blockquote':
        return (
          <blockquote
            key={key}
            className="my-3 border-l-4 border-[var(--accent)] pl-4 text-sm italic text-[var(--muted)]"
          >
            {renderNodes(node.children, key)}
          </blockquote>
        );

      case 'list':
        return node.ordered ? (
          <ol key={key} start={node.start ?? 1} className="my-3 list-decimal space-y-1 pl-6">
            {renderNodes(node.children, key)}
          </ol>
        ) : (
          <ul key={key} className="my-3 list-disc space-y-1 pl-6">
            {renderNodes(node.children, key)}
          </ul>
        );

      case 'listItem':
        return <li key={key}>{renderNodes(node.children, key)}</li>;

      case 'thematicBreak':
        return <hr key={key} className="my-5 border-[var(--border)]" />;

      case 'break':
        return <br key={key} />;

      case 'link': {
        const rawUrl = (node.url ?? '').trim();
        const label = renderNodes(node.children, key);
        if (isStrictHttpsUrl(rawUrl)) {
          return (
            <a
              key={key}
              href={`https://${rawUrl.slice(8)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--accent)] underline hover:opacity-80"
            >
              {label}
            </a>
          );
        }
        return (
          <span key={key} className="text-[var(--muted)]">
            {label}
          </span>
        );
      }

      case 'image': {
        const src = (node.url ?? '').trim();
        return (
          <div key={key} className="my-3 flex justify-center">
            <MediaImage src={src} alt={node.alt ?? ''} />
          </div>
        );
      }

      case 'table': {
        const rows = node.children ?? [];
        const headerRow = rows[0];
        const bodyRows = rows.slice(1);
        return (
          <div key={key} className="my-4 overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full border-collapse text-left text-sm">
              {headerRow && (
                <thead className="bg-[var(--surface-2)]">
                  <tr>
                    {(headerRow.children ?? []).map((cell, cIdx) => (
                      <th
                        key={`${key}-h-${cIdx}`}
                        className="border-b border-[var(--border)] px-3 py-2 font-semibold"
                      >
                        {renderNodes(cell.children, `${key}-hc-${cIdx}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {bodyRows.map((row, rIdx) => (
                  <tr
                    key={`${key}-r-${rIdx}`}
                    className="border-b border-[var(--border)] last:border-b-0"
                  >
                    {(row.children ?? []).map((cell, cIdx) => (
                      <td key={`${key}-c-${rIdx}-${cIdx}`} className="px-3 py-2">
                        {renderNodes(cell.children, `${key}-cc-${rIdx}-${cIdx}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }

      case 'textDirective':
      case 'leafDirective': {
        const name = (node.name ?? '').toLowerCase();
        const attrs = node.attributes ?? {};

        if (name === 'say') {
          const textToSpeak = extractPlainText(node).trim();
          const sayLang = attrs['lang']?.trim() || pageLang;
          return (
            <SayDirectiveButton
              key={key}
              textToSpeak={textToSpeak}
              sayLang={sayLang}
              pinyinToneColors={pinyinToneColors}
            />
          );
        }

        if (name === 'image') {
          const src = attrs['src']?.trim() ?? '';
          const alt = extractPlainText(node).trim() || attrs['alt']?.trim() || '';
          return (
            <div key={key} data-testid="directive-image" className="my-4 flex justify-center">
              <MediaImage src={src} alt={alt} />
            </div>
          );
        }

        if (name === 'cards') {
          const deckRef = attrs['deck']?.trim() ?? '';
          const tagFilter = attrs['tag']?.trim() || undefined;
          return (
            <InlineCardsWidget
              key={key}
              deckRef={deckRef}
              {...(tagFilter !== undefined ? { tagFilter } : {})}
              onStudyDeck={onStudyDeck}
              previewMode={previewMode}
            />
          );
        }

        if (name === 'deck-link') {
          const deckRef = attrs['deck']?.trim() ?? '';
          const targetDeck = findDeckByRef(state.decks.values(), deckRef);
          const label = extractPlainText(node).trim() || targetDeck?.name || deckRef;
          return (
            <div key={key} className="my-4">
              <button
                type="button"
                data-testid="directive-deck-link"
                disabled={!targetDeck || !onStudyDeck}
                onClick={() => {
                  if (targetDeck && onStudyDeck) {
                    onStudyDeck(targetDeck.id);
                  }
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
              >
                <span>Study Deck: {label}</span>
                <span aria-hidden="true">→</span>
              </button>
            </div>
          );
        }

        // Unknown directive: render children safely as plain inline/block content
        return <span key={key}>{renderNodes(node.children, key)}</span>;
      }

      case 'containerDirective': {
        const name = (node.name ?? '').toLowerCase();
        if (name === 'example') {
          return (
            <ExampleDirectiveBox
              key={key}
              node={node}
              pageLang={pageLang}
              renderChildren={renderNodes}
              pinyinToneColors={pinyinToneColors}
            />
          );
        }
        if (name === 'note') {
          return (
            <aside
              key={key}
              data-testid="directive-note"
              className="my-4 rounded-2xl border border-sky-500/30 bg-sky-500/10 p-4 text-sm text-sky-900 dark:text-sky-100"
            >
              <div className="mb-1 text-xs font-bold uppercase tracking-wider text-sky-700 dark:text-sky-300">
                Note
              </div>
              {renderNodes(node.children, key)}
            </aside>
          );
        }
        if (name === 'warning') {
          return (
            <aside
              key={key}
              data-testid="directive-warning"
              className="my-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-100"
            >
              <div className="mb-1 text-xs font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                Warning
              </div>
              {renderNodes(node.children, key)}
            </aside>
          );
        }
        return (
          <div key={key} className="my-3 rounded-xl border border-[var(--border)] p-3">
            {renderNodes(node.children, key)}
          </div>
        );
      }

      default:
        return node.children ? <div key={key}>{renderNodes(node.children, key)}</div> : null;
    }
  };

  return (
    <article
      data-testid="page-viewer"
      className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
    >
      {!previewMode && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-3">
          <div className="flex items-center gap-2">
            {onBack && (
              <button
                type="button"
                data-testid="page-back-btn"
                onClick={onBack}
                className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface-2)]"
              >
                ← Back
              </button>
            )}
            <span className="rounded-md bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--muted)]">
              {page.lang ?? 'en'}
            </span>
            {isRead && (
              <span
                data-testid="page-read-badge"
                className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300"
              >
                Read ✓
              </span>
            )}
          </div>

          {onEdit && (
            <button
              type="button"
              data-testid="page-edit-btn"
              onClick={() => onEdit(page)}
              className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface-2)]"
            >
              Edit Page
            </button>
          )}
        </header>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        lang={pageLang}
        data-testid="page-content"
        className="max-h-[70vh] overflow-y-auto pr-1 text-sm text-[var(--fg)]"
      >
        {renderNode(ast, 'root')}
      </div>

      {!previewMode && (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
          <div className="flex flex-wrap gap-1.5">
            {page.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] text-[var(--muted)]"
              >
                #{tag}
              </span>
            ))}
          </div>
          <button
            type="button"
            data-testid="mark-page-read-btn"
            disabled={isRead}
            onClick={() => markPageRead(page.id)}
            className={`rounded-xl px-4 py-2 text-xs font-semibold transition-colors ${
              isRead
                ? 'border border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : 'bg-[var(--accent)] text-white hover:opacity-90'
            }`}
          >
            {isRead ? 'Completed ✓' : 'Mark as Read / Done'}
          </button>
        </footer>
      )}
    </article>
  );
}

export default PageViewer;
