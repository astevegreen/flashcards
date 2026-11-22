import type { CollectionState } from '../events/replay.ts';
import type { NoteUpsertedPayload } from '../events/types.ts';
import type { Note } from '../model/types.ts';

/**
 * Categories (Phase 9): a category is a note tag. Tags are compared by their {@link tagKey}
 * (Unicode NFC, trimmed, lowercased), so Hangul typed on macOS (which arrives decomposed, NFD)
 * and the same word typed on Windows / Android (NFC) are one category. Every tag this module
 * writes is NFC. `parent::child` is an optional hierarchy: an operation on `parent` also
 * applies to `parent::child`, matching the shared filter model where `parent` matches its
 * children.
 *
 * Everything here is pure: callers turn the returned payloads into one batch of events.
 */

/** Hierarchy separator for categories (`grammar::particles`). */
export const TAG_HIERARCHY_SEPARATOR = '::';

/** NFC + trim. The spelling that gets stored. */
export function normalizeTagText(tag: string): string {
  return tag.normalize('NFC').trim();
}

/** Category identity used for every comparison: NFC, trimmed, lowercased. */
export function tagKey(tag: string): string {
  return normalizeTagText(tag).toLowerCase();
}

/**
 * Normalizes a tag list for storage: NFC + trim each tag, drop empty ones, and keep only the
 * first spelling of tags that share a {@link tagKey} (order preserved).
 */
