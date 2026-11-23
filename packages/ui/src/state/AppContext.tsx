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
  type ReviewRating,
  type SyncCursorState,
} from '@flash/core';
import type {
  DeviceMeta,
  EntitlementState,
  MaterializedCardRow,
  PlatformServices,
  SourcesRegistry,
  SyncConfig,
} from '@flash/platform';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import { SECURE_KEYS_LOST_KV_KEY } from './secureKeysNotice.ts';
import { priorOfMediaEdits } from './mediaEditPrior.ts';
import { createMediaReAddQueue, type MediaReAddQueue } from './mediaReAddQueue.ts';
import { snapshotWriteAllowed } from './rebuildSignal.ts';
import { useAudioController, type AudioController } from './useAudioController.ts';
import { isLeechBackfillReady } from './leechBackfillGate.ts';
import { useSyncController, type SyncUiState } from './useSyncController.ts';
import { retryImport } from '../lazy/retryImport.ts';

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
  showBackupBanner: boolean;
  /** The secure key for sign-ins was lost (native shells): explain once why to sign in again. */
  secureKeysLostNotice: boolean;
  dismissSecureKeysLostNotice: () => void;
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
  /** Forgets the study undo history (after a restore changed the collection under it). */
  clearUndoStack: () => void;
  /** Resolves once every queued write has reached storage (call before a reload). */
  whenSaved: () => Promise<void>;
  updateNote: (note: Note, fields: Record<string, string>, tags: string[]) => void;
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

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const LOCAL_SNAPSHOT_INTERVAL = 200;

const DEFAULT_PERSONAL_ENTITLEMENT: EntitlementState = {
  unlocked: true,
  source: 'personal_build',
  personalBuild: true,
  productId: 'unlock_full',
};

function cardToRow(card: Card): MaterializedCardRow {
  return {
    id: card.id,
    deck_id: card.deck_id,
    note_id: card.note_id,
    layout_id: card.layout_id,
    due: card.schedule.due,
    schedule: card.schedule,
  };
}

