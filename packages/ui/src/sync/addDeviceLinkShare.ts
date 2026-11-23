import type { SyncProviderKind } from '@flash/platform';
import {
  ADD_DEVICE_COLLECTION_PARAM,
  ADD_DEVICE_DEEP_LINK_BASE,
  ADD_DEVICE_PROVIDER_PARAM,
  CODE_TO_PROVIDER,
  isShareableCollectionId,
  type AddDeviceLink,
  type AddDeviceProvider,
} from './addDeviceLink.ts';

/** Building and checking add-device links: Settings only, so not in the initial chunk (§8). */

const PROVIDER_TO_CODE = new Map<SyncProviderKind, string>(
  [...CODE_TO_PROVIDER].map(([code, provider]) => [provider, code]),
);

export function isAddDeviceProvider(value: unknown): value is AddDeviceProvider {
  return typeof value === 'string' && PROVIDER_TO_CODE.has(value as SyncProviderKind);
}

/** Builds the link a new device opens: `<base>?sync=<provider>&col=<collection id>`. */
export function buildAddDeviceUrl(base: string, link: AddDeviceLink): string {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set(ADD_DEVICE_PROVIDER_PARAM, PROVIDER_TO_CODE.get(link.provider) ?? '');
  if (link.collectionId !== undefined && isShareableCollectionId(link.collectionId)) {
    url.searchParams.set(ADD_DEVICE_COLLECTION_PARAM, link.collectionId);
  }
  return url.toString();
}

/** The link a native shell shows as QR code and copyable text; the same two values as the web link. */
export function buildAddDeviceDeepLink(link: AddDeviceLink): string {
  const params = new URLSearchParams();
  params.set(ADD_DEVICE_PROVIDER_PARAM, PROVIDER_TO_CODE.get(link.provider) ?? '');
  if (link.collectionId !== undefined && isShareableCollectionId(link.collectionId)) {
    params.set(ADD_DEVICE_COLLECTION_PARAM, link.collectionId);
  }
  return `${ADD_DEVICE_DEEP_LINK_BASE}?${params.toString()}`;
}

export type AddDeviceCollectionCheck = 'not_applicable' | 'pending' | 'match' | 'mismatch';

/**
 * After the new device connects: did it reach the collection the other device showed? Only
 * meaningful once this device syncs with the link's provider and has learnt a collection id.
 */
export function checkAddDeviceCollection(
  expected: AddDeviceLink | undefined,
  current: { provider: SyncProviderKind; collectionId: string | undefined },
): AddDeviceCollectionCheck {
  if (expected?.collectionId === undefined) return 'not_applicable';
  if (current.provider !== expected.provider) return 'not_applicable';
  if (current.collectionId === undefined) return 'pending';
  return current.collectionId === expected.collectionId ? 'match' : 'mismatch';
}
