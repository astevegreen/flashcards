import {
  applyEvents,
  applyEventsWithDiff,
  applyReviewToSchedule,
  createEmptyState,
  createEventFactory,
  createHlcState,
  FLASH_NAMESPACE_UUID,
  buildRetentionParamsPayload,
  getActiveFsrsParamsVersion,
  getEnabledLayoutsForDeck,
  getTotalAppliedEventCount,
  planLeechBackfill,
  planLeechTag,
  planLeechTagUndo,
  resolveDeckFsrsConfig,
  shouldAutoSuspendLeech,
  uuidv5,
  uuidv7,
  type Card,
  type CollectionPreferences,
  type CollectionState,
  type Course,
  type DeckSettings,
  type EventFactory,
  type FlashEvent,
  type KnownEvent,
  type Layout,
  type Note,
  type NoteTagsAddedPayload,
  type ReviewRating,
  type ReviewRecordedPayload,
  type SyncCursorState,
} from '@flash/core';
import type {
  DeviceMeta,
  EntitlementState,
  PlatformServices,
  SourcesRegistry,
  SyncConfig,
} from '@flash/platform';
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  consumeAddDeviceLinkFromLocation,
  mergeOpenedAddDeviceLink,
  parseAddDeviceDeepLink,
  type AddDeviceLink,
} from '../sync/addDeviceLink.ts';
import { refreshThenRecheckStore } from './entitlementAtLaunch.ts';
import { priorOfMediaEdits } from './mediaEditPrior.ts';
import { createMediaReAddQueue, type MediaReAddQueue } from './mediaReAddQueue.ts';
import { createPersistQueue, type PersistQueue } from './persistQueue.ts';
import { snapshotWriteAllowed } from './rebuildSignal.ts';
import { useAudioController, type AudioController } from './useAudioController.ts';
import { isLeechBackfillReady } from './leechBackfillGate.ts';
import { buildWatermarks, createSyncShell, initialSyncUiState } from './syncShell.ts';
import type { SyncUiState } from './useSyncController.ts';
import { lazyWithRetry } from '../lazy/lazyWithRetry.tsx';
import { retryImport } from '../lazy/retryImport.ts';
import { claimLocalSnapshot, localSnapshotDue } from './localSnapshotCounter.ts';
import { hasLinkedSources } from '../sources/hasLinkedSources.ts';
import { putMediaTracked } from './recentMedia.ts';
import { hasNewerReview, inStudyScope } from './undoGuard.ts';
import type * as SnapshotApi from '@flash/core/snapshot';

export type { AudioController } from './useAudioController.ts';
export type { SyncUiState, SyncUiStatus } from './useSyncController.ts';

export interface UndoEntry {
  reviewId: string;
  cardId: string;
  deckId: string;
  /** The review made the card a leech and auto-suspended it; Undo unsuspends it too. */
  leechSuspended?: boolean;
  /** The review made the card a leech and tagged its note `leech`; Undo removes the tag. */
  leechTagged?: boolean;
  /** The review as recorded, so Redo can record it again after an Undo. */
  review: ReviewRecordedPayload;
  /** The `leech` tag add the review made, re-added by Redo. */
  tagAdd?: NoteTagsAddedPayload;
}

