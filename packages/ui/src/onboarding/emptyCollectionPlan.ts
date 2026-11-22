import type { SyncProviderKind } from '@flash/platform';
import type { OnboardingRecord } from './onboardingState.ts';

/**
 * What the empty-collection screen opens with (Phase 14 "existing users never see onboarding").
 *
 * First-run onboarding is for a new user on an empty device. A device that is joining an existing
 * collection must never be offered it, or the user could tap a starter deck into the shared
 * collection while the first pull runs, and the screen would swap under the pointer when the pull
 * lands. A device is joining while it syncs with a real provider but has not yet learnt the sync
 * store's collection id (its first sync with that provider has not finished: the sign-in redirect
 * has just returned, or the pull is still running), or while an add-device link it was opened
 * with is still waiting to be confirmed.
 */

export interface EmptyCollectionInput {
  record: OnboardingRecord | undefined;
  /** No decks at all (archived ones included). */
  collectionEmpty: boolean;
  syncProvider: SyncProviderKind;
  /** The sync store's collection id this device has learnt (absent until its first sync). */
  collectionId: string | undefined;
  /** This page load came from an add-device QR code or link. */
  openedFromAddDeviceLink: boolean;
  /** An add-device link (with a collection id) is stored on this device and not yet confirmed. */
  addDeviceLinkPending: boolean;
}

export interface EmptyCollectionStart {
  /** Onboarding may be shown on this screen (once the sync view is closed). */
  offerOnboarding: boolean;
  /** The "Sync my devices" view is open when the screen first paints. */
  syncOpen: boolean;
}

/** A real storage connector (the dev-only channel never holds a user's collection). */
export function syncsWithRealProvider(provider: SyncProviderKind): boolean {
  return provider !== 'none' && provider !== 'dev_channel';
}

/** True while this device syncs but its first sync has not yet shown which collection it holds. */
export function isJoiningCollection(
  syncProvider: SyncProviderKind,
  collectionId: string | undefined,
): boolean {
  return syncsWithRealProvider(syncProvider) && collectionId === undefined;
}

export function planEmptyCollection(input: EmptyCollectionInput): EmptyCollectionStart {
  const joining = isJoiningCollection(input.syncProvider, input.collectionId);
  const syncOpen = input.openedFromAddDeviceLink || input.addDeviceLinkPending || joining;
  const offerOnboarding =
    input.record === undefined && input.collectionEmpty && !joining && !input.addDeviceLinkPending;
  return { offerOnboarding, syncOpen };
}