export function normalizeTagList(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = normalizeTagText(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export type TagNameProblem = 'empty' | 'separator_char' | 'empty_segment';

/**
 * Checks a category name typed by the user. `,` and `;` are rejected because CSV import splits
 * category cells on them (a round trip would split the tag), and every `::` segment must be
 * non-empty.
 */
export function validateTagName(tag: string): TagNameProblem | undefined {
  const t = normalizeTagText(tag);
  if (!t) return 'empty';
  if (/[,;\r\n]/.test(t)) return 'separator_char';
  if (t.split(TAG_HIERARCHY_SEPARATOR).some((seg) => seg.trim().length === 0)) {
    return 'empty_segment';
  }
  return undefined;
}

/** True when `key` is `ancestorKey` itself or one of its `::` descendants (both tag keys). */
export function isTagInSubtree(key: string, ancestorKey: string): boolean {
  return key === ancestorKey || key.startsWith(`${ancestorKey}${TAG_HIERARCHY_SEPARATOR}`);
}

export interface TagSummary {
  /** {@link tagKey} of the category. */
  key: string;
  /** Display spelling: the most used stored spelling (NFC), or the key for implicit parents. */
  label: string;
  /** Active notes tagged with this category or any of its descendants. */
  noteCount: number;
  /** Active notes tagged with exactly this category. */
  directNoteCount: number;
  /**
   * Archived notes tagged with this category or any of its descendants. Rename, merge and
   * delete rewrite them too, so a category only archived notes use is still listed.
   */
  archivedNoteCount: number;
  /** `::` depth (0 for top level). */
  depth: number;
  /** Key of the parent category, when hierarchical. */
  parentKey?: string;
}

export interface TagCollectionSummary {
  tags: TagSummary[];
  /**
   * Notes (archived included) whose stored tags are not in normalized form: NFD text,
   * surrounding spaces or duplicate spellings. {@link planTagOperation} with
   * `{ kind: 'normalize' }` rewrites them.
   */
  unnormalizedNoteCount: number;
}

function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function increment<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sortedNotes(state: CollectionState): Note[] {
  return [...state.notes.values()].sort((a, b) => cmpStr(a.id, b.id));
}

/**
 * Every category in the collection, sorted by key so a parent is directly followed by its
 * children. Counts are for active notes, plus {@link TagSummary.archivedNoteCount}; a category
 * used only by archived notes is listed with `noteCount: 0`. Implicit parents (`grammar` when
 * only `grammar::particles` is used) are listed too.
 */
export function summarizeTags(state: CollectionState): TagCollectionSummary {
  const counts = new Map<string, number>();
  const archivedCounts = new Map<string, number>();
  const direct = new Map<string, number>();
  const spellings: SpellingPool = new Map();
  const archivedSpellings: SpellingPool = new Map();
  let unnormalizedNoteCount = 0;

  for (const note of state.notes.values()) {
    if (!sameList(note.tags, normalizeTagList(note.tags))) unnormalizedNoteCount += 1;
    const { withParents, direct: directKeys } = collectNoteTags(
      note,
      note.archived ? archivedSpellings : spellings,
    );
    if (note.archived) {
      for (const key of withParents) increment(archivedCounts, key);
      continue;
    }
    for (const key of withParents) increment(counts, key);
    for (const key of directKeys) increment(direct, key);
  }

  const keys = new Set([...counts.keys(), ...archivedCounts.keys()]);
  const tags: TagSummary[] = [...keys]
    .map((key) => {
      const parts = key.split(TAG_HIERARCHY_SEPARATOR);
      // Active spellings win; archived ones only label categories no active note uses.
      const pool = (counts.get(key) ?? 0) > 0 ? spellings : archivedSpellings;
      const summary: TagSummary = {
        key,
        label: tagLabel(key, parts.length, pool),
        noteCount: counts.get(key) ?? 0,
        directNoteCount: direct.get(key) ?? 0,
        archivedNoteCount: archivedCounts.get(key) ?? 0,
        depth: parts.length - 1,
      };
      if (parts.length > 1) summary.parentKey = parts.slice(0, -1).join(TAG_HIERARCHY_SEPARATOR);
      return summary;
    })
    .sort((a, b) => cmpStr(a.key, b.key));

  return { tags, unnormalizedNoteCount };
}

/** Category key -> stored spelling -> number of notes using that spelling. */
type SpellingPool = Map<string, Map<string, number>>;

/**
 * One note's category keys: `direct` as stored, `withParents` adding every `::` ancestor. Each
 * direct key's spelling is counted once in `pool`.
 */
function collectNoteTags(
  note: Note,
  pool: SpellingPool,
): { withParents: Set<string>; direct: Set<string> } {
  const withParents = new Set<string>();
  const direct = new Set<string>();
  for (const raw of note.tags) {
    const text = normalizeTagText(raw);
    if (!text) continue;
    const key = text.toLowerCase();
    if (!direct.has(key)) {
      direct.add(key);
      const bySpelling = pool.get(key) ?? new Map<string, number>();
      increment(bySpelling, text);
      pool.set(key, bySpelling);
    }
    const parts = key.split(TAG_HIERARCHY_SEPARATOR);
    for (let i = 1; i <= parts.length; i++) {
      withParents.add(parts.slice(0, i).join(TAG_HIERARCHY_SEPARATOR));
    }
  }
  return { withParents, direct };
}

/**
 * Display label: the most used stored spelling (ties: code-unit order). An implicit parent keeps
 * the stored spelling of its segments from a child when one exists, else its key.
 */
function tagLabel(key: string, depth: number, pool: SpellingPool): string {
  let label = key;
  let best = -1;
  for (const [spelling, n] of pool.get(key) ?? []) {
    if (n > best || (n === best && cmpStr(spelling, label) < 0)) {
      label = spelling;
      best = n;
    }
  }
  if (best >= 0) return label;
  const child = [...pool.entries()].find(([k]) => isTagInSubtree(k, key));
  const childSpelling = child ? [...child[1].keys()].sort(cmpStr)[0] : undefined;
  if (!childSpelling) return label;
  return childSpelling.split(TAG_HIERARCHY_SEPARATOR).slice(0, depth).join(TAG_HIERARCHY_SEPARATOR);
}

export type TagOperation =
  /** Rename one category (and its `::` descendants). Renaming onto an existing category merges. */
  | { kind: 'rename'; from: string; to: string }
  /** Merge several categories (and their descendants) into one. */
  | { kind: 'merge'; from: readonly string[]; into: string }
  /** Remove categories (and their descendants) from every note. */
  | { kind: 'delete'; tags: readonly string[] }
  /** Rewrite every note whose tags are not normalized (NFD, spaces, duplicate spellings). */
  | { kind: 'normalize' };

export type TagOperationError =
  | { code: 'invalid_name'; problem: TagNameProblem }
  | { code: 'no_source' }
  /**
   * The target and a source are in one another's `::` subtree (`a` -> `a::b`, `a::b` -> `a`).
   * Such a rewrite could produce tags that are still inside the source, so it would not be
   * idempotent. A pure respelling (`Grammar` -> `grammar`) is allowed.
   */
  | { code: 'target_overlaps_source'; source: string };

export interface TagOperationPlan {
  /** One `NoteUpserted` per changed note (tags only, `fields: {}`), sorted by note id. */
  payloads: NoteUpsertedPayload[];
  error?: TagOperationError;
}

function tagOnlyPayload(note: Note, tags: string[]): NoteUpsertedPayload {
  return {
    note_id: note.id,
    deck_id: note.deck_id,
    source_key: note.source_key,
    fields: {},
    tags,
  };
}

/**
 * Rewrites one stored tag under a rename: `from::x` -> `to::x`, keeping the stored spelling of
 * the descendant segments. Returns `undefined` when the tag is outside `fromKey`'s subtree.
 */
function renameTag(raw: string, fromKey: string, to: string): string | undefined {
  const text = normalizeTagText(raw);
  if (!isTagInSubtree(text.toLowerCase(), fromKey)) return undefined;
  const depth = fromKey.split(TAG_HIERARCHY_SEPARATOR).length;
  const rest = text.split(TAG_HIERARCHY_SEPARATOR).slice(depth);
  return [to, ...rest].join(TAG_HIERARCHY_SEPARATOR);
}

/**
 * Plans a collection-wide category operation as tag-only `NoteUpserted` payloads (the UI
 * appends them as one batch). Archived notes are included so a restored note doesn't bring a
 * renamed or deleted category back. Notes the operation doesn't touch are left out, and the
 * plan is idempotent: running it again on the resulting state yields no payloads.
 */
export function planTagOperation(state: CollectionState, op: TagOperation): TagOperationPlan {
  if (op.kind === 'normalize') return planNormalize(state);

  const sources = [
    ...new Set(
      operationSources(op)
        .map(tagKey)
        .filter((k) => k.length > 0),
    ),
  ].sort(cmpStr);
  if (sources.length === 0) return { payloads: [], error: { code: 'no_source' } };

  const resolved = op.kind === 'delete' ? { target: undefined } : resolveTarget(op, sources);
  if ('error' in resolved) return { payloads: [], error: resolved.error };

  // Deepest source first so `a::b` wins over `a` for a tag inside both subtrees.
  const bySpecificity = [...sources].sort(
    (a, b) =>
      b.split(TAG_HIERARCHY_SEPARATOR).length - a.split(TAG_HIERARCHY_SEPARATOR).length ||
      cmpStr(a, b),
  );

  const payloads: NoteUpsertedPayload[] = [];
  for (const note of sortedNotes(state)) {
    const next = rewriteNoteTags(note, bySpecificity, resolved.target);
    if (next === undefined) continue;
    const normalized = normalizeTagList(next);
    if (!sameList(note.tags, normalized)) payloads.push(tagOnlyPayload(note, normalized));
  }
  return { payloads };
}

function planNormalize(state: CollectionState): TagOperationPlan {
  const payloads: NoteUpsertedPayload[] = [];
  for (const note of sortedNotes(state)) {
    const next = normalizeTagList(note.tags);
    if (!sameList(note.tags, next)) payloads.push(tagOnlyPayload(note, next));
  }
  return { payloads };
}

function operationSources(op: Exclude<TagOperation, { kind: 'normalize' }>): readonly string[] {
  if (op.kind === 'rename') return [op.from];
  return op.kind === 'merge' ? op.from : op.tags;
}

/** The normalized rename / merge target, or why it can't be used. */
function resolveTarget(
  op: Extract<TagOperation, { kind: 'rename' | 'merge' }>,
  sources: readonly string[],
): { target: string } | { error: TagOperationError } {
  const raw = op.kind === 'rename' ? op.to : op.into;
  const problem = validateTagName(raw);
  if (problem) return { error: { code: 'invalid_name', problem } };
  const target = normalizeTagText(raw)
    .split(TAG_HIERARCHY_SEPARATOR)
    .map((s) => s.trim())
    .join(TAG_HIERARCHY_SEPARATOR);
  const targetKey = target.toLowerCase();
  const overlapping = sources.find(
    (source) =>
      targetKey !== source &&
      (isTagInSubtree(targetKey, source) || isTagInSubtree(source, targetKey)),
  );
  if (overlapping !== undefined) {
    return { error: { code: 'target_overlaps_source', source: overlapping } };
  }
  return { target };
}

/**
 * A note's tags with every tag inside a source subtree renamed onto `target` (or removed when
 * `target` is `undefined`); `undefined` when no tag of the note is inside a source.
 */
function rewriteNoteTags(
  note: Note,
  bySpecificity: readonly string[],
  target: string | undefined,
): string[] | undefined {
  let touched = false;
  const next: string[] = [];
  for (const raw of note.tags) {
    const key = tagKey(raw);
    const source = bySpecificity.find((s) => isTagInSubtree(key, s));
    if (source === undefined) {
      next.push(raw);
      continue;
    }
    touched = true;
    if (target === undefined) continue; // delete
    const renamed = renameTag(raw, source, target);
    if (renamed !== undefined) next.push(renamed);
  }
  return touched ? next : undefined;
}