export interface AppContextValue {
  platform: PlatformServices;
  /**
   * The add-device link (provider + collection id, never a secret) this page load was opened
   * with, until this device syncs with that provider. "Sync my devices" preselects its provider.
   */
  addDeviceLink: AddDeviceLink | undefined;
  state: CollectionState;
  stateVersion: number;
  ready: boolean;
  meta: DeviceMeta | null;
  entitlement: EntitlementState;
  refreshEntitlement: () => Promise<EntitlementState>;
  undoStack: readonly UndoEntry[];
  activeDeckId: string | undefined;
  setActiveDeckId: (deckId: string | undefined) => void;
  audio: AudioController;
  syncState: SyncUiState;
  syncNow: () => Promise<void>;
  flushPendingSync: () => void;
  connectGoogleDrive: () => Promise<void>;
  connectDropbox: () => Promise<void>;
  connectOneDrive: () => Promise<void>;
  connectLocalFolder: () => Promise<boolean>;
  reconnectLocalFolder: () => Promise<boolean>;
  connectICloud: () => Promise<void>;
  disconnectSync: () => Promise<void>;
  resolveCollectionChoice: (choice: 'synced' | 'local') => Promise<void>;
  emitEvents: (events: readonly KnownEvent[]) => void;
  getEventFactory: () => EventFactory;
  rateCard: (
    card: Card,
    rating: ReviewRating,
    durationMs: number,
    options?: { typedAnswer?: string },
  ) => void;
  undoLastReview: () => boolean;
  /** Reviews undone in this session that Redo can record again (newest last). */
  redoStack: readonly UndoEntry[];
  /** Records the last undone review again; false when there is nothing to redo. */
  redoLastUndo: () => boolean;
  /** Forgets the study undo history (after a restore changed the collection under it). */
  clearUndoStack: () => void;
  /**
   * Resolves once queued writes and media re-adds have reached storage (call before a reload);
   * rejects while a write failed (`persistFailed`), so a reload never drops unsaved changes.
   */
  whenSaved: () => Promise<void>;
  /** A storage write failed (storage full or blocked): the changes live only in this tab. */
  persistFailed: boolean;
  /** Runs the failed storage writes again. */
  retryPersist: () => void;
  /** Sends only `fields` given, and `tags` only when defined: both replay LWW (D7). */
  updateNote: (note: Note, fields: Record<string, string>, tags?: string[]) => void;
  setNoteArchived: (noteId: string, archived: boolean) => void;
  markNoteReviewed: (note: Note) => void;
  addMedia: (media: {
    hash: string;
    ext: string;
    mime: string;
    size: number;
    bytes: Uint8Array;
    tts_key?: string;
    tts_lang_key?: string;
  }) => Promise<void>;
  upsertLayout: (layout: Layout, enableOnDeckId?: string) => void;
  upsertPage: (input: {
    pageId?: string;
    slug: string;
    title: string;
    markdown: string;
    lang?: string;
    tags: string[];
  }) => string;
  markPageRead: (pageId: string) => void;
  upsertCourse: (course: Course) => void;
  createDeck: (name: string, noteTypeId: string, language: string) => string;
  updateDeckSettings: (
    deckId: string,
    patch: { name?: string; archived?: boolean; settings?: Partial<DeckSettings> },
  ) => void;
  toggleDeckLayout: (deckId: string, layoutId: string) => void;
  /** Re-applies the deck's current FSRS params to every past review (§4.1 explicit reschedule). */
  rescheduleDeck: (deckId: string) => void;
  updatePreferences: (patch: Partial<CollectionPreferences>) => void;
  loadSampleDecks: () => void;
  markBackupCompleted: () => Promise<void>;
  dismissBackupBanner: () => Promise<void>;
  resetLocalData: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

const LazySyncRuntime = lazyWithRetry(
  () => import('./SyncRuntime.tsx').then((m) => ({ default: m.SyncRuntime })),
  { quiet: true },
);

const DEFAULT_PERSONAL_ENTITLEMENT: EntitlementState = {
  unlocked: true,
  source: 'personal_build',
  personalBuild: true,
  productId: 'unlock_full',
};

type SnapshotModule = typeof SnapshotApi;
type SerializedSnapshot = ReturnType<SnapshotModule['serializeCollectionState']>;
let snapshotModule: SnapshotModule | undefined;
const loadSnapshotModule = (): Promise<SnapshotModule> =>
  import('@flash/core/snapshot').then((m) => (snapshotModule = m));

/**
 * Saves a snapshot serialized when its write was queued (D18): the queue has appended exactly the
 * events it holds by the time this runs, so `localSeq` matches it. Skipped when a newer Check
 * rebuild owns the snapshot (rebuildSignal.ts); the counter stays claimed then, since this tab
 * can write no snapshot again until it reloads.
 */
async function saveLocalSnapshot(
  storage: PlatformServices['storage'],
  startedAtMs: number,
  snapshot: SerializedSnapshot,
): Promise<void> {
  if (!(await snapshotWriteAllowed(storage, startedAtMs))) return;
  await storage.setLocalSnapshot({
    snapshot,
    localSeq: await storage.getMaxLocalSeq(),
    savedAt: Date.now(),
  });
}

export interface AppProviderProps {
  platform: PlatformServices;
  initialEvents?: readonly FlashEvent[];
  initialState?: CollectionState;
  initialMeta: DeviceMeta;
  initialSyncConfig?: SyncConfig;
  initialSyncCursor?: SyncCursorState;
  initialOAuthError?: string;
  /** Receives `whenSaved`, so a tab handing the writer lock over saves queued writes first. */
  exposeWhenSaved?: ((whenSaved: () => Promise<void>) => void) | undefined;
  children: ReactNode;
}

export function AppProvider({
  platform,
  initialEvents = [],
  initialState,
  initialMeta,
  initialSyncConfig,
  initialSyncCursor,
  initialOAuthError,
  exposeWhenSaved,
  children,
}: AppProviderProps) {
  // Both refs are set on the first render and only ever replaced (reset, hydrate), never cleared.
  const [bootState] = useState(
    () => initialState ?? applyEvents(createEmptyState(), initialEvents),
  );
  const stateRef = useRef<CollectionState>(bootState);
  const collectionState = stateRef.current;

  const [bootFactory] = useState(() =>
    createEventFactory(initialMeta.deviceId, initialMeta.seq, initialMeta.hlc),
  );
  const factoryRef = useRef<EventFactory>(bootFactory);

  const [stateVersion, setStateVersion] = useState(0);
  const metaRef = useRef<DeviceMeta>(initialMeta);
  const [meta, setMeta] = useState<DeviceMeta>(initialMeta);
  const [entitlement, setEntitlement] = useState<EntitlementState>(DEFAULT_PERSONAL_ENTITLEMENT);
  const entitlementRef = useRef<EntitlementState>(DEFAULT_PERSONAL_ENTITLEMENT);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([]);
  const [activeDeckId, setActiveDeckId] = useState<string | undefined>(undefined);
  const [persistFailed, setPersistFailed] = useState(false);
  const [persistQueue] = useState<PersistQueue>(() =>
    createPersistQueue(() => setPersistFailed(true)),
  );
  // Events applied when the last local snapshot was taken, by a local edit or by a sync (one
  // counter for both, so neither writes a snapshot the other just wrote).
  const lastLocalSnapshotCountRef = useRef<number>(getTotalAppliedEventCount(collectionState));
  // A Check database rebuild saved after this start keeps its snapshot (see rebuildSignal.ts).
  const [startedAtMs] = useState(() => Date.now());

  const refreshEntitlement = useCallback(async (): Promise<EntitlementState> => {
    if (!platform.getPurchase) {
      entitlementRef.current = DEFAULT_PERSONAL_ENTITLEMENT;
      setEntitlement(DEFAULT_PERSONAL_ENTITLEMENT);
      return DEFAULT_PERSONAL_ENTITLEMENT;
    }
    try {
      const purchase = await platform.getPurchase();
      const ent = await purchase.getEntitlement();
      entitlementRef.current = ent;
      setEntitlement(ent);
      return ent;
    } catch {
      return entitlementRef.current;
    }
  }, [platform]);

  useEffect(() => {
    void refreshThenRecheckStore(platform.getPurchase, refreshEntitlement);
  }, [platform, refreshEntitlement]);

  // Phase 14 add-device link (`?sync=<provider>&col=<collection id>`): read and stripped from
  // the address bar once per page load. Its collection id is kept on this device until the first
  // sync confirms the new device reached that collection (it survives the sign-in redirect).
  const [openedAddDeviceLink, setOpenedAddDeviceLink] = useState(consumeAddDeviceLinkFromLocation);
  // Native shells: the OS hands the app a `flashcards://add-device?...` link (a scanned QR code or
  // a tapped link). It goes through the same allow-list and the same join flow as a web link.
  useEffect(() => {
    if (!platform.onAddDeviceUrl) return undefined;
    return platform.onAddDeviceUrl((url) => {
      const link = parseAddDeviceDeepLink(url);
      if (!link) return;
      // The same link again (a double tap, a re-scan) keeps the current object, so nothing re-routes.
      setOpenedAddDeviceLink((prev) => mergeOpenedAddDeviceLink(prev, link));
    });
  }, [platform]);
  useEffect(() => {
    const storage = platform.storage;
    const persist = async (): Promise<void> => {
      const m = await import('../sync/addDeviceExpectation.ts');
      if (openedAddDeviceLink?.collectionId !== undefined) {
        await m.saveAddDeviceExpectation(storage, openedAddDeviceLink);
      } else if (openedAddDeviceLink) {
        await m.clearAddDeviceExpectation(storage);
      } else {
        await m.addDeviceExpectationResource(storage);
      }
    };
    persist().catch(() => {
      // Optional: without it the app just cannot confirm the collection after sign-in.
    });
  }, [openedAddDeviceLink, platform.storage]);

  const enqueuePersist = useCallback(
    (task: () => Promise<void>): Promise<void> => persistQueue.enqueue(task),
    [persistQueue],
  );

  const whenSaved = useCallback(async () => {
    // Re-adds still being planned emit their events first.
    await mediaReAddsRef.current?.flush();
    await persistQueue.whenSaved();
  }, [persistQueue]);
  useEffect(() => exposeWhenSaved?.(whenSaved), [exposeWhenSaved, whenSaved]);

  // Files an edit starts to use are added again (mediaReAdds.ts, lazy). A batch whose chunk failed
  // to load stays queued and is retried on the next edit or sync.
  const mediaReAddsRef = useRef<MediaReAddQueue | null>(null);
  mediaReAddsRef.current ??= createMediaReAddQueue(
    () =>
      retryImport(() => import('./mediaReAdds.ts')).then(
        (m) => (batch) =>
          m.planMediaReAdds(batch.prior, batch.events, stateRef.current, platform.storage),
      ),
    (entries) => {
      const f = factoryRef.current;
      const now = Date.now();
      emitEventsRef.current(entries.map((media) => f.create('MediaAdded', { media }, now)));
    },
  );

  const handleRemoteStateMutated = useCallback((nextMeta?: DeviceMeta) => {
    if (nextMeta) {
      metaRef.current = nextMeta;
      setMeta(nextMeta);
    }
    setStateVersion((v) => v + 1);
    void mediaReAddsRef.current?.flush();
  }, []);

  const handleReplaceState = useCallback((nextState: CollectionState, nextMeta: DeviceMeta) => {
    stateRef.current = nextState;
    metaRef.current = nextMeta;
    lastLocalSnapshotCountRef.current = getTotalAppliedEventCount(nextState);
    setMeta(nextMeta);
    setUndoStack([]);
    setRedoStack([]);
    setStateVersion((v) => v + 1);
  }, []);

  // The sync controller loads after first paint (SyncRuntime); the shell queues for it (P1).
  const [syncState, setSyncState] = useState<SyncUiState>(() =>
    initialSyncUiState(
      initialSyncConfig?.provider ?? (platform.hasDeviceSlug ? 'dev_channel' : 'none'),
      initialMeta,
      initialSyncConfig,
      initialSyncCursor,
      initialOAuthError,
    ),
  );
  const [syncController] = useState(() =>
    createSyncShell(() =>
      buildWatermarks(metaRef.current.deviceId, metaRef.current.seq, initialSyncCursor),
    ),
  );

  const emitEvents = useCallback(
    (events: readonly KnownEvent[]) => {
      if (events.length === 0) return;
      const factory = factoryRef.current;
      const st = stateRef.current;
      // An edit that starts using a file re-adds it right after, so the newer use beats a Check
      // media removal another device decided before this edit synced (mediaReAdds.ts).
      const mediaPrior = priorOfMediaEdits(st, events);
      if (mediaPrior) mediaReAddsRef.current?.add({ prior: mediaPrior, events });
      void mediaReAddsRef.current?.flush();
      applyEventsWithDiff(st, events);
      const nextMeta: DeviceMeta = {
        ...metaRef.current,
        seq: factory.getSeq(),
        hlc: factory.getHlc(),
      };
      metaRef.current = nextMeta;
      setMeta(nextMeta);
      setStateVersion((v) => v + 1);

      let reviewCount = 0;
      for (const ev of events) {
        if (ev.type === 'ReviewRecorded') reviewCount += 1;
      }
      syncController.notifyLocalEvents(events, reviewCount);

      const totalNow = getTotalAppliedEventCount(st);
      let snapshot: SerializedSnapshot | undefined;
      let releaseSnapshot: (() => void) | undefined;
      if (localSnapshotDue(lastLocalSnapshotCountRef, totalNow)) {
        if (snapshotModule) {
          // Serialized now, with the watermarks read now, so a later edit applied before this
          // write runs can't end up in a snapshot whose localSeq predates it (D18).
          snapshot = snapshotModule.serializeCollectionState(
            st,
            syncController.getCurrentWatermarks(),
          );
          releaseSnapshot = claimLocalSnapshot(lastLocalSnapshotCountRef, totalNow);
        } else {
          // The next edit takes the snapshot.
          loadSnapshotModule().catch(() => undefined);
        }
      }

      void enqueuePersist(async () => {
        const storage = platform.storage;
        try {
          if (storage.appendEventsWithMeta) {
            await storage.appendEventsWithMeta(events, nextMeta);
          } else {
            await storage.appendEvents(events);
            await storage.setDeviceMeta(nextMeta);
          }
          if (snapshot) await saveLocalSnapshot(storage, startedAtMs, snapshot);
        } catch (err) {
          releaseSnapshot?.();
          throw err;
        }
      });
    },
    [enqueuePersist, platform.storage, startedAtMs, syncController],
  );

  const retryPersist = useCallback(() => {
    setPersistFailed(false);
    // A write that fails again reports through the queue's callback and shows the alert again.
    persistQueue.retryFailed().catch(() => undefined);
    // Retried writes may hold an older device meta (seq reuse after a reload) or a snapshot older
    // than the local log: the newest of both go last.
    void enqueuePersist(() => platform.storage.setDeviceMeta(metaRef.current));
    loadSnapshotModule()
      .then((m) => {
        const snapshot = m.serializeCollectionState(
          stateRef.current,
          syncController.getCurrentWatermarks(),
        );
        return enqueuePersist(() => saveLocalSnapshot(platform.storage, startedAtMs, snapshot));
      })
      .catch(() => undefined);
  }, [enqueuePersist, persistQueue, platform.storage, startedAtMs, syncController]);

  const getEventFactory = useCallback(() => factoryRef.current, []);
  // Stable, so a sync tick (or any provider render) doesn't hand consumers a new one (P3).
  const clearUndoStack = useCallback(() => {
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  // Leech backfill, once per app launch: cards that reached the leech threshold before leech
  // tagging existed (or on an older build, or through an imported history) get the `leech` tag as
  // set-union events, which converge when several devices backfill concurrently. With a sync
  // provider it waits for a sync that completed during THIS launch (not the stale `synced` status
  // a stored cursor shows at boot), so the plan sees the merged log (an earlier add, or a removal
  // of the tag elsewhere, both skip the note). Leeches that arrive later are picked up at the next
  // launch. Idempotent.
  const [launchedAtMs] = useState(() => Date.now());
  const backfillReady = isLeechBackfillReady(syncState, launchedAtMs);
  const backfillDoneRef = useRef(false);
  const emitEventsRef = useRef(emitEvents);
  emitEventsRef.current = emitEvents;
  // After `emitEventsRef`: SyncRuntime also hosts the launch-time starter-deck upgrade.
  const syncRuntime = (
    <LazySyncRuntime
      emitEventsRef={emitEventsRef}
      shell={syncController}
      platform={platform}
      stateRef={stateRef}
      metaRef={metaRef}
      factoryRef={factoryRef}
      {...(initialSyncConfig !== undefined ? { initialSyncConfig } : {})}
      {...(initialSyncCursor !== undefined ? { initialSyncCursor } : {})}
      enqueuePersist={enqueuePersist}
      lastLocalSnapshotCountRef={lastLocalSnapshotCountRef}
      {...(startedAtMs !== undefined ? { startedAtMs } : {})}
      onStateMutated={handleRemoteStateMutated}
      onReplaceState={handleReplaceState}
      syncState={syncState}
      setSyncState={setSyncState}
    />
  );

  useEffect(() => {
    if (!backfillReady || backfillDoneRef.current) return;
    backfillDoneRef.current = true;
    const plan = planLeechBackfill(stateRef.current);
    if (plan.length === 0) return;
    const factory = factoryRef.current;
    const nowMs = Date.now();
    emitEventsRef.current(plan.map((payload) => factory.create('NoteTagsAdded', payload, nowMs)));
  }, [backfillReady, collectionState]);

  // Deck option presets: after each sync completed in this launch, copy every preset into any
  // member deck that fell behind it (lazy; see library/presetCatchUp.ts). Idempotent.
  const presetCatchUpAt = backfillReady ? syncState.lastSyncedAt : undefined;
  useEffect(() => {
    if (presetCatchUpAt === undefined) return;
    void import('../library/presetCatchUp.ts')
      .then((m) => m.runPresetCatchUp(stateRef.current, factoryRef.current, emitEventsRef.current))
      .catch(() => {});
  }, [presetCatchUpAt]);

  // Non-blocking post-first-paint source check (§3.1 modifiedTime check & §3.2 local folder rescan).
  // Strictly lazy-loads sourceRunner ONLY if linked sources exist so initial bundle stays lean (§8).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const saved = await platform.storage.getKv<SourcesRegistry>('linked_sources_v1');
          if (!hasLinkedSources(saved)) {
            // Decks synced from another device can carry sources Sources never saved here.
            const { hasSyncedLinkedSource } = await import('../sources/hasSyncedLinkedSource.ts');
            if (!hasSyncedLinkedSource(stateRef.current, saved)) return;
          }
          const { refreshAllSources } = await import('../sources/sourceRunner.ts');
          await refreshAllSources(
            {
              platform,
              getState: () => stateRef.current,
              getEventFactory,
              emitEvents,
              entitlement: await refreshEntitlement(),
            },
            { requestFolderPermission: false },
          );
        } catch {
          // Quiet background refresh failure; details surfaced in Library Sources panel
        }
      })();
    }, 50);
    return () => window.clearTimeout(timer);
    // Run once on app open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rateCard = useCallback(
    (card: Card, rating: ReviewRating, durationMs: number, options?: { typedAnswer?: string }) => {
      const factory = factoryRef.current;
      const nowMs = Date.now();
      const tzOffset = -new Date(nowMs).getTimezoneOffset();
      const st = stateRef.current;
      const paramsVersion = getActiveFsrsParamsVersion(st, card.deck_id);
      const fsrsConfig = resolveDeckFsrsConfig(st, card.deck_id, nowMs, paramsVersion);
      const { next, resulting_due_at } = applyReviewToSchedule(
        card.schedule,
        rating,
        nowMs,
        fsrsConfig,
      );
      const reviewId = uuidv7(nowMs);
      const layout = st.layouts.get(card.layout_id);

      const review: ReviewRecordedPayload = {
        review_id: reviewId,
        card_id: card.id,
        rating,
        reviewed_at: nowMs,
        tz_offset: tzOffset,
        duration_ms: Math.max(0, Math.round(durationMs)),
        answer_mode: layout?.answer_mode ?? 'flip',
        ...(options?.typedAnswer !== undefined ? { typed_answer: options.typedAnswer } : {}),
        fsrs_params_version: paramsVersion,
        resulting_due_at,
      };
      const ev = factory.create('ReviewRecorded', review, nowMs);

      // Phase 9 leech auto-suspend (setting, default off): decided once here, logged as an event.
      const events: KnownEvent[] = [ev];
      const leech = shouldAutoSuspendLeech(st, card.id, card.schedule.lapses, next.lapses);
      if (leech) {
        events.push(
          factory.create(
            'CardSuspended',
            { card_id: card.id, reason: 'leech', review_id: reviewId },
            nowMs,
          ),
        );
      }
      // Reaching the leech threshold tags the note `leech` (always, independent of auto-suspend).
      const leechTag = planLeechTag(st, card, card.schedule.lapses, next.lapses);
      if (leechTag) events.push(factory.create('NoteTagsAdded', leechTag, nowMs));
      setUndoStack((prev) => [
        ...prev.slice(-49),
        {
          reviewId,
          cardId: card.id,
          deckId: card.deck_id,
          ...(leech && { leechSuspended: true }),
          ...(leechTag && { leechTagged: true, tagAdd: leechTag }),
          review,
        },
      ]);
      // A new answer ends the redo history, as in any editor.
      setRedoStack([]);
      emitEvents(events);
    },
    [emitEvents],
  );

  const undoLastReview = useCallback((): boolean => {
    const last = undoStack[undoStack.length - 1];
    if (!last || !inStudyScope(last, activeDeckId)) return false;
    if (hasNewerReview(stateRef.current, last)) {
      // A newer answer (synced from another device) stands; this entry can't be undone any more.
      setUndoStack((prev) => prev.slice(0, -1));
      return false;
    }
    const factory = factoryRef.current;
    const nowMs = Date.now();
    const events: KnownEvent[] = [
      factory.create('ReviewUndone', { review_id: last.reviewId }, nowMs),
    ];
    if (last.leechSuspended) {
      events.push(factory.create('CardUnsuspended', { card_id: last.cardId }, nowMs));
    }
    const st = stateRef.current;
    const card = last.leechTagged ? st.cards.get(last.cardId) : undefined;
    const untag = card && planLeechTagUndo(st, card);
    if (untag) events.push(factory.create('NoteUpserted', untag, nowMs));
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev.slice(-49), last]);
    emitEvents(events);
    return true;
  }, [activeDeckId, emitEvents, undoStack]);

  // Redo records the undone review again under a new id, with its original time and answer, so
  // replay gives the card the schedule it had before the Undo. Refused (and dropped) once the card
  // has a newer review, e.g. synced from another device, which the old one would now precede.
  const redoLastUndo = useCallback((): boolean => {
    const last = redoStack[redoStack.length - 1];
    if (!last || !inStudyScope(last, activeDeckId)) return false;
    setRedoStack((prev) => prev.slice(0, -1));
    const st = stateRef.current;
    if (!st.cards.has(last.cardId) || hasNewerReview(st, last)) return false;
    const factory = factoryRef.current;
    const nowMs = Date.now();
    const review: ReviewRecordedPayload = { ...last.review, review_id: uuidv7(nowMs) };
    const events: KnownEvent[] = [factory.create('ReviewRecorded', review, nowMs)];
    if (last.leechSuspended) {
      events.push(
        factory.create(
          'CardSuspended',
          { card_id: last.cardId, reason: 'leech', review_id: review.review_id },
          nowMs,
        ),
      );
    }
    if (last.tagAdd) events.push(factory.create('NoteTagsAdded', last.tagAdd, nowMs));
    setUndoStack((prev) => [...prev.slice(-49), { ...last, reviewId: review.review_id, review }]);
    emitEvents(events);
    return true;
  }, [activeDeckId, emitEvents, redoStack]);

  const updateNote = useCallback(
    (note: Note, fields: Record<string, string>, tags?: string[]) => {
      // The live note, so a deck move or re-key synced while the editor was open isn't undone.
      const live = stateRef.current.notes.get(note.id) ?? note;
      if (!tags && !Object.keys(fields).length && live.provenance.reviewed) return;
      const ev = factoryRef.current.create(
        'NoteUpserted',
        {
          note_id: note.id,
          deck_id: live.deck_id,
          source_key: live.source_key,
          fields,
          ...(tags && { tags }),
          provenance: { ...live.provenance, reviewed: true },
        },
        Date.now(),
      );
      emitEvents([ev]);
    },
    [emitEvents],
  );

  const setNoteArchived = useCallback(
    (noteId: string, archived: boolean) => {
      const factory = factoryRef.current;
      const nowMs = Date.now();
      const ev = archived
        ? factory.create('NoteArchived', { note_id: noteId }, nowMs)
        : factory.create('NoteRestored', { note_id: noteId }, nowMs);
      emitEvents([ev]);
    },
    [emitEvents],
  );

  const markNoteReviewed = useCallback(
    (note: Note) => {
      const factory = factoryRef.current;
      const ev = factory.create(
        'NoteUpserted',
        {
          note_id: note.id,
          deck_id: note.deck_id,
          source_key: note.source_key,
          fields: {},
          provenance: { ...note.provenance, reviewed: true },
        },
        Date.now(),
      );
      emitEvents([ev]);
    },
    [emitEvents],
  );

  const addMedia = useCallback(
    async (media: {
      hash: string;
      ext: string;
      mime: string;
      size: number;
      bytes: Uint8Array;
      tts_key?: string;
      tts_lang_key?: string;
    }) => {
      const normHash = media.hash.toLowerCase();
      await putMediaTracked(platform.storage, {
        hash: normHash,
        mime: media.mime,
        bytes: media.bytes,
      });
      const st = stateRef.current;
      const existing = st.media.get(normHash);
      const needsEvent =
        !existing ||
        (media.tts_key !== undefined && existing.tts_key !== media.tts_key) ||
        (media.tts_lang_key !== undefined && existing.tts_lang_key !== media.tts_lang_key);
      if (needsEvent) {
        const factory = factoryRef.current;
        const ev = factory.create(
          'MediaAdded',
          {
            media: {
              hash: normHash,
              ext: media.ext.toLowerCase(),
              mime: media.mime,
              size: media.size,
              ...(media.tts_key !== undefined ? { tts_key: media.tts_key } : {}),
              ...(media.tts_lang_key !== undefined ? { tts_lang_key: media.tts_lang_key } : {}),
            },
          },
          Date.now(),
        );
        emitEvents([ev]);
      } else {
        setStateVersion((v) => v + 1);
      }
    },
    [emitEvents, platform.storage],
  );

  const audio = useAudioController({
    platform,
    stateRef,
    addMedia,
  });

  const upsertLayout = useCallback(
    (layout: Layout, enableOnDeckId?: string) => {
      const factory = factoryRef.current;
      const st = stateRef.current;
      const nowMs = Date.now();
      const events: KnownEvent[] = [factory.create('LayoutChanged', { layout }, nowMs)];
      if (enableOnDeckId) {
        const deck = st.decks.get(enableOnDeckId);
        if (deck) {
          const currentEnabled = getEnabledLayoutsForDeck(st, deck).map((l) => l.id);
          if (!currentEnabled.includes(layout.id)) {
            events.push(
              factory.create(
                'DeckSettingsChanged',
                {
                  deck_id: enableOnDeckId,
                  settings: { enabled_layout_ids: [...currentEnabled, layout.id] },
                },
                nowMs,
              ),
            );
          }
        }
      }
      emitEvents(events);
    },
    [emitEvents],
  );

  const upsertPage = useCallback(
    (input: {
      pageId?: string;
      slug: string;
      title: string;
      markdown: string;
      lang?: string;
      tags: string[];
    }): string => {
      const factory = factoryRef.current;
      const nowMs = Date.now();
      const cleanSlug =
        input.slug
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af-]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'page';
      const pageId =
        input.pageId ?? uuidv5(FLASH_NAMESPACE_UUID, `page:native:${cleanSlug}:${uuidv7(nowMs)}`);
      const ev = factory.create(
        'PageUpserted',
        {
          page_id: pageId,
          slug: cleanSlug,
          title: input.title.trim() || cleanSlug,
          markdown: input.markdown,
          ...(input.lang ? { lang: input.lang } : {}),
          tags: input.tags,
          source: { kind: 'native', last_synced_at: nowMs },
        },
        nowMs,
      );
      emitEvents([ev]);
      return pageId;
    },
    [emitEvents],
  );

  const markPageRead = useCallback(
    (pageId: string) => {
      const factory = factoryRef.current;
      const nowMs = Date.now();
      const ev = factory.create('PageRead', { page_id: pageId, read_at: nowMs }, nowMs);
      emitEvents([ev]);
    },
    [emitEvents],
  );

  const upsertCourse = useCallback(
    (course: Course) => {
      const factory = factoryRef.current;
      const ev = factory.create('CourseChanged', { course }, Date.now());
      emitEvents([ev]);
    },
    [emitEvents],
  );

  const createDeck = useCallback(
    (name: string, noteTypeId: string, language: string): string => {
      const factory = factoryRef.current;
      const nowMs = Date.now();
      const deckId = uuidv5(FLASH_NAMESPACE_UUID, `${name}:${nowMs}:${uuidv7(nowMs)}`);
      const ev = factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: name.trim(),
          note_type_id: noteTypeId,
          language,
          source: { kind: 'native' },
          created_at: nowMs,
        },
        nowMs,
      );
      emitEvents([ev]);
      return deckId;
    },
    [emitEvents],
  );

  const updateDeckSettings = useCallback(
    (
      deckId: string,
      patch: { name?: string; archived?: boolean; settings?: Partial<DeckSettings> },
    ) => {
      const factory = factoryRef.current;
      const st = stateRef.current;
      const existingDeck = st.decks.get(deckId);
      const nowMs = Date.now();
      const events: KnownEvent[] = [];
      events.push(
        factory.create(
          'DeckSettingsChanged',
          {
            deck_id: deckId,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
            ...(patch.settings !== undefined ? { settings: patch.settings } : {}),
          },
          nowMs,
        ),
      );
      if (
        patch.settings?.target_retention !== undefined &&
        patch.settings.target_retention !== existingDeck?.settings.target_retention
      ) {
        // Keeps optimized weights (Phase 11) when only the target retention changes.
        events.push(
          factory.create(
            'DeckFSRSParamsChanged',
            buildRetentionParamsPayload(st, deckId, patch.settings.target_retention, nowMs),
            nowMs,
          ),
        );
      }
      if (patch.archived === true) {
        setActiveDeckId((prev) => (prev === deckId ? undefined : prev));
      }
      emitEvents(events);
    },
    [emitEvents],
  );

  const toggleDeckLayout = useCallback(
    (deckId: string, layoutId: string) => {
      const st = stateRef.current;
      const deck = st.decks.get(deckId);
      if (!deck) return;
      const currentEnabled = getEnabledLayoutsForDeck(st, deck).map((l) => l.id);
      const hasLayout = currentEnabled.includes(layoutId);
      let nextIds: string[];
      if (hasLayout) {
        if (currentEnabled.length <= 1) return; // Always keep at least 1 layout active
        nextIds = currentEnabled.filter((id) => id !== layoutId);
      } else {
        nextIds = [...currentEnabled, layoutId];
      }
      updateDeckSettings(deckId, { settings: { enabled_layout_ids: nextIds } });
    },
    [updateDeckSettings],
  );

  const rescheduleDeck = useCallback(
    (deckId: string) => {
      const factory = factoryRef.current;
      const st = stateRef.current;
      const deck = st.decks.get(deckId);
      if (!deck) return;
      const nowMs = Date.now();
      const current = resolveDeckFsrsConfig(st, deckId, nowMs);
      const ev = factory.create(
        'DeckFSRSParamsChanged',
        {
          deck_id: deckId,
          params_version: getActiveFsrsParamsVersion(st, deckId) + 1,
          effective_from: nowMs,
          params: { ...current, request_retention: deck.settings.target_retention },
          reschedule_existing: true,
        },
        nowMs,
      );
      emitEvents([ev]);
    },
    [emitEvents],
  );

  const updatePreferences = useCallback(
    (patch: Partial<CollectionPreferences>) => {
      const factory = factoryRef.current;
      const ev = factory.create('PreferencesChanged', { preferences: patch }, Date.now());
      emitEvents([ev]);
    },
    [emitEvents],
  );

  const loadSampleDecks = useCallback(() => {
    void retryImport(() => import('@flash/core/samples'))
      .then(({ buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS }) => {
        const factory = factoryRef.current;
        const events = buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS);
        emitEvents(events);
      })
      .catch((error: unknown) => {
        // Offline before the chunk was cached: nothing is added; the button can be pressed again.
        console.warn('Could not load the sample decks', error);
      });
  }, [emitEvents]);

  const markBackupCompleted = useCallback(async () => {
    const nextMeta: DeviceMeta = {
      ...metaRef.current,
      lastBackupAt: Date.now(),
    };
    metaRef.current = nextMeta;
    setMeta(nextMeta);
    await enqueuePersist(async () => {
      await platform.storage.setDeviceMeta(nextMeta);
    });
  }, [enqueuePersist, platform.storage]);

  const dismissBackupBanner = useCallback(async () => {
    const nextMeta: DeviceMeta = {
      ...metaRef.current,
      backupReminderDismissedAt: Date.now(),
    };
    metaRef.current = nextMeta;
    setMeta(nextMeta);
    await enqueuePersist(async () => {
      await platform.storage.setDeviceMeta(nextMeta);
    });
  }, [enqueuePersist, platform.storage]);

  const resetLocalData = useCallback(async () => {
    const nextDeviceId = platform.hasDeviceSlug
      ? platform.deviceId
      : `web-${uuidv7().slice(0, 12)}`;
    const freshMeta: DeviceMeta = {
      deviceId: nextDeviceId,
      seq: 0,
      hlc: createHlcState(nextDeviceId, 0),
      seeded: true,
    };
    // A reset behaves like a fresh install: onboarding is offered again on the empty collection
    // and no add-device expectation survives. Both modules load first (off the initial bundle,
    // §8), so their caches are dropped before the empty collection renders; clearAll() below
    // wipes the whole key-value store as well.
    const [onboarding, addDevice] = await Promise.all([
      import('../onboarding/onboardingState.ts').catch(() => undefined),
      import('../sync/addDeviceExpectation.ts').catch(() => undefined),
    ]);
    void onboarding?.forgetOnboardingRecord(platform.storage);
    void addDevice?.clearAddDeviceExpectation(platform.storage);
    // The link this page load was opened with is forgotten too (it was read once and stripped).
    setOpenedAddDeviceLink(undefined);
    // Writes that failed before the reset belong to the old collection: never retry them.
    persistQueue.discardFailed();
    setPersistFailed(false);
    metaRef.current = freshMeta;
    stateRef.current = createEmptyState();
    factoryRef.current = createEventFactory(freshMeta.deviceId, 0, freshMeta.hlc);
    lastLocalSnapshotCountRef.current = 0;
    syncController.resetSyncState();
    audio.resetLocalState();
    setMeta(freshMeta);
    setUndoStack([]);
    setRedoStack([]);
    setActiveDeckId(undefined);
    setStateVersion((v) => v + 1);
    await enqueuePersist(async () => {
      await platform.storage.clearAll();
      await platform.storage.setDeviceMeta(freshMeta);
    });
    await refreshEntitlement();
  }, [audio, enqueuePersist, persistQueue, platform, refreshEntitlement, syncController]);

  // Once this device syncs with the link's provider, the link has done its job.
  const addDeviceLink =
    openedAddDeviceLink && syncState.provider !== openedAddDeviceLink.provider
      ? openedAddDeviceLink
      : undefined;

  const value: AppContextValue = {
    platform,
    addDeviceLink,
    state: stateRef.current,
    stateVersion,
    ready: true,
    meta,
    entitlement,
    refreshEntitlement,
    undoStack,
    redoStack,
    clearUndoStack,
    whenSaved,
    persistFailed,
    retryPersist,
    activeDeckId,
    setActiveDeckId,
    audio,
    syncState: syncState,
    syncNow: syncController.syncNow,
    flushPendingSync: syncController.flushPendingSync,
    connectGoogleDrive: syncController.connectGoogleDrive,
    connectDropbox: syncController.connectDropbox,
    connectOneDrive: syncController.connectOneDrive,
    connectLocalFolder: syncController.connectLocalFolder,
    reconnectLocalFolder: syncController.reconnectLocalFolder,
    connectICloud: syncController.connectICloud,
    disconnectSync: syncController.disconnectSync,
    resolveCollectionChoice: syncController.resolveCollectionChoice,
    emitEvents,
    getEventFactory,
    rateCard,
    undoLastReview,
    redoLastUndo,
    updateNote,
    setNoteArchived,
    markNoteReviewed,
    addMedia,
    upsertLayout,
    upsertPage,
    markPageRead,
    upsertCourse,
    createDeck,
    updateDeckSettings,
    toggleDeckLayout,
    rescheduleDeck,
    updatePreferences,
    loadSampleDecks,
    markBackupCompleted,
    dismissBackupBanner,
    resetLocalData,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
      <Suspense fallback={null}>{syncRuntime}</Suspense>
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return ctx;
}
