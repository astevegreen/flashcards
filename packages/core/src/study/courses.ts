/**
 * Pure Course progress and unlock evaluation per blueprint §2.3 & §15.
 * Evaluates ordered `Course.items` against `state.pages` (`read_at`) and `buildStudyQueue`.
 */

import type { CollectionState } from '../events/replay.ts';
import type { Course } from '../model/types.ts';
import { buildStudyQueue, type StudyCounts } from './queue.ts';

export interface EvaluateCourseOptions {
  nowMs: number;
  tzOffsetMinutes: number;
  dayStartHour?: number;
}

export interface EvaluatedCourseItem {
  index: number;
  kind: 'page' | 'deck';
  ref_id: string;
  title: string;
  missing: boolean;
  /** True when a `deck` item references an archived deck. */
  archived?: boolean;
  unlocked: boolean;
  unlocks_after_page_id?: string;
  prerequisitePageTitle?: string;
  /** True when `unlocks_after_page_id` references a page not present in `state.pages`. */
  prerequisiteMissing?: boolean;
  /** Present for `page` items when the page has been marked read. */
  readAt?: number;
  /** Present for `deck` items. */
  dueCounts?: StudyCounts;
  /** Number of active notes in the deck (present for `deck` items). */
  totalNotes?: number;
  /** Number of active notes in the deck with at least one reviewed card. */
  studiedNotes?: number;
  /** Completed when page is read OR deck has >= 1 note and 0 due/new/learning remaining. */
  completed: boolean;
}

/**
 * Detects circular `unlocks_after_page_id` dependencies among page items in a course.
 * Returns the page ID cycle path (e.g. `['page-a', 'page-b', 'page-a']`) if a cycle exists,
 * or `null` if the prerequisite graph is acyclic.
 */
export function findCoursePrerequisiteCycle(
  items: ReadonlyArray<{
    kind: 'page' | 'deck';
    ref_id: string;
    unlocks_after_page_id?: string;
  }>,
): string[] | null {
  const edges = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.kind !== 'page') continue;
    const from = item.ref_id.trim();
    const to = item.unlocks_after_page_id?.trim() ?? '';
    if (!from || !to) continue;
    let deps = edges.get(from);
    if (!deps) {
      deps = new Set();
      edges.set(from, deps);
    }
    deps.add(to);
  }

  // 0 = unvisited, 1 = visiting (on current DFS stack), 2 = fully explored
  const color = new Map<string, number>();
  const stack: string[] = [];

  const dfs = (node: string): string[] | null => {
    color.set(node, 1);
    stack.push(node);
    const deps = edges.get(node);
    if (deps) {
      for (const next of deps) {
        const nextColor = color.get(next) ?? 0;
        if (nextColor === 1) {
          const cycleStart = stack.indexOf(next);
          return [...stack.slice(cycleStart), next];
        }
        if (nextColor === 0) {
          const found = dfs(next);
          if (found) return found;
        }
      }
    }
    stack.pop();
    color.set(node, 2);
    return null;
  };

  for (const node of edges.keys()) {
    if ((color.get(node) ?? 0) === 0) {
      const cycle = dfs(node);
      if (cycle) return cycle;
    }
  }

  return null;
}

export interface CourseProgress {
  courseId: string;
  name: string;
  description?: string;
  items: EvaluatedCourseItem[];
  totalItems: number;
  completedItems: number;
  unlockedItems: number;
}

export function evaluateCourseProgress(
  state: CollectionState,
  course: Course,
  options: EvaluateCourseOptions,
): CourseProgress {
  const items: EvaluatedCourseItem[] = [];
  let completedItems = 0;
  let unlockedItems = 0;

  for (let i = 0; i < course.items.length; i++) {
    const rawItem = course.items[i];
    if (!rawItem) continue;

    const prereqId = rawItem.unlocks_after_page_id;
    const prereqPage = prereqId ? state.pages.get(prereqId) : undefined;
    const prerequisiteMissing = prereqId !== undefined && !prereqPage;
    const unlocked = !prereqId || prereqPage?.read_at !== undefined;
    if (unlocked) unlockedItems += 1;

    if (rawItem.kind === 'page') {
      const page = state.pages.get(rawItem.ref_id);
      const completed = page?.read_at !== undefined;
      if (completed) completedItems += 1;
      items.push({
        index: i,
        kind: 'page',
        ref_id: rawItem.ref_id,
        title: page?.title ?? rawItem.ref_id,
        missing: !page,
        unlocked,
        ...(prereqId !== undefined ? { unlocks_after_page_id: prereqId } : {}),
        ...(prereqPage?.title !== undefined ? { prerequisitePageTitle: prereqPage.title } : {}),
        ...(prerequisiteMissing ? { prerequisiteMissing: true } : {}),
        ...(page?.read_at !== undefined ? { readAt: page.read_at } : {}),
        completed,
      });
    } else {
      const deck = state.decks.get(rawItem.ref_id);
      if (!deck || deck.archived) {
        items.push({
          index: i,
          kind: 'deck',
          ref_id: rawItem.ref_id,
          title: deck?.name ?? rawItem.ref_id,
          missing: true,
          ...(deck?.archived ? { archived: true } : {}),
          unlocked,
          ...(prereqId !== undefined ? { unlocks_after_page_id: prereqId } : {}),
          ...(prereqPage?.title !== undefined ? { prerequisitePageTitle: prereqPage.title } : {}),
          ...(prerequisiteMissing ? { prerequisiteMissing: true } : {}),
          completed: false,
        });
        continue;
      }

      const queue = buildStudyQueue(state, {
        deckId: deck.id,
        nowMs: options.nowMs,
        tzOffsetMinutes: options.tzOffsetMinutes,
        ...(options.dayStartHour !== undefined ? { dayStartHour: options.dayStartHour } : {}),
      });

      const deckNoteIds = state.noteIdsByDeck.get(deck.id);
      let totalNotes = 0;
      let studiedNotes = 0;
      if (deckNoteIds) {
        for (const nId of deckNoteIds) {
          const n = state.notes.get(nId);
          if (!n || n.archived) continue;
          totalNotes += 1;
          const cardIds = state.cardIdsByNote.get(nId);
          if (cardIds) {
            for (const cId of cardIds) {
              const card = state.cards.get(cId);
              if (card && card.schedule.reps > 0) {
                studiedNotes += 1;
                break;
              }
            }
          }
        }
      }

      const completed = totalNotes > 0 && studiedNotes > 0 && queue.counts.total === 0;
      if (completed) completedItems += 1;

      items.push({
        index: i,
        kind: 'deck',
        ref_id: rawItem.ref_id,
        title: deck.name,
        missing: false,
        unlocked,
        ...(prereqId !== undefined ? { unlocks_after_page_id: prereqId } : {}),
        ...(prereqPage?.title !== undefined ? { prerequisitePageTitle: prereqPage.title } : {}),
        ...(prerequisiteMissing ? { prerequisiteMissing: true } : {}),
        dueCounts: queue.counts,
        totalNotes,
        studiedNotes,
        completed,
      });
    }
  }

  return {
    courseId: course.id,
    name: course.name,
    ...(course.description !== undefined ? { description: course.description } : {}),
    items,
    totalItems: items.length,
    completedItems,
    unlockedItems,
  };
}
