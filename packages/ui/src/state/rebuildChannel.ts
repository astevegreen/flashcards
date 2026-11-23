/** The cross-tab half of `rebuildSignal.ts`, loaded after first paint. */

const CHANNEL_NAME = 'flashcards-collection-rebuilt';

/** Tells other tabs of `deviceId` that the collection was rebuilt. */
export function announceRebuild(deviceId: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage({ type: 'rebuilt', deviceId });
  channel.close();
}

/** Calls `onRebuilt` when another tab of `deviceId` rebuilt the collection; returns a cleanup. */
export function listenForRebuild(deviceId: string, onRebuilt: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (e: MessageEvent<unknown>) => {
    const data = e.data as { type?: unknown; deviceId?: unknown } | null;
    if (data?.type === 'rebuilt' && data.deviceId === deviceId) onRebuilt();
  };
  return () => channel.close();
}
