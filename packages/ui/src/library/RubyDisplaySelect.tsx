import type { RubyDisplay } from '@flash/core';

const RUBY_DISPLAY_OPTIONS: ReadonlyArray<{ value: RubyDisplay; label: string }> = [
  { value: 'both', label: 'Base + reading' },
  { value: 'readings', label: 'Readings only' },
  { value: 'bases', label: 'Bases only' },
];

/** The per-layout ruby flag selector, shared by "Add layout" and the existing-layout list. */
export function RubyDisplaySelect({
  value,
  onChange,
  label = 'Ruby shows',
  testId,
}: Readonly<{
  value: RubyDisplay;
  onChange: (next: RubyDisplay) => void;
  label?: string;
  testId?: string;
}>) {
  return (
    <select
      aria-label={label}
      {...(testId ? { 'data-testid': testId } : {})}
      value={value}
      onChange={(e) => onChange(e.target.value as RubyDisplay)}
      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
    >
      {RUBY_DISPLAY_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
