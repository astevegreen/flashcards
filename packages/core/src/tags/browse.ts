import type { CollectionState } from '../events/replay.ts';
import { filterNoteIds, type CardFilter, type CardFilterContext } from '../study/filter.ts';

/**
 * Note ids Browse shows for a filter. Same as {@link filterNoteIds}, plus one Browse rule: the
 * "Due today" state means cards Study would show today, so suspended cards never count as due
 * (unless the filter also asks for suspended cards).
 */
export function filterBrowseNoteIds(
  state: CollectionState,
  filter: CardFilter,
  ctx: CardFilterContext,
  options: { archived?: boolean } = {},
): Set<string> {
  const states = filter.states ?? [];
  const excludeSuspended =
    ctx.excludeSuspended === true || (states.includes('due') && !states.includes('suspended'));
  return filterNoteIds(
    state,
    filter,
    excludeSuspended ? { ...ctx, excludeSuspended } : ctx,
    options,
  );
}
