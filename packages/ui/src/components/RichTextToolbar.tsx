import { RICH_TEXT_COLORS, type RichTextColor, type RichTextMark } from '@flash/core';

const COLOR_LABELS: Record<RichTextColor, string> = {
  red: 'Red',
  orange: 'Orange',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
};

export interface RichTextToolbarProps {
  fieldKey: string;
  onApply: (mark: RichTextMark) => void;
}

/**
 * Bold / italic / colour buttons for the focused text field. Buttons keep the field's focus and
 * selection (`onMouseDown` prevents the default), and write markup into the plain field string.
 */
export function RichTextToolbar({ fieldKey, onApply }: RichTextToolbarProps) {
  const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();
  const btn =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-1.5 text-xs hover:opacity-90';
  return (
    <div
      role="toolbar"
      aria-label="Text style"
      data-testid={`rich-toolbar-${fieldKey}`}
      className="flex flex-wrap items-center gap-1"
    >
      <button
        type="button"
        title="Bold (Ctrl+B)"
        aria-label="Bold"
        data-testid={`rich-b-${fieldKey}`}
        onMouseDown={keepFocus}
        onClick={() => onApply('b')}
        className={`${btn} font-bold`}
      >
        B
      </button>
      <button
        type="button"
        title="Italic (Ctrl+I)"
        aria-label="Italic"
        data-testid={`rich-i-${fieldKey}`}
        onMouseDown={keepFocus}
        onClick={() => onApply('i')}
        className={`${btn} italic`}
      >
        I
      </button>
      {RICH_TEXT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          title={COLOR_LABELS[color]}
          aria-label={COLOR_LABELS[color]}
          data-testid={`rich-${color}-${fieldKey}`}
          onMouseDown={keepFocus}
          onClick={() => onApply(color)}
          className={btn}
        >
          <span aria-hidden="true" className={`rich-${color} text-sm font-bold`}>
            A
          </span>
        </button>
      ))}
    </div>
  );
}
