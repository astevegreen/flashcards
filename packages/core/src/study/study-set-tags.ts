import type { CollectionState } from '../events/replay.ts';
import type { StudySetSavedPayload } from '../events/types.ts';
import {
  resolveTagOperation,
  rewriteTagsForOperation,
  tagKey,
  type ResolvedTagOperation,
  type TagOperation,
} from '../tags/index.ts';
import { listStudySets } from './custom-study.ts';
import { type CardFilter, type CategoryCriterion } from './filter.ts';
import { normalizeCardFilter } from './filter-normalize.ts';

/**
 * Phase 9: a collection-wide category rename, merge or delete (the tag manager) also rewrites the
 * category criterion of every saved Study Set that references it, so `#grammar` renamed to
 * `#문법` keeps studying the same notes.
 *
 * The rewrite is expressed as ordinary events: one filter-only `StudySetSaved` per changed set,
 * marked `tag_rewrite`, appended in the same batch as the tag-only `NoteUpserted` events. Each
 * field of a Study Set is its own HLC last-writer-wins register (see `listStudySets`), so the
 * result is the same under any delivery order, and a concurrent rename of the set's name or mode
 * survives. The marker keeps the rewrite from counting as a save for liveness, so a set another
 * device deleted concurrently stays deleted instead of coming back.
 *
 * Category matching follows the filter model: `a` also covers `a::b`, and so does a rename or
 * delete of `a`. A delete only drops a category when that can't make the set match more cards:
 * always for `none`, for `any` while another category remains. In an `all` criterion, or as the
 * last category of `any`, the deleted category is kept (the set then matches nothing, as it does
 * right after the delete) rather than silently widening to every card.
 */

function deleteWidensSelection(criterion: CategoryCriterion, nextTags: readonly string[]): boolean {
  if (criterion.mode === 'none') return false;
  return criterion.mode === 'all' || nextTags.length === 0;
}

/**
 * The filter with its category criterion rewritten by `op`, or `undefined` when the operation
 * doesn't change it (no category inside a source, or a delete that would widen the set).
 */
export function rewriteStudySetFilter(
  filter: CardFilter,
  op: ResolvedTagOperation,
): CardFilter | undefined {
  const criterion = filter.categories;
  if (!criterion) return undefined;
  const rewritten = rewriteTagsForOperation(criterion.tags, op);
  if (rewritten === undefined) return undefined;
  const nextTags = rewritten.map(tagKey).filter((k) => k.length > 0);
  if (op.target === undefined && deleteWidensSelection(criterion, nextTags)) return undefined;
  const current = normalizeCardFilter(filter);
  const next = normalizeCardFilter({ ...current, categories: { ...criterion, tags: nextTags } });
  return JSON.stringify(next) === JSON.stringify(current) ? undefined : next;
}

/**
 * Filter-only `StudySetSaved` payloads for every live Study Set the tag operation changes, in
 * `listStudySets` order. Empty for `normalize` (filters already store normalized keys) and for an
 * operation `planTagOperation` would refuse. Idempotent: planning again on the resulting state
 * yields nothing.
 */
export function planStudySetTagRewrites(
  state: CollectionState,
  op: TagOperation,
): StudySetSavedPayload[] {
  if (op.kind === 'normalize') return [];
  const resolved = resolveTagOperation(op);
  if ('error' in resolved) return [];
  const out: StudySetSavedPayload[] = [];
  for (const set of listStudySets(state)) {
    const filter = rewriteStudySetFilter(set.filter, resolved);
    if (filter) out.push({ set_id: set.id, filter, tag_rewrite: true });
  }
  return out;
}
