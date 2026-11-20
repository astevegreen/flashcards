import {
  applyEvents,
  applyEventsWithDiff,
  buildSampleDeckEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deserializeCollectionState,
  SAMPLE_SEED_EPOCH_MS,
  serializeCollectionState,
  uuidv7,
  type Card,
  type CollectionState,
} from '@flash/core';
import type { MaterializedCardRow, SyncConfig } from '@flash/platform';
import { createWebPlatform, resolveDeviceFromUrl } from '@flash/platform-web';
import { FlashcardsApp } from '@flash/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

// Public OAuth Web Client ID & stateless token-helper Worker URL (never secret)
const DEFAULT_GOOGLE_CLIENT_ID =
  '932735219487-p20rc5hu0gegb2bh43q8phe8lgi957v3.apps.googleusercontent.com';
const DEFAULT_TOKEN_HELPER_URL = 'https://flashcards-token-helper.yodc.workers.dev';

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

async function boot(): Promise<void> {
  const resolved = resolveDeviceFromUrl();
  const isDevMode = import.meta.env.DEV || Boolean(resolved.slug);
  const googleClientId =
    (import.meta.env['VITE_GOOGLE_CLIENT_ID'] as string | undefined)?.trim() ||
    DEFAULT_GOOGLE_CLIENT_ID;
  const tokenHelperUrl =
    (import.meta.env['VITE_TOKEN_HELPER_URL'] as string | undefined)?.trim() ||
    DEFAULT_TOKEN_HELPER_URL;

  const platform = createWebPlatform({
    isDevMode,
    googleClientId,
    tokenHelperUrl,
  });

  // Zero-overhead OAuth redirect callback check (only lazy-loads GoogleAuth if `?code=` / `?error=` is present)
  let initialOAuthError: string | undefined;
  let syncConfig: SyncConfig | undefined = await platform.storage.getSyncConfig();
  let syncCursor = await platform.storage.getSyncCursor();

  let meta = await platform.storage.getDeviceMeta();
  if (!meta) {
    // Real production installs must each receive a unique persistent device ID (§4.2 single-writer invariant).
    // Only `?device=<slug>` dev/test sessions use deterministic slug IDs (`device-a`, `device-b`).
    const uniqueDeviceId = platform.hasDeviceSlug
      ? platform.deviceId
      : `web-${uuidv7().slice(0, 12)}`;
    meta = {
      deviceId: uniqueDeviceId,
      seq: 0,
      hlc: createHlcState(uniqueDeviceId, 0),
    };
    await platform.storage.setDeviceMeta(meta);
  }

  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.has('code') || searchParams.has('error')) {
    try {
      const auth = await platform.getGoogleAuth();
      const session = await auth.handleRedirectCallback();
      if (session) {
        const switchingProvider = syncConfig?.provider !== 'google_drive';
        syncConfig = { provider: 'google_drive', connectedAt: Date.now() };
        await platform.storage.setSyncConfig(syncConfig);
        if (switchingProvider) {
          const { createInitialSyncCursor } = await import('@flash/core/sync');
          syncCursor = createInitialSyncCursor();
          await platform.storage.setSyncCursor(syncCursor);
          if (meta.collectionId !== undefined) {
            const { collectionId: _dropped, ...restMeta } = meta;
            void _dropped;
            meta = restMeta;
            await platform.storage.setDeviceMeta(meta);
          }
        }
      }
    } catch (err) {
      initialOAuthError = err instanceof Error ? err.message : String(err);
    }
  }

  // Fast cold-start hydration: load local snapshot + only incremental delta events when available
  let initialState: CollectionState;
  const localSnapshot = await platform.storage.getLocalSnapshot();

  if (localSnapshot) {
    initialState = deserializeCollectionState(localSnapshot.snapshot);
    const delta = await platform.storage.getEventsAfterLocalSeq(localSnapshot.localSeq);
    if (delta.events.length > 0) {
      const diff = applyEventsWithDiff(initialState, delta.events);
      const changedRows: MaterializedCardRow[] = [];
      for (const cardId of diff.changedCardIds) {
        const card = initialState.cards.get(cardId);
        if (card) changedRows.push(cardToRow(card));
      }
      void Promise.all([
        changedRows.length > 0
          ? platform.storage.upsertMaterializedCards(changedRows)
          : Promise.resolve(),
        diff.removedCardIds.length > 0
          ? platform.storage.deleteMaterializedCards(diff.removedCardIds)
          : Promise.resolve(),
      ]);
    }
  } else {
    let events = await platform.storage.getAllEvents();

    // Agent-friendly no-login dev mode (§10.2): auto-seed sample decks at fixed baseline epoch
    if (events.length === 0 && isDevMode && !meta.seeded) {
      const factory = createEventFactory(meta.deviceId, meta.seq, meta.hlc);
      const seedEvents = buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS);
      await platform.storage.appendEvents(seedEvents);
      meta = {
        ...meta,
        seq: factory.getSeq(),
        hlc: factory.getHlc(),
        seeded: true,
      };
      await platform.storage.setDeviceMeta(meta);
      events = seedEvents;
    }

    initialState = applyEvents(createEmptyState(), events);

    // Asynchronously warm cards_cache and local snapshot for subsequent fast cold starts
    if (events.length > 0) {
      const rows = [...initialState.cards.values()].map(cardToRow);
      void platform.storage.saveMaterializedCards(rows);
      if (events.length >= 200) {
        // Capture maxLocalSeq synchronously before rendering so post-render mutations cannot race ahead
        const maxLocalSeq = await platform.storage.getMaxLocalSeq();
        const snapPayload = serializeCollectionState(initialState, {
          [meta.deviceId]: meta.seq,
          ...(syncCursor?.remoteWatermarks ?? {}),
        });
        void platform.storage.setLocalSnapshot({
          snapshot: snapPayload,
          localSeq: maxLocalSeq,
          savedAt: Date.now(),
        });
      }
    }
  }

  const rootEl = document.getElementById('root');
  if (!rootEl) {
    throw new Error('Root element #root not found');
  }

  createRoot(rootEl).render(
    <StrictMode>
      <FlashcardsApp
        platform={platform}
        initialState={initialState}
        initialMeta={meta}
        {...(syncConfig !== undefined ? { initialSyncConfig: syncConfig } : {})}
        {...(syncCursor !== undefined ? { initialSyncCursor: syncCursor } : {})}
        {...(initialOAuthError !== undefined ? { initialOAuthError } : {})}
      />
    </StrictMode>,
  );
}

void boot();
