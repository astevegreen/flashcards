import {
  computeCollectionStats,
  MATURE_INTERVAL_DAYS,
  type CollectionStats,
  type CollectionStatsOptions,
  type HeatmapDay,
  type RetentionBucket,
} from '@flash/core/stats';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../state/AppContext.tsx';

/**
 * Phase 11 Stats screen. Lazily loaded (never part of the initial study-screen bundle, §8).
 * Every number comes from `computeCollectionStats` in `@flash/core/stats`, the same module MCP
 * `get_stats` uses, so the screen and the MCP output always agree. Charts are plain inline SVG
 * with native `<title>` tooltips plus text summaries and data tables; no chart library and no
 * raw HTML.
 */

const MATURITY_SEGMENTS = [
  { key: 'new', label: 'New', swatch: 'bg-[#2a78d6] dark:bg-[#3987e5]' },
  { key: 'learning', label: 'Learning', swatch: 'bg-[#eb6834] dark:bg-[#d95926]' },
  { key: 'young', label: 'Young', swatch: 'bg-[#1baf7a] dark:bg-[#199e70]' },
  { key: 'mature', label: 'Mature', swatch: 'bg-[#eda100] dark:bg-[#c98500]' },
] as const;

const HEATMAP_LEVEL_OPACITY = [0, 0.3, 0.5, 0.75, 1] as const;

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0 min';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
}

function formatPercent(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function shortDate(date: string): string {
  // `YYYY-MM-DD` → `MM-DD`, locale-neutral and identical on every device.
  return date.slice(5);
}

function heatLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
}

interface BarDatum {
  key: string;
  value: number;
  title: string;
}

