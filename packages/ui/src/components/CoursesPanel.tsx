import {
  compareCodeUnits,
  evaluateCourseProgress,
  findCoursePrerequisiteCycle,
  uuidv7,
  type Course,
  type Deck,
  type Page,
} from '@flash/core';
import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useApp } from '../state/AppContext.tsx';

export interface CoursesPanelProps {
  onOpenPage: (pageId: string) => void;
  onStudyDeck: (deckId: string) => void;
  /** Exports one course (with its decks and pages) as a `.flashpkg`. */
  onExportCourse?: (course: Course) => void;
}

interface DraftCourseItem {
  uid: string;
  kind: 'page' | 'deck';
  ref_id: string;
  unlocks_after_page_id: string;
}

type CourseEditorMode = { kind: 'create' } | { kind: 'edit'; courseId: string } | null;

interface CourseEditorFormProps {
  mode: 'create' | 'edit';
  initialCourse?: Course;
  pages: readonly Page[];
  decks: readonly Deck[];
  archivedDeckNames: ReadonlyMap<string, string>;
  onSave: (course: Course) => void;
  onCancel: () => void;
}

function CourseEditorForm({
  mode,
  initialCourse,
  pages,
  decks,
  archivedDeckNames,
  onSave,
  onCancel,
}: CourseEditorFormProps) {
  const formId = useId();
  const titleInputRef = useRef<HTMLInputElement>(null);

  const [courseName, setCourseName] = useState(() => initialCourse?.name ?? '');
  const [courseDesc, setCourseDesc] = useState(() => initialCourse?.description ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [draftItems, setDraftItems] = useState<DraftCourseItem[]>(() =>
    (initialCourse?.items ?? []).map((item) => ({
      uid: uuidv7(),
      kind: item.kind,
      ref_id: item.ref_id,
      unlocks_after_page_id: item.unlocks_after_page_id ?? '',
    })),
  );

  const pageIds = useMemo(() => new Set(pages.map((p) => p.id)), [pages]);
  const deckIds = useMemo(() => new Set(decks.map((d) => d.id)), [decks]);

  const handleAddItem = (kind: 'page' | 'deck') => {
    setItemsError(null);
    if (kind === 'page') {
      const usedPageIds = new Set(
        draftItems.filter((item) => item.kind === 'page').map((item) => item.ref_id),
      );
      const nextPage = pages.find((p) => !usedPageIds.has(p.id)) ?? pages[0];
      if (!nextPage) return;
      setDraftItems((prev) => [
        ...prev,
        { uid: uuidv7(), kind: 'page', ref_id: nextPage.id, unlocks_after_page_id: '' },
      ]);
      return;
    }

    const usedDeckIds = new Set(
      draftItems.filter((item) => item.kind === 'deck').map((item) => item.ref_id),
    );
    const nextDeck = decks.find((d) => !usedDeckIds.has(d.id)) ?? decks[0];
    if (!nextDeck) return;
    setDraftItems((prev) => [
      ...prev,
      { uid: uuidv7(), kind: 'deck', ref_id: nextDeck.id, unlocks_after_page_id: '' },
    ]);
  };

  const handleUpdateRef = (uid: string, nextRefId: string) => {
    setItemsError(null);
    setDraftItems((prev) =>
      prev.map((item) => {
        if (item.uid !== uid) return item;
        const clearsSelfPrereq = item.kind === 'page' && item.unlocks_after_page_id === nextRefId;
        return {
          ...item,
          ref_id: nextRefId,
          unlocks_after_page_id: clearsSelfPrereq ? '' : item.unlocks_after_page_id,
        };
      }),
    );
  };

  const handleUpdatePrereq = (uid: string, nextPrereqId: string) => {
    setItemsError(null);
    setDraftItems((prev) =>
      prev.map((item) =>
        item.uid === uid ? { ...item, unlocks_after_page_id: nextPrereqId } : item,
      ),
    );
  };

  const handleMoveItem = (index: number, direction: -1 | 1) => {
    setItemsError(null);
    setDraftItems((prev) => {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const next = [...prev];
      const current = next[index];
      const swapped = next[targetIndex];
      if (!current || !swapped) return prev;
      next[index] = swapped;
      next[targetIndex] = current;
      return next;
    });
  };

  const handleRemoveItem = (uid: string) => {
    setItemsError(null);
    setDraftItems((prev) => prev.filter((item) => item.uid !== uid));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = courseName.trim();
    if (!trimmedName) {
      setNameError('Enter a course title.');
      titleInputRef.current?.focus();
      return;
    }

    const trimmedDesc = courseDesc.trim();
    const items: Course['items'] = draftItems
      .filter((item) => item.ref_id.trim().length > 0)
      .map((item) => {
        const prereqId =
          item.unlocks_after_page_id &&
          !(item.kind === 'page' && item.unlocks_after_page_id === item.ref_id)
            ? item.unlocks_after_page_id
            : undefined;
        return {
          kind: item.kind,
          ref_id: item.ref_id,
          ...(prereqId !== undefined ? { unlocks_after_page_id: prereqId } : {}),
        };
      });

    if (findCoursePrerequisiteCycle(items) !== null) {
      setItemsError(
        'Circular prerequisite detected — remove a circular "Unlocks after page" dependency.',
      );
      return;
    }

    onSave({
      id: initialCourse ? initialCourse.id : `course:${uuidv7()}`,
      name: trimmedName,
      ...(trimmedDesc ? { description: trimmedDesc } : {}),
      items,
    });
  };

  const headingId = `${formId}-heading`;
  const titleId = `${formId}-title`;
  const titleErrorId = `${formId}-title-error`;
  const descId = `${formId}-desc`;
  const itemsErrorId = `${formId}-items-error`;

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      aria-labelledby={headingId}
      data-testid="course-editor-form"
      className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
    >
      <h3 id={headingId} className="text-xs font-semibold text-[var(--fg)]">
        {mode === 'edit' ? 'Edit Course' : 'New Course'}
      </h3>

      <div className="flex flex-col gap-1">
        <label htmlFor={titleId} className="text-[11px] font-medium text-[var(--muted)]">
          Course title <span aria-hidden="true">*</span>
        </label>
        <input
          ref={titleInputRef}
          id={titleId}
          name="course_name"
          type="text"
          required
          aria-invalid={nameError !== null}
          aria-describedby={nameError !== null ? titleErrorId : undefined}
          data-testid="course-editor-name"
          placeholder="e.g., JLPT N5 Foundations"
          value={courseName}
          onChange={(e) => {
            setCourseName(e.target.value);
            if (nameError !== null && e.target.value.trim().length > 0) {
              setNameError(null);
            }
          }}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm"
        />
        {nameError !== null && (
          <p id={titleErrorId} role="alert" className="text-xs text-rose-600 dark:text-rose-400">
            {nameError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={descId} className="text-[11px] font-medium text-[var(--muted)]">
          Description (optional)
        </label>
        <input
          id={descId}
          name="course_description"
          type="text"
          data-testid="course-editor-description"
          placeholder="Short description of what this course covers"
          value={courseDesc}
          onChange={(e) => setCourseDesc(e.target.value)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs"
        />
      </div>

      <fieldset
        aria-describedby={itemsError !== null ? itemsErrorId : undefined}
        className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-2.5"
      >
        <legend className="px-1 text-[11px] font-semibold text-[var(--muted)]">
          Ordered items ({draftItems.length})
        </legend>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="course-add-page-btn"
            disabled={pages.length === 0}
            onClick={() => handleAddItem('page')}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface-2)] disabled:opacity-40"
          >
            + Add Page
          </button>
          <button
            type="button"
            data-testid="course-add-deck-btn"
            disabled={decks.length === 0}
            onClick={() => handleAddItem('deck')}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface-2)] disabled:opacity-40"
          >
            + Add Deck
          </button>
        </div>

        {itemsError !== null && (
          <p
            id={itemsErrorId}
            role="alert"
            data-testid="course-editor-items-error"
            className="text-xs text-rose-600 dark:text-rose-400"
          >
            {itemsError}
          </p>
        )}

        {draftItems.length === 0 ? (
          <p className="text-xs text-[var(--muted)]">
            No items yet. Add lesson pages and decks in the order learners should complete them.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {draftItems.map((item, idx) => {
              const refSelectId = `${formId}-ref-${item.uid}`;
              const prereqSelectId = `${formId}-prereq-${item.uid}`;
              const hasMissingRef =
                item.kind === 'page' ? !pageIds.has(item.ref_id) : !deckIds.has(item.ref_id);
              const archivedDeckName =
                item.kind === 'deck' ? archivedDeckNames.get(item.ref_id) : undefined;
              const hasMissingPrereq =
                item.unlocks_after_page_id.length > 0 && !pageIds.has(item.unlocks_after_page_id);
              const availablePrereqPages =
                item.kind === 'page'
                  ? pages.filter((p) => {
                      if (p.id === item.ref_id) return false;
                      if (p.id === item.unlocks_after_page_id) return true;
                      const simulated = draftItems.map((d) =>
                        d.uid === item.uid ? { ...d, unlocks_after_page_id: p.id } : d,
                      );
                      return findCoursePrerequisiteCycle(simulated) === null;
                    })
                  : pages;

              return (
                <li
                  key={item.uid}
                  data-testid={`course-draft-item-${idx}`}
                  className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[11px] text-[var(--muted)]">#{idx + 1}</span>
                      <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[var(--muted)]">
                        {item.kind}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        data-testid={`course-draft-up-${idx}`}
                        aria-label={`Move item ${idx + 1} up`}
                        disabled={idx === 0}
                        onClick={() => handleMoveItem(idx, -1)}
                        className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--surface-2)] disabled:opacity-40"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        data-testid={`course-draft-down-${idx}`}
                        aria-label={`Move item ${idx + 1} down`}
                        disabled={idx === draftItems.length - 1}
                        onClick={() => handleMoveItem(idx, 1)}
                        className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--surface-2)] disabled:opacity-40"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        data-testid={`course-draft-remove-${idx}`}
                        aria-label={`Remove item ${idx + 1}`}
                        onClick={() => handleRemoveItem(item.uid)}
                        className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor={refSelectId}
                        className="text-[11px] font-medium text-[var(--muted)]"
                      >
                        {item.kind === 'page' ? 'Lesson page' : 'Deck'}
                      </label>
                      <select
                        id={refSelectId}
                        name={`item_${idx}_ref`}
                        data-testid={`course-draft-ref-${idx}`}
                        value={item.ref_id}
                        onChange={(e) => handleUpdateRef(item.uid, e.target.value)}
                        className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-xs"
                      >
                        {hasMissingRef && (
                          <option value={item.ref_id}>
                            {archivedDeckName
                              ? `Archived deck: ${archivedDeckName}`
                              : `Missing ${item.kind} (${item.ref_id})`}
                          </option>
                        )}
                        {item.kind === 'page'
                          ? pages.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.title}
                              </option>
                            ))
                          : decks.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.name}
                              </option>
                            ))}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor={prereqSelectId}
                        className="text-[11px] font-medium text-[var(--muted)]"
                      >
                        Unlocks after page
                      </label>
                      <select
                        id={prereqSelectId}
                        name={`item_${idx}_prereq`}
                        data-testid={`course-draft-prereq-${idx}`}
                        value={item.unlocks_after_page_id}
                        onChange={(e) => handleUpdatePrereq(item.uid, e.target.value)}
                        className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-xs"
                      >
                        <option value="">None (unlocked)</option>
                        {hasMissingPrereq && (
                          <option value={item.unlocks_after_page_id}>
                            Missing page ({item.unlocks_after_page_id})
                          </option>
                        )}
                        {availablePrereqPages.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          data-testid="course-save-btn"
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
        >
          {mode === 'edit' ? 'Save Course' : 'Create Course'}
        </button>
        <button
          type="button"
          data-testid="course-cancel-btn"
          onClick={onCancel}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--surface-2)]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function CoursesPanel({ onOpenPage, onStudyDeck, onExportCourse }: CoursesPanelProps) {
  const { state, stateVersion, upsertCourse } = useApp();
  const [editorMode, setEditorMode] = useState<CourseEditorMode>(null);

  const nowMs = Date.now();
  const tzOffsetMinutes = -new Date(nowMs).getTimezoneOffset();

  const pages = useMemo(
    () =>
      [...state.pages.values()].sort(
        (a, b) => compareCodeUnits(a.title, b.title) || compareCodeUnits(a.id, b.id),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const decks = useMemo(
    () =>
      [...state.decks.values()]
        .filter((d) => !d.archived)
        .sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.id, b.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const archivedDeckNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of state.decks.values()) {
      if (d.archived) {
        map.set(d.id, d.name);
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion]);

  const evaluatedCourses = useMemo(
    () =>
      [...state.courses.values()]
        .filter((c) => !c.archived)
        .sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.id, b.id))
        .map((course) => evaluateCourseProgress(state, course, { nowMs, tzOffsetMinutes })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const handleSaveCourse = (course: Course) => {
    upsertCourse(course);
    setEditorMode(null);
  };

  const isCreating = editorMode?.kind === 'create';

  return (
    <section
      data-testid="courses-panel"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Courses</h2>
          <p className="text-xs text-[var(--muted)]">
            Ordered Lesson Pages and Decks with prerequisite unlock tracking.
          </p>
        </div>
        <button
          type="button"
          data-testid="new-course-btn"
          aria-expanded={isCreating}
          onClick={() => setEditorMode(isCreating ? null : { kind: 'create' })}
          className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface-2)]"
        >
          {isCreating ? 'Close' : '+ New Course'}
        </button>
      </div>

      {isCreating && (
        <CourseEditorForm
          key="create"
          mode="create"
          pages={pages}
          decks={decks}
          archivedDeckNames={archivedDeckNames}
          onSave={handleSaveCourse}
          onCancel={() => setEditorMode(null)}
        />
      )}

      {evaluatedCourses.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">No courses yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {evaluatedCourses.map((course) => {
            const isEditing =
              editorMode?.kind === 'edit' && editorMode.courseId === course.courseId;
            const rawCourse = state.courses.get(course.courseId);

            return (
              <div
                key={course.courseId}
                data-testid={`course-card-${course.courseId}`}
                className="flex flex-col gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">{course.name}</h3>
                    {course.description && (
                      <p className="text-xs text-[var(--muted)]">{course.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-xs font-medium text-[var(--muted)]">
                      {course.completedItems} / {course.totalItems} done
                    </span>
                    <button
                      type="button"
                      data-testid={`course-edit-btn-${course.courseId}`}
                      aria-expanded={isEditing}
                      onClick={() =>
                        setEditorMode(
                          isEditing ? null : { kind: 'edit', courseId: course.courseId },
                        )
                      }
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface-2)]"
                    >
                      {isEditing ? 'Close' : 'Edit'}
                    </button>
                    {onExportCourse && rawCourse && (
                      <button
                        type="button"
                        data-testid={`course-export-btn-${course.courseId}`}
                        onClick={() => onExportCourse(rawCourse)}
                        className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface-2)]"
                      >
                        Export
                      </button>
                    )}
                    {rawCourse && (
                      <button
                        type="button"
                        data-testid={`course-delete-btn-${course.courseId}`}
                        onClick={() => {
                          if (
                            typeof window !== 'undefined' &&
                            !window.confirm(
                              `Delete the course "${rawCourse.name}"? Its decks and pages are kept.`,
                            )
                          ) {
                            return;
                          }
                          if (editorMode?.kind === 'edit' && editorMode.courseId === rawCourse.id) {
                            setEditorMode(null);
                          }
                          upsertCourse({ ...rawCourse, archived: true });
                        }}
                        className="rounded-lg border border-red-500/40 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>

                {isEditing && rawCourse ? (
                  <CourseEditorForm
                    key={rawCourse.id}
                    mode="edit"
                    initialCourse={rawCourse}
                    pages={pages}
                    decks={decks}
                    archivedDeckNames={archivedDeckNames}
                    onSave={handleSaveCourse}
                    onCancel={() => setEditorMode(null)}
                  />
                ) : course.items.length === 0 ? (
                  <p className="text-xs text-[var(--muted)]">No items in this course yet.</p>
                ) : (
                  <ol className="flex flex-col gap-2">
                    {course.items.map((item) => (
                      <li
                        key={`${item.kind}-${item.ref_id}-${item.index}`}
                        data-testid={`course-item-${item.kind}-${item.index}`}
                        data-unlocked={item.unlocked ? 'true' : 'false'}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[var(--muted)]">
                              {item.kind}
                            </span>
                            <span className="truncate font-semibold">{item.title}</span>
                            {item.completed && (
                              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                                Done ✓
                              </span>
                            )}
                            {item.missing && (
                              <span
                                data-testid={`course-item-missing-${item.index}`}
                                className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:text-rose-300"
                              >
                                {item.archived
                                  ? 'Archived deck'
                                  : item.kind === 'deck'
                                    ? 'Missing deck'
                                    : 'Missing page'}
                              </span>
                            )}
                            {!item.unlocked && (
                              <span
                                data-testid={`course-item-locked-${item.index}`}
                                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                              >
                                {item.prerequisiteMissing
                                  ? '🔒 Missing prerequisite page'
                                  : `🔒 Unlocks after reading ${item.prerequisitePageTitle ?? 'lesson'}`}
                              </span>
                            )}
                          </div>
                          {item.kind === 'deck' && item.dueCounts && (
                            <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                              {item.totalNotes ?? 0} notes · {item.dueCounts.new} new ·{' '}
                              {item.dueCounts.due} due
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          {!item.unlocked &&
                            item.unlocks_after_page_id &&
                            !item.prerequisiteMissing && (
                              <button
                                type="button"
                                data-testid={`course-read-prereq-${item.index}`}
                                onClick={() => {
                                  if (item.unlocks_after_page_id) {
                                    onOpenPage(item.unlocks_after_page_id);
                                  }
                                }}
                                className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--surface-2)]"
                              >
                                Read Prerequisite
                              </button>
                            )}
                          {item.kind === 'page' ? (
                            <button
                              type="button"
                              data-testid={`course-open-page-${item.index}`}
                              disabled={!item.unlocked || item.missing}
                              onClick={() => onOpenPage(item.ref_id)}
                              className="rounded-lg bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
                            >
                              {item.readAt ? 'Re-read' : 'Read Lesson'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              data-testid={`course-study-deck-${item.index}`}
                              disabled={!item.unlocked || item.missing}
                              onClick={() => onStudyDeck(item.ref_id)}
                              className="rounded-lg bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
                            >
                              Study Deck
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
