import type { CollectionState, EventFactory, KnownEvent } from '@flash/core';
import type { EntitlementState, PlatformServices, SourcesRegistry } from '@flash/platform';
import { hasLinkedSources } from './hasLinkedSources.ts';
import { hasSyncedLinkedSource } from './hasSyncedLinkedSource.ts';

export interface LaunchSourceCheckContext {
  platform: PlatformServices;
  getState: () => CollectionState;
  getEventFactory: () => EventFactory;
  emitEvents: (events: readonly KnownEvent[]) => void;
  refreshEntitlement: () => Promise<EntitlementState>;
}

/**
 * The post-first-paint source check at launch (§3.1 modifiedTime check, §3.2 local folder rescan).
 * AppProvider loads this module after first paint, and it loads `sourceRunner` only when a linked
 * source exists, so neither is in the initial study chunk (§8). Failures stay quiet: the Library
 * Sources panel shows the details.
 */
export async function runLaunchSourceCheck(ctx: LaunchSourceCheckContext): Promise<void> {
  try {
    const saved = await ctx.platform.storage.getKv<SourcesRegistry>('linked_sources_v1');
    // Decks synced from another device can carry sources Sources never saved here.
    if (!hasLinkedSources(saved) && !hasSyncedLinkedSource(ctx.getState(), saved)) return;
    const { refreshAllSources } = await import('./sourceRunner.ts');
    await refreshAllSources(
      {
        platform: ctx.platform,
        getState: ctx.getState,
        getEventFactory: ctx.getEventFactory,
        emitEvents: ctx.emitEvents,
        entitlement: await ctx.refreshEntitlement(),
      },
      { requestFolderPermission: false },
    );
  } catch {
    // Quiet background refresh failure; details surfaced in Library Sources panel
  }
}