function BarChart({
  data,
  label,
  testId,
  startLabel,
  endLabel,
}: {
  data: readonly BarDatum[];
  label: string;
  testId: string;
  startLabel: string;
  endLabel: string;
}) {
  const width = 300;
  const height = 96;
  const max = Math.max(1, ...data.map((d) => d.value));
  const slot = width / Math.max(1, data.length);
  const barWidth = Math.max(1, slot - 2);
  return (
    <figure className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[10px] tabular-nums text-[var(--muted)]">
        <span>max {max}</span>
      </div>
      <svg
        role="img"
        aria-label={label}
        data-testid={testId}
        viewBox={`0 0 ${width} ${height}`}
        className="h-28 w-full"
        preserveAspectRatio="none"
      >
        <line
          x1={0}
          x2={width}
          y1={height - 0.5}
          y2={height - 0.5}
          style={{ stroke: 'var(--border)' }}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {data.map((d, i) => {
          const h = d.value > 0 ? Math.max(2, (d.value / max) * (height - 4)) : 0;
          return (
            <g key={d.key}>
              {/* Full-height hit target so the native tooltip works on empty days too. */}
              <rect x={i * slot} y={0} width={slot} height={height} fill="transparent">
                <title>{d.title}</title>
              </rect>
              {h > 0 && (
                <rect
                  x={i * slot + (slot - barWidth) / 2}
                  y={height - h}
                  width={barWidth}
                  height={h}
                  rx={Math.min(2, barWidth / 2)}
                  style={{ fill: 'var(--accent)' }}
                  pointerEvents="none"
                />
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="flex justify-between text-[10px] tabular-nums text-[var(--muted)]">
        <span>{startLabel}</span>
        <span>{endLabel}</span>
      </figcaption>
    </figure>
  );
}

function DataTable({
  caption,
  headers,
  rows,
}: {
  caption: string;
  headers: readonly string[];
  rows: ReadonlyArray<readonly (string | number)[]>;
}) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-[var(--muted)] hover:text-[var(--fg)]">
        Show data
      </summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-[var(--border)]">
        <table className="w-full border-collapse text-left tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-[var(--surface-2)]">
            <tr>
              {headers.map((h) => (
                <th key={h} scope="col" className="px-2 py-1 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row[0])} className="border-t border-[var(--border)]">
                {row.map((cell, i) => (
                  <td key={i} className="px-2 py-1">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Card({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      aria-label={title}
      data-testid={testId}
      className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Tile({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
      <dt className="text-[11px] font-medium text-[var(--muted)]">{label}</dt>
      <dd data-testid={testId} className="text-lg font-bold tabular-nums">
        {value}
      </dd>
    </div>
  );
}

function RetentionRow({
  label,
  bucket,
  target,
  testId,
}: {
  label: string;
  bucket: RetentionBucket;
  target: number | null;
  testId: string;
}) {
  const pct = bucket.rate === null ? 0 : bucket.rate * 100;
  const targetPct = target === null ? null : target * 100;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <span data-testid={testId} className="tabular-nums text-[var(--muted)]">
          <span className="font-semibold text-[var(--fg)]">{formatPercent(bucket.rate)}</span>
          {bucket.total > 0 && ` (${bucket.passed}/${bucket.total})`}
        </span>
      </div>
      <div aria-hidden="true" className="relative h-2 rounded-full bg-[var(--surface-2)]">
        {bucket.rate !== null && (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]"
            style={{ width: `${pct}%` }}
          />
        )}
        {targetPct !== null && (
          <div
            className="absolute -inset-y-1 w-0.5 rounded bg-[var(--fg)]"
            style={{ left: `calc(${targetPct}% - 1px)` }}
          />
        )}
      </div>
    </div>
  );
}

function Heatmap({ days, maxCount }: { days: readonly HeatmapDay[]; maxCount: number }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // On narrow screens the year scrolls horizontally; start at today (the right edge).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [days.length]);
  const first = days[0];
  if (!first) return null;
  // Columns are weeks (Sunday first); pad the first column so weekdays line up in rows.
  const lead = first.weekday;
  const cell = 10;
  const gap = 2;
  const weeks = Math.ceil((lead + days.length) / 7);
  const width = weeks * (cell + gap);
  const height = 7 * (cell + gap);
  const studied = days.filter((d) => d.count > 0).length;
  return (
    <figure className="flex flex-col gap-1">
      <div ref={scrollRef} className="overflow-x-auto">
        <svg
          role="img"
          aria-label={`Calendar heatmap: reviews on ${plural(studied, 'day')} of the last ${days.length}`}
          data-testid="stats-heatmap"
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full min-w-[32rem]"
        >
          {days.map((d, i) => {
            const pos = lead + i;
            const level = heatLevel(d.count, maxCount);
            return (
              <rect
                key={d.day}
                data-count={d.count}
                x={Math.floor(pos / 7) * (cell + gap)}
                y={(pos % 7) * (cell + gap)}
                width={cell}
                height={cell}
                rx={2}
                style={{
                  fill: level === 0 ? 'var(--surface-2)' : 'var(--accent)',
                  fillOpacity: level === 0 ? 1 : HEATMAP_LEVEL_OPACITY[level],
                }}
              >
                <title>{`${d.date}: ${plural(d.count, 'review')}`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <figcaption className="flex items-center justify-end gap-1 text-[10px] text-[var(--muted)]">
        <span>Less</span>
        {HEATMAP_LEVEL_OPACITY.map((opacity, level) => (
          <span
            key={level}
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{
              background: level === 0 ? 'var(--surface-2)' : 'var(--accent)',
              opacity: level === 0 ? 1 : opacity,
            }}
          />
        ))}
        <span>More</span>
      </figcaption>
    </figure>
  );
}

function Maturity({ stats }: { stats: CollectionStats }) {
  const m = stats.maturity;
  return (
    <div className="flex flex-col gap-3">
      <div
        aria-hidden="true"
        className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-[var(--surface-2)]"
      >
        {m.total > 0 &&
          MATURITY_SEGMENTS.map((seg) =>
            m[seg.key] > 0 ? (
              <div
                key={seg.key}
                className={seg.swatch}
                style={{ width: `${(m[seg.key] / m.total) * 100}%` }}
              />
            ) : null,
          )}
      </div>
      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {MATURITY_SEGMENTS.map((seg) => (
          <div key={seg.key} className="flex items-center gap-2">
            <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-sm ${seg.swatch}`} />
            <dt className="text-[var(--muted)]">{seg.label}</dt>
            <dd data-testid={`stats-maturity-${seg.key}`} className="font-semibold tabular-nums">
              {m[seg.key]}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] text-[var(--muted)]">
        Mature = in review with an interval of at least {MATURE_INTERVAL_DAYS} days. Relearning
        cards count as learning.
      </p>
    </div>
  );
}

export function StatsScreen() {
  const { state, stateVersion } = useApp();
  const [deckFilter, setDeckFilter] = useState('');

  const decks = useMemo(
    () =>
      [...state.decks.values()]
        .filter((d) => !d.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const selectedDeckId = decks.some((d) => d.id === deckFilter) ? deckFilter : '';

  const stats = useMemo(() => {
    const nowMs = Date.now();
    const options: CollectionStatsOptions = {
      nowMs,
      tzOffsetMinutes: -new Date(nowMs).getTimezoneOffset(),
    };
    if (selectedDeckId) options.filter = { deckIds: [selectedDeckId] };
    return computeCollectionStats(state, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, selectedDeckId]);

  const today = stats.reviewsPerDay.days[stats.reviewsPerDay.days.length - 1];
  const tomorrow = stats.forecast.days[1];
  const rpd = stats.reviewsPerDay;
  const firstDay = rpd.days[0];
  const forecastFirst = stats.forecast.days[0];
  const forecastLast = stats.forecast.days[stats.forecast.days.length - 1];
  const headline =
    stats.retention.mature.rate !== null ? stats.retention.mature : stats.retention.all;

  return (
    <section className="flex flex-col gap-4" data-testid="stats-screen">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Statistics</h1>
          <p className="text-xs text-[var(--muted)]">
            Computed on this device from your review history. Works offline.
          </p>
        </div>
        <select
          aria-label="Filter stats by deck"
          value={selectedDeckId}
          onChange={(e) => setDeckFilter(e.target.value)}
          className="max-w-[16rem] truncate rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none"
        >
          <option value="">All Decks</option>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      {stats.totals.reviews === 0 && (
        <p
          role="status"
          className="rounded-xl bg-[var(--accent-soft)] px-3 py-2 text-xs text-[var(--fg)]"
        >
          No reviews yet. Study a few cards and your progress will show up here.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile
          label="Reviews today"
          value={String(today?.count ?? 0)}
          testId="stats-today-reviews"
        />
        <Tile
          label="Time today"
          value={formatDuration(today?.timeMs ?? 0)}
          testId="stats-today-time"
        />
        <Tile
          label="Current streak"
          value={plural(stats.heatmap.currentStreak, 'day')}
          testId="stats-current-streak"
        />
        <Tile
          label="Longest streak"
          value={plural(stats.heatmap.longestStreak, 'day')}
          testId="stats-longest-streak"
        />
        <Tile
          label={stats.retention.mature.rate !== null ? 'Mature retention' : 'True retention'}
          value={formatPercent(headline.rate)}
          testId="stats-retention-headline"
        />
        <Tile
          label="Due tomorrow"
          value={String(tomorrow?.count ?? 0)}
          testId="stats-due-tomorrow"
        />
      </dl>

      <Card title="Reviews per day" testId="stats-reviews-card">
        <p className="text-xs text-[var(--muted)]" data-testid="stats-reviews-summary">
          {plural(rpd.totalReviews, 'review')} in the last {rpd.days.length} days ·{' '}
          {rpd.averagePerDay.toFixed(1)} per day · {formatDuration(rpd.totalTimeMs)} ·{' '}
          {plural(rpd.daysStudied, 'day')} studied
        </p>
        <BarChart
          label={`Reviews per day for the last ${rpd.days.length} days, ${rpd.totalReviews} in total`}
          testId="stats-reviews-chart"
          data={rpd.days.map((d) => ({
            key: d.date,
            value: d.count,
            title: `${d.date}: ${plural(d.count, 'review')}, ${formatDuration(d.timeMs)}`,
          }))}
          startLabel={firstDay ? shortDate(firstDay.date) : ''}
          endLabel="Today"
        />
        <DataTable
          caption="Reviews per day"
          headers={['Date', 'Reviews', 'Passed', 'Again', 'New', 'Time']}
          rows={[...rpd.days]
            .reverse()
            .map((d) => [d.date, d.count, d.passed, d.again, d.newCards, formatDuration(d.timeMs)])}
        />
      </Card>

      <Card title="True retention" testId="stats-retention-card">
        <p className="text-xs text-[var(--muted)]">
          Share of reviews passed (Hard, Good or Easy) in the last {stats.retention.windowDays}{' '}
          days, for cards that were already in review. Target{' '}
          <span data-testid="stats-retention-target" className="font-semibold text-[var(--fg)]">
            {formatPercent(stats.retention.target)}
          </span>
          .
        </p>
        <RetentionRow
          label="Mature"
          bucket={stats.retention.mature}
          target={stats.retention.target}
          testId="stats-retention-mature"
        />
        <RetentionRow
          label="Young"
          bucket={stats.retention.young}
          target={stats.retention.target}
          testId="stats-retention-young"
        />
        <RetentionRow
          label="All review cards"
          bucket={stats.retention.all}
          target={stats.retention.target}
          testId="stats-retention-all"
        />
      </Card>

      <Card title="Due forecast" testId="stats-forecast-card">
        <p className="text-xs text-[var(--muted)]" data-testid="stats-forecast-summary">
          {plural(stats.forecast.total, 'card')} due in the next {stats.forecast.days.length} days
          {stats.forecast.overdue > 0 && ` · ${stats.forecast.overdue} overdue (shown today)`}
        </p>
        <BarChart
          label={`Cards due per day for the next ${stats.forecast.days.length} days, ${stats.forecast.total} in total`}
          testId="stats-forecast-chart"
          data={stats.forecast.days.map((d) => ({
            key: d.date,
            value: d.count,
            title: `${d.offset === 0 ? 'Today' : d.date}: ${plural(d.count, 'card')} (${d.review} review, ${d.learning} learning)`,
          }))}
          startLabel={forecastFirst ? 'Today' : ''}
          endLabel={forecastLast ? shortDate(forecastLast.date) : ''}
        />
        <DataTable
          caption="Due forecast"
          headers={['Date', 'Due', 'Review', 'Learning']}
          rows={stats.forecast.days.map((d) => [d.date, d.count, d.review, d.learning])}
        />
      </Card>

      <Card title="Calendar" testId="stats-calendar-card">
        <p className="text-xs text-[var(--muted)]">
          {plural(stats.heatmap.totalDaysStudied, 'day')} studied · current streak{' '}
          {plural(stats.heatmap.currentStreak, 'day')} · longest{' '}
          {plural(stats.heatmap.longestStreak, 'day')}
        </p>
        <Heatmap days={stats.heatmap.days} maxCount={stats.heatmap.maxCount} />
      </Card>

      <Card title="Card maturity" testId="stats-maturity-card">
        <Maturity stats={stats} />
      </Card>
    </section>
  );
}

export default StatsScreen;
