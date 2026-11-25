export interface TagsGuidePanelProps {
  /** Called when the reader closes the panel with "Got it". */
  onDismiss: () => void;
  /** Render the heading one level lower (h3) when the panel sits inside another h2 section. */
  nested?: boolean;
}

/**
 * Plain-language "How tags work" help (UX question #3): where tags come from and what they are
 * for. Static text only.
 */
export function TagsGuidePanel({ onDismiss, nested = false }: Readonly<TagsGuidePanelProps>) {
  const Heading = nested ? 'h3' : 'h2';
  return (
    <section
      aria-label="How tags work"
      data-testid="tags-guide"
      className="flex min-w-0 flex-col gap-2 break-words rounded-2xl border border-[var(--accent)] bg-[var(--accent-soft)] p-4 text-sm"
    >
      <Heading className="text-base font-bold">How tags work</Heading>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-xs">
        <li>
          Tags work like categories: a label on a note, such as <code>Grammar</code> or{' '}
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
        <li>Pick a tag in Words to filter the list, or in a Study set to study just those.</li>
        <li>In Manage tags you can rename, merge or delete a tag for every note at once.</li>
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
