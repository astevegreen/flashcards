export interface TagsGuidePanelProps {
  /** Called when the reader closes the panel with "Got it". */
  onDismiss: () => void;
}

/**
 * Plain-language "How tags work" help (UX question #3). The app calls a note's tags its
 * categories; this explains where they come from and what they are for. Static text only.
 */
export function TagsGuidePanel({ onDismiss }: Readonly<TagsGuidePanelProps>) {
  return (
    <section
      aria-label="How tags work"
      data-testid="tags-guide"
      className="flex flex-col gap-2 rounded-2xl border border-[var(--accent)] bg-[var(--accent-soft)] p-4 text-sm"
    >
      <h2 className="text-base font-bold">How tags work</h2>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-xs">
        <li>
          A tag is a note&apos;s <strong>category</strong>, such as <code>Grammar</code> or{' '}
          <code>Food</code>. A note can have several.
        </li>
        <li>
          Use <code>::</code> to nest them: <code>Grammar::Particles</code> sits inside{' '}
          <code>Grammar</code>.
        </li>
        <li>
          When you bring in cards, columns named Category 1, Category 2 and so on, or Tags, become
          tags.
        </li>
        <li>
          Pick a category in Browse to filter the list, or in a Study set to study just those.
        </li>
        <li>
          In Manage categories you can rename, merge or delete a category for every note at once.
        </li>
      </ul>
      <div>
        <button
          type="button"
          data-testid="tags-guide-dismiss"
          onClick={onDismiss}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--fg)] hover:opacity-90"
        >
          Got it
        </button>
      </div>
    </section>
  );
}
