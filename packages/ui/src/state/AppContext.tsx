import {
  applyEvents,
  applyEventsWithDiff,
  applyReviewToSchedule,
  buildSampleDeckEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  FLASH_NAMESPACE_UUID,
  getActiveFsrsParamsVersion,
  getEnabledLayoutsForDeck,
  getTotalAppliedEventCount,
  resolveDeckFsrsConfig,
  SAMPLE_SEED_EPOCH_MS,
  serializeCollectionState,
  uuidv5,
  uuidv7,
  type Card,
  type CollectionPreferences,
  type CollectionState,
  type DeckSettings,
  type EventFactory,
  type FlashEvent,
  type KnownEvent,
  type Note,
  type ReviewRating,
  type SyncCursorState,
} from '@flash/core';
import type {
  DeviceMeta,
  MaterializedCardRow,
  PlatformServices,
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
import { useSyncController, type SyncUiState } from './useSyncController.ts';

export type { SyncUiState, SyncUiStatus } from './useSyncController.ts';

export interface UndoEntry {
  reviewId: string;
  cardId: string;
  deckId: string;
}

export interface AppContextValue {
  platform: PlatformServices;
  state: CollectionState;
  stateVersion: number;
  ready: boolean;
  meta: DeviceMeta | null;
  undoStack: readonly UndoEntry[];
  activeDeckId: string | undefined;
  setActiveDeckId: (deckId: string | undefined) => void;
  showBackupBanner: boolean;
  syncState: SyncUiState;
  syncNow: () => Promise<void>;
  connectGoogleDrive: () => Promise<void>;
  connectLocalFolder: () => Promise<boolean>;
  reconnectLocalFolder: () => Promise<boolean>;
  disconnectSync: () => Promise<void>;
  emitEvents: (events: readonly KnownEvent[]) => void;
  getEventFactory: () => EventFactory;
  rateCard: (card: Card, rating: ReviewRating, durationMs: number) => void;
  undoLastReview: () => boolean;
  updateNote: (note: Note, fields: Record<string, string>, tags: string[]) => void;
  createDeck: (name: string, noteTypeId: string, language: string) => string;
  updateDeckSettings: (
    deckId: string,
    patch: { name?: string; settings?: Partial<DeckSettings> },
  ) => void;
  toggleDeckLayout: (deckId: string, layoutId: string) => void;
  updatePreferences: (patch: Partial<CollectionPreferences>) => void;
  loadSampleDecks: () => void;
  markBackupCompleted: () => Promise<void>;
  dismissBackupBanner: () => Promise<void>;
  resetLocalData: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const LOCAL_SNAPSHOT_INTERVAL = 200;

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
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [activeDeckId, setActiveDeckId] = useState<string | undefined>(undefined);
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const lastLocalSnapEventsRef = useRef<number>(getTotalAppliedEventCount(collectionState));

  // Request persistent storage on first launch (§4.4)
  useEffect(() => {
    void platform.storage.requestPersistence();
  }, [platform.storage]);

  const enqueuePersist = useCallback((task: () => Promise<void>): Promise<void> => {
    const next = persistChainRef.current.then(task, task).catch((err) => {
      console.error('Failed to persist to storage:', err);
    });
    persistChainRef.current = next;
    return next;
  }, []);

  const handleRemoteStateMutated = useCallback((nextMeta?: DeviceMeta) => {
    if (nextMeta) {
      metaRef.current = nextMeta;
      setMeta(nextMeta);
    }
    setStateVersion((v) => v + 1);
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
    onStateMutated: handleRemoteStateMutated,
    onReplaceState: handleReplaceState,
  });

  const emitEvents = useCallback(
    (events: readonly KnownEvent[]) => {
      if (events.length === 0) return;
      const factory = factoryRef.current ?? eventFactory;
      const st = stateRef.current ?? collectionState;
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
      const snapshotPayload = shouldSnapshot
        ? serializeCollectionState(st, syncController.getCurrentWatermarks())
        : null;
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
        if (snapshotPayload) {
          const maxLocalSeq = await platform.storage.getMaxLocalSeq();
          await platform.storage.setLocalSnapshot({
            snapshot: snapshotPayload,
            localSeq: maxLocalSeq,
            savedAt: Date.now(),
          });
        }
      });
    },
    [collectionState, enqueuePersist, eventFactory, platform.storage, syncController],
  );

  const getEventFactory = useCallback(() => factoryRef.current ?? eventFactory, [eventFactory]);

  const rateCard = useCallback(
    (card: Card, rating: ReviewRating, durationMs: number) => {
      const factory = factoryRef.current ?? eventFactory;
      const nowMs = Date.now();
      const tzOffset = -new Date(nowMs).getTimezoneOffset();
      const st = stateRef.current ?? collectionState;
      const paramsVersion = getActiveFsrsParamsVersion(st, card.deck_id);
      const fsrsConfig = resolveDeckFsrsConfig(st, card.deck_id, nowMs, paramsVersion);
      const { resulting_due_at } = applyReviewToSchedule(card.schedule, rating, nowMs, fsrsConfig);
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
          fsrs_params_version: paramsVersion,
          resulting_due_at,
        },
        nowMs,
      );

      setUndoStack((prev) => [
        ...prev.slice(-49),
        { reviewId, cardId: card.id, deckId: card.deck_id },
      ]);
      emitEvents([ev]);
    },
    [collectionState, emitEvents, eventFactory],
  );

  const undoLastReview = useCallback((): boolean => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return false;
    const factory = factoryRef.current ?? eventFactory;
    const ev = factory.create('ReviewUndone', { review_id: last.reviewId }, Date.now());
    setUndoStack((prev) => prev.slice(0, -1));
    emitEvents([ev]);
    return true;
  }, [emitEvents, eventFactory, undoStack]);

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
    (deckId: string, patch: { name?: string; settings?: Partial<DeckSettings> }) => {
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
            ...(patch.settings !== undefined ? { settings: patch.settings } : {}),
          },
          nowMs,
        ),
      );
      if (
        patch.settings?.target_retention !== undefined &&
        patch.settings.target_retention !== existingDeck?.settings.target_retention
      ) {
        const nextVersion = getActiveFsrsParamsVersion(st, deckId) + 1;
        events.push(
          factory.create(
            'DeckFSRSParamsChanged',
            {
              deck_id: deckId,
              params_version: nextVersion,
              effective_from: nowMs,
              params: {
                request_retention: patch.settings.target_retention,
                enable_fuzz: false,
                enable_short_term: true,
              },
            },
            nowMs,
          ),
        );
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

  const updatePreferences = useCallback(
    (patch: Partial<CollectionPreferences>) => {
      const factory = factoryRef.current ?? eventFactory;
      const ev = factory.create('PreferencesChanged', { preferences: patch }, Date.now());
      emitEvents([ev]);
    },
    [emitEvents, eventFactory],
  );

  const loadSampleDecks = useCallback(() => {
    const factory = factoryRef.current ?? eventFactory;
    const events = buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS);
    emitEvents(events);
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
    metaRef.current = freshMeta;
    stateRef.current = createEmptyState();
    factoryRef.current = createEventFactory(freshMeta.deviceId, 0, freshMeta.hlc);
    lastLocalSnapEventsRef.current = 0;
    syncController.resetSyncState();
    setMeta(freshMeta);
    setUndoStack([]);
    setActiveDeckId(undefined);
    setStateVersion((v) => v + 1);
    await enqueuePersist(async () => {
      await platform.storage.clearAll();
      await platform.storage.setDeviceMeta(freshMeta);
    });
  }, [enqueuePersist, platform, syncController]);

  const showBackupBanner = useMemo(() => {
    // Auto-hide weekly backup reminder once cloud or local-folder sync is connected and active (§4.4)
    if (
      (syncController.syncState.provider === 'google_drive' ||
        syncController.syncState.provider === 'local_folder') &&
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

  const value: AppContextValue = {
    platform,
    state: stateRef.current ?? collectionState,
    stateVersion,
    ready: true,
    meta,
    undoStack,
    activeDeckId,
    setActiveDeckId,
    showBackupBanner,
    syncState: syncController.syncState,
    syncNow: syncController.syncNow,
    connectGoogleDrive: syncController.connectGoogleDrive,
    connectLocalFolder: syncController.connectLocalFolder,
    reconnectLocalFolder: syncController.reconnectLocalFolder,
    disconnectSync: syncController.disconnectSync,
    emitEvents,
    getEventFactory,
    rateCard,
    undoLastReview,
    updateNote,
    createDeck,
    updateDeckSettings,
    toggleDeckLayout,
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
