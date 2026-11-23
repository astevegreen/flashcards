import type { SyncUiState } from './useSyncController.ts';

export type CollectionChoice = 'synced' | 'local';

/**
 * Answers "this account holds a different collection". Kept apart from the React hook so the order
 * of the steps can be tested:
 * - `local`: disconnect first, then forget the add-device link. While the link is still stored an
 *   automatic sync can only ask again, never bind to the other collection and push this device's
 *   cards. If the disconnect throws, the link stays and the question stays open.
 * - `synced`: forget the link (the engine then binds to the synced collection), clear the question
 *   and sync, which pushes this device's own events into that collection.
 * Neither step deletes an event.
 *
 * `latch` runs first, before any await: a sync already in flight read the old add-device link and
 * would come back asking again, so the answer is latched and that stale result is dropped.
 */
export async function answerCollectionChoice(steps: {
  choice: CollectionChoice;
  latch: () => void;
  disconnect: () => Promise<void>;
  clearLink: () => Promise<void>;
  sync: () => Promise<void>;
  setSyncState: (update: (prev: SyncUiState) => SyncUiState) => void;
}): Promise<void> {
  steps.latch();
  if (steps.choice === 'local') {
    await steps.disconnect();
    await steps.clearLink();
    return;
  }
  await steps.clearLink();
  steps.setSyncState((prev) => {
    const { collectionChoice: _answered, errorMessage: _note, ...rest } = prev;
    void _answered;
    void _note;
    return { ...rest, readOnly: false };
  });
  await steps.sync();
}