export interface AppProviderProps {
  platform: PlatformServices;
  initialEvents?: readonly FlashEvent[];
  initialState?: CollectionState;
  initialMeta: DeviceMeta;
  initialSyncConfig?: SyncConfig;
  initialSyncCursor?: SyncCursorState;
  initialOAuthError?: string;
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
  children,
}: AppProviderProps) {
  const stateRef = useRef<CollectionState | null>(null);
  if (stateRef.current === null) {
    stateRef.current = initialState ?? applyEvents(createEmptyState(), initialEvents);
  }
  const collectionState = stateRef.current;

  const factoryRef = useRef<EventFactory | null>(null);
  if (factoryRef.current === null) {
    factoryRef.current = createEventFactory(initialMeta.deviceId, initialMeta.seq, initialMeta.hlc);
  }
  const eventFactory = factoryRef.current;

  const [stateVersion, setStateVersion] = useState(0);
  const metaRef = useRef<DeviceMeta>(initialMeta);
  const [meta, setMeta] = useState<DeviceMeta>(initialMeta);
  const [entitlement, setEntitlement] = useState<EntitlementState>(DEFAULT_PERSONAL_ENTITLEMENT);
  const entitlementRef = useRef<EntitlementState>(DEFAULT_PERSONAL_ENTITLEMENT);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [activeDeckId, setActiveDeckId] = useState<string | undefined>(undefined);
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const persistPendingRef = useRef(0);
  const lastLocalSnapEventsRef = useRef<number>(getTotalAppliedEventCount(collectionState));
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
    void refreshEntitlement();
  }, [refreshEntitlement]);

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

  const enqueuePersist = useCallback((task: () => Promise<void>): Promise<void> => {
    const invoke = (): Promise<void> => {
      try {
        return task();
      } catch (err) {
        return Promise.reject(err);
      }
    };
    const started =
      persistPendingRef.current === 0 ? invoke() : persistChainRef.current.then(invoke, invoke);
    persistPendingRef.current += 1;
    const next = started
      .catch((err) => {
        console.error('Failed to persist to storage:', err);
      })
      .finally(() => {
        persistPendingRef.current -= 1;
      });
    persistChainRef.current = next;
    return next;
  }, []);

  const whenSaved = useCallback(async () => {
    while (persistPendingRef.current > 0) {
      // A write queued while waiting extends the chain: wait for that one too.
      await persistChainRef.current; // NOSONAR (S9382)
    }
  }, []);

  // Files an edit starts to use are added again (mediaReAdds.ts, lazy). A batch whose chunk failed
  // to load stays queued and is retried on the next edit or sync.
  const mediaReAddsRef = useRef<MediaReAddQueue | null>(null);
  mediaReAddsRef.current ??= createMediaReAddQueue(
    () =>
      retryImport(() => import('./mediaReAdds.ts')).then(
        (m) => (batch) =>
          m.planMediaReAdds(
            batch.prior,
            batch.events,
            stateRef.current ?? collectionState,
            platform.storage,
          ),
      ),
    (entries) => {
      const f = factoryRef.current ?? eventFactory;
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
    lastLocalSnapEventsRef.current = getTotalAppliedEventCount(nextState);
    setMeta(nextMeta);
    setUndoStack([]);
    setStateVersion((v) => v + 1);
  }, []);

  const syncController = useSyncController({
    platform,
    stateRef: stateRef as React.MutableRefObject<CollectionState>,
    metaRef,
    factoryRef: factoryRef as React.MutableRefObject<EventFactory>,
    ...(initialSyncConfig !== undefined ? { initialSyncConfig } : {}),
    ...(initialSyncCursor !== undefined ? { initialSyncCursor } : {}),
    ...(initialOAuthError !== undefined ? { initialOAuthError } : {}),
    enqueuePersist,
    startedAtMs,
    onStateMutated: handleRemoteStateMutated,
    onReplaceState: handleReplaceState,
  });

  const syncStatusForNotice = syncController.syncState.status;
  // The phone apps leave a plain flag when the sign-in secrets were lost (Android: the Keystore key
  // was lost and the secrets dropped; iOS: stored Keychain items are gone). Shown once; re-read when sync status changes (the loss is usually found
  // by the first sync after launch).
  const [secureKeysLostNotice, setSecureKeysLostNotice] = useState(false);
  const secureKeysDismissedRef = useRef(false);
  useEffect(() => {
    let live = true;
    platform.storage
      .getKv(SECURE_KEYS_LOST_KV_KEY)
      .then((flag) => {
        // Once dismissed in this session, a later sync-status change never brings it back.
        if (live && flag !== undefined && !secureKeysDismissedRef.current) {
          setSecureKeysLostNotice(true);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [platform.storage, syncStatusForNotice]);
  const dismissSecureKeysLostNotice = useCallback(() => {
    secureKeysDismissedRef.current = true;
    setSecureKeysLostNotice(false);
    platform.storage.deleteKv(SECURE_KEYS_LOST_KV_KEY).catch(() => undefined);
  }, [platform.storage]);

  const emitEvents = useCallback(
    (events: readonly KnownEvent[]) => {
      if (events.length === 0) return;
      const factory = factoryRef.current ?? eventFactory;
      const st = stateRef.current ?? collectionState;
      // An edit that starts using a file re-adds it right after, so the newer use beats a Check
      // media removal another device decided before this edit synced (mediaReAdds.ts).
      const mediaPrior = priorOfMediaEdits(st, events);
      if (mediaPrior) mediaReAddsRef.current?.add({ prior: mediaPrior, events });
      void mediaReAddsRef.current?.flush();
      const diff = applyEventsWithDiff(st, events);
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

      const changedRows: MaterializedCardRow[] = [];
      for (const cardId of diff.changedCardIds) {
        const card = st.cards.get(cardId);
        if (card) changedRows.push(cardToRow(card));
      }
      const removedIds = diff.removedCardIds;

      const totalNow = getTotalAppliedEventCount(st);
      const shouldSnapshot = totalNow - lastLocalSnapEventsRef.current >= LOCAL_SNAPSHOT_INTERVAL;
      const watermarksForSnap = shouldSnapshot ? syncController.getCurrentWatermarks() : null;
      if (shouldSnapshot) {
        lastLocalSnapEventsRef.current = totalNow;
      }

      void enqueuePersist(async () => {
        await platform.storage.appendEvents(events);
        if (changedRows.length > 0) {
          await platform.storage.upsertMaterializedCards(changedRows);
        }
        if (removedIds.length > 0) {
          await platform.storage.deleteMaterializedCards(removedIds);
        }
        await platform.storage.setDeviceMeta(nextMeta);
        if (watermarksForSnap && (await snapshotWriteAllowed(platform.storage, startedAtMs))) {
          const [{ serializeCollectionState }, maxLocalSeq] = await Promise.all([
            import('@flash/core/snapshot'),
            platform.storage.getMaxLocalSeq(),
          ]);
          const snapshotPayload = serializeCollectionState(st, watermarksForSnap);
          await platform.storage.setLocalSnapshot({
            snapshot: snapshotPayload,
            localSeq: maxLocalSeq,
            savedAt: Date.now(),
          });
        }
      });
    },
    [collectionState, enqueuePersist, eventFactory, platform.storage, startedAtMs, syncController],
  );

  const getEventFactory = useCallback(() => factoryRef.current ?? eventFactory, [eventFactory]);

  // Leech backfill, once per app launch: cards that reached the leech threshold before leech
  // tagging existed (or on an older build, or through an imported history) get the `leech` tag as
  // set-union events, which converge when several devices backfill concurrently. With a sync
  // provider it waits for a sync that completed during THIS launch (not the stale `synced` status
  // a stored cursor shows at boot), so the plan sees the merged log (an earlier add, or a removal
  // of the tag elsewhere, both skip the note). Leeches that arrive later are picked up at the next
  // launch. Idempotent.
  const [launchedAtMs] = useState(() => Date.now());
  const backfillReady = isLeechBackfillReady(syncController.syncState, launchedAtMs);
  const backfillDoneRef = useRef(false);
  const emitEventsRef = useRef(emitEvents);
  emitEventsRef.current = emitEvents;
  useEffect(() => {
    if (!backfillReady || backfillDoneRef.current) return;
    backfillDoneRef.current = true;
    const plan = planLeechBackfill(stateRef.current ?? collectionState);
    if (plan.length === 0) return;
    const factory = factoryRef.current ?? eventFactory;
    const nowMs = Date.now();
    emitEventsRef.current(plan.map((payload) => factory.create('NoteTagsAdded', payload, nowMs)));
  }, [backfillReady, collectionState, eventFactory]);

  // Deck option presets: after each sync completed in this launch, copy every preset into any
  // member deck that fell behind it (lazy; see library/presetCatchUp.ts). Idempotent.
  const presetCatchUpAt = backfillReady ? syncController.syncState.lastSyncedAt : undefined;
  useEffect(() => {
    if (presetCatchUpAt === undefined) return;
    void import('../library/presetCatchUp.ts')
      .then((m) =>
        m.runPresetCatchUp(
          stateRef.current ?? collectionState,
          factoryRef.current ?? eventFactory,
          emitEventsRef.current,
        ),
      )
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetCatchUpAt]);

  // Non-blocking post-first-paint source check (§3.1 modifiedTime check & §3.2 local folder rescan).
  // Strictly lazy-loads sourceRunner ONLY if linked sources exist so initial bundle stays lean (§8).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const saved = await platform.storage.getKv<SourcesRegistry>('linked_sources_v1');
          const hasAny =
            Boolean(saved?.googleSources?.length) ||
            Boolean(saved?.oneDriveSources?.length) ||
            Boolean(saved?.localFolders?.length) ||
            Boolean(saved?.packageSubscriptions?.length) ||
            Boolean(saved?.catalogs?.length);
          if (!hasAny) return;
          const { refreshAllSources } = await import('../sources/sourceRunner.ts');
          await refreshAllSources(
            {
              platform,
              getState: () => stateRef.current ?? collectionState,
              getEventFactory,
              emitEvents,
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
      const factory = factoryRef.current ?? eventFactory;
      const nowMs = Date.now();
      const tzOffset = -new Date(nowMs).getTimezoneOffset();
      const st = stateRef.current ?? collectionState;
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

      const ev = factory.create(
        'ReviewRecorded',
        {
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
        },
        nowMs,
      );

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
          ...(leechTag && { leechTagged: true }),
        },
      ]);
      emitEvents(events);
    },
    [collectionState, emitEvents, eventFactory],
  );

  const undoLastReview = useCallback((): boolean => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return false;
    const factory = factoryRef.current ?? eventFactory;
    const nowMs = Date.now();
    const events: KnownEvent[] = [
      factory.create('ReviewUndone', { review_id: last.reviewId }, nowMs),
    ];
    if (last.leechSuspended) {
      events.push(factory.create('CardUnsuspended', { card_id: last.cardId }, nowMs));
    }
    const st = stateRef.current ?? collectionState;
    const card = last.leechTagged ? st.cards.get(last.cardId) : undefined;
    const untag = card && planLeechTagUndo(st, card);
    if (untag) events.push(factory.create('NoteUpserted', untag, nowMs));
    setUndoStack((prev) => prev.slice(0, -1));
    emitEvents(events);
    return true;
  }, [collectionState, emitEvents, eventFactory, undoStack]);

  const updateNote = useCallback(
    (note: Note, fields: Record<string, string>, tags: string[]) => {
      const factory = factoryRef.current ?? eventFactory;
      const ev = factory.create(
        'NoteUpserted',
        {
          note_id: note.id,
          deck_id: note.deck_id,
          source_key: note.source_key,
          fields,
          tags,
          provenance: { ...note.provenance, reviewed: true },
        },
        Date.now(),
      );
      emitEvents([ev]);
    },
    [emitEvents, eventFactory],
  );

  const setNoteArchived = useCallback(
    (noteId: string, archived: boolean) => {
      const factory = factoryRef.current ?? eventFactory;
      const nowMs = Date.now();
      const ev = archived
        ? factory.create('NoteArchived', { note_id: noteId }, nowMs)
        : factory.create('NoteRestored', { note_id: noteId }, nowMs);
      emitEvents([ev]);
    },
    [emitEvents, eventFactory],
  );

  const markNoteReviewed = useCallback(
    (note: Note) => {
      const factory = factoryRef.current ?? eventFactory;
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
    [emitEvents, eventFactory],
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
      await platform.storage.putMedia({
        hash: normHash,
        mime: media.mime,
        bytes: media.bytes,
      });
      const st = stateRef.current ?? collectionState;
      const existing = st.media.get(normHash);
      const needsEvent =
        !existing ||
        (media.tts_key !== undefined && existing.tts_key !== media.tts_key) ||
        (media.tts_lang_key !== undefined && existing.tts_lang_key !== media.tts_lang_key);
      if (needsEvent) {
        const factory = factoryRef.current ?? eventFactory;
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
    [collectionState, emitEvents, eventFactory, platform.storage],
  );

  const audio = useAudioController({
    platform,
    stateRef: stateRef as React.MutableRefObject<CollectionState>,
    addMedia,
  });

  const upsertLayout = useCallback(
    (layout: Layout, enableOnDeckId?: string) => {
      const factory = factoryRef.current ?? eventFactory;
      const st = stateRef.current ?? collectionState;
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
    [collectionState, emitEvents, eventFactory],
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
      const factory = factoryRef.current ?? eventFactory;
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
    [emitEvents, eventFactory],
  );

  const markPageRead = useCallback(
    (pageId: string) => {
      const factory = factoryRef.current ?? eventFactory;
      const nowMs = Date.now();
      const ev = factory.create('PageRead', { page_id: pageId, read_at: nowMs }, nowMs);
      emitEvents([ev]);
    },
    [emitEvents, eventFactory],
  );

  const upsertCourse = useCallback(
    (course: Course) => {
      const factory = factoryRef.current ?? eventFactory;
      const ev = factory.create('CourseChanged', { course }, Date.now());
      emitEvents([ev]);
    },
    [emitEvents, eventFactory],
  );

  const createDeck = useCallback(
    (name: string, noteTypeId: string, language: string): string => {
      const factory = factoryRef.current ?? eventFactory;
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
    [emitEvents, eventFactory],
  );

  const updateDeckSettings = useCallback(
    (
      deckId: string,
      patch: { name?: string; archived?: boolean; settings?: Partial<DeckSettings> },
    ) => {
      const factory = factoryRef.current ?? eventFactory;
      const st = stateRef.current ?? collectionState;
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
    [collectionState, emitEvents, eventFactory],
  );

  const toggleDeckLayout = useCallback(
    (deckId: string, layoutId: string) => {
      const st = stateRef.current ?? collectionState;
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
    [collectionState, updateDeckSettings],
  );

  const rescheduleDeck = useCallback(
    (deckId: string) => {
      const factory = factoryRef.current ?? eventFactory;
      const st = stateRef.current ?? collectionState;
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
    [collectionState, emitEvents, eventFactory],
  );

  const updatePreferences = useCallback(
    (patch: Partial<CollectionPreferences>) => {
      const factory = factoryRef.current ?? eventFactory;
      const ev = factory.create('PreferencesChanged', { preferences: patch }, Date.now());
      emitEvents([ev]);
    },
    [emitEvents, eventFactory],
  );

  const loadSampleDecks = useCallback(() => {
    void retryImport(() => import('@flash/core/samples'))
      .then(({ buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS }) => {
        const factory = factoryRef.current ?? eventFactory;
        const events = buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS);
        emitEvents(events);
      })
      .catch((error: unknown) => {
        // Offline before the chunk was cached: nothing is added; the button can be pressed again.
        console.warn('Could not load the sample decks', error);
      });
  }, [emitEvents, eventFactory]);

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
    metaRef.current = freshMeta;
    stateRef.current = createEmptyState();
    factoryRef.current = createEventFactory(freshMeta.deviceId, 0, freshMeta.hlc);
    lastLocalSnapEventsRef.current = 0;
    syncController.resetSyncState();
    audio.resetLocalState();
    setMeta(freshMeta);
    setUndoStack([]);
    setActiveDeckId(undefined);
    setStateVersion((v) => v + 1);
    await enqueuePersist(async () => {
      await platform.storage.clearAll();
      await platform.storage.setDeviceMeta(freshMeta);
    });
    await refreshEntitlement();
  }, [audio, enqueuePersist, platform, refreshEntitlement, syncController]);

  const showBackupBanner = useMemo(() => {
    // Auto-hide weekly backup reminder once cloud or local-folder sync is connected and active
    // (§4.4). Automatic backups stay on the device, so they never hide it.
    const provider = syncController.syncState.provider;
    if (
      provider !== 'none' &&
      provider !== 'dev_channel' &&
      syncController.syncState.status !== 'reconnect_required'
    ) {
      return false;
    }
    const st = stateRef.current ?? collectionState;
    if (st.decks.size === 0) return false;
    const now = Date.now();
    if (
      meta.backupReminderDismissedAt !== undefined &&
      now - meta.backupReminderDismissedAt < SEVEN_DAYS_MS
    ) {
      return false;
    }
    if (meta.lastBackupAt !== undefined) {
      return now - meta.lastBackupAt > SEVEN_DAYS_MS;
    }
    // Show banner once the user has recorded at least 5 reviews and never backed up
    let reviewCount = 0;
    for (const list of st.reviewsByCard.values()) {
      reviewCount += list.length;
      if (reviewCount >= 5) return true;
    }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    collectionState,
    meta.lastBackupAt,
    meta.backupReminderDismissedAt,
    stateVersion,
    syncController.syncState.provider,
    syncController.syncState.status,
  ]);

  // Once this device syncs with the link's provider, the link has done its job.
  const addDeviceLink =
    openedAddDeviceLink && syncController.syncState.provider !== openedAddDeviceLink.provider
      ? openedAddDeviceLink
      : undefined;

  const value: AppContextValue = {
    platform,
    addDeviceLink,
    state: stateRef.current ?? collectionState,
    stateVersion,
    ready: true,
    meta,
    entitlement,
    refreshEntitlement,
    undoStack,
    clearUndoStack: () => setUndoStack([]),
    whenSaved,
    activeDeckId,
    setActiveDeckId,
    showBackupBanner,
    secureKeysLostNotice,
    dismissSecureKeysLostNotice,
    audio,
    syncState: syncController.syncState,
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

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return ctx;
}
