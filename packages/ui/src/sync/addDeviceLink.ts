import type { SyncProviderKind } from '@flash/platform';

/**
 * Phase 14 "Add another device": a short link (and the QR code that encodes it) telling a new
 * device which sync provider and which collection to connect to. It carries exactly two values:
 * a provider code from a fixed allow-list and the collection id from the sync store manifest
 * (`sync/v1/manifest.json` `collection_id`, §4.2). Never a token, secret, email or account name:
 * the new device signs in by itself.
 *
 * Kept tiny and dependency-free: the app reads (and strips) the params once at startup.
 */

/** Providers a new device can be pointed at (dev-only channels are never shared). */
export type AddDeviceProvider = Extract<
  SyncProviderKind,
  'google_drive' | 'dropbox' | 'onedrive' | 'icloud' | 'local_folder'
>;

export interface AddDeviceLink {
  provider: AddDeviceProvider;
  /** The sync store's `collection_id`; absent only on hand-written provider-only links. */
  collectionId?: string;
}

export const ADD_DEVICE_PROVIDER_PARAM = 'sync';
export const ADD_DEVICE_COLLECTION_PARAM = 'col';

/** Short, human-readable codes used in the link, keyed both ways. */
const CODE_TO_PROVIDER = new Map<string, AddDeviceProvider>([
  ['google', 'google_drive'],
  ['dropbox', 'dropbox'],
  ['onedrive', 'onedrive'],
  ['icloud', 'icloud'],
  ['folder', 'local_folder'],
]);
const PROVIDER_TO_CODE = new Map<SyncProviderKind, string>(
  [...CODE_TO_PROVIDER].map(([code, provider]) => [provider, code]),
);

/** `col-` + a lowercase RFC 9562 UUID, as the sync engine generates (`col-${uuidv7()}`). */
const COLLECTION_ID_RE = /^col-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isShareableCollectionId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 40 && COLLECTION_ID_RE.test(value);
}

export function isAddDeviceProvider(value: unknown): value is AddDeviceProvider {
  return typeof value === 'string' && PROVIDER_TO_CODE.has(value as SyncProviderKind);
}

/**
 * Reads an add-device link from a query string. Anything malformed (unknown provider, a bad or
 * repeated value, an over-long value) is ignored as a whole: the result is `undefined`.
 */
export function parseAddDeviceParams(search: string): AddDeviceLink | undefined {
  if (search.length > 2048) return undefined;
  const params = new URLSearchParams(search);
  const codes = params.getAll(ADD_DEVICE_PROVIDER_PARAM);
  const collections = params.getAll(ADD_DEVICE_COLLECTION_PARAM);
  if (codes.length !== 1 || collections.length > 1) return undefined;
  const provider = CODE_TO_PROVIDER.get(codes[0] ?? '');
  if (!provider) return undefined;
  const collectionId = collections[0];
  if (collectionId === undefined) return { provider };
  return isShareableCollectionId(collectionId) ? { provider, collectionId } : undefined;
}

/** True when the query string carries any add-device param (valid or not) to strip. */
export function hasAddDeviceParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has(ADD_DEVICE_PROVIDER_PARAM) || params.has(ADD_DEVICE_COLLECTION_PARAM);
}

/** The same URL with the add-device params removed (every other param and the hash kept). */
export function stripAddDeviceParams(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(ADD_DEVICE_PROVIDER_PARAM);
  url.searchParams.delete(ADD_DEVICE_COLLECTION_PARAM);
  return url.toString();
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

/** Scheme and host of the native add-device deep link (`flashcards://add-device?...`). */
export const ADD_DEVICE_DEEP_LINK_BASE = 'flashcards://add-device';

/** The link a native shell shows as QR code and copyable text; the same two values as the web link. */
export function buildAddDeviceDeepLink(link: AddDeviceLink): string {
  const params = new URLSearchParams();
  params.set(ADD_DEVICE_PROVIDER_PARAM, PROVIDER_TO_CODE.get(link.provider) ?? '');
  if (link.collectionId !== undefined && isShareableCollectionId(link.collectionId)) {
    params.set(ADD_DEVICE_COLLECTION_PARAM, link.collectionId);
  }
  return `${ADD_DEVICE_DEEP_LINK_BASE}?${params.toString()}`;
}

/**
 * Reads a `flashcards://add-device?...` link the OS opened the app with. Plain string checks, not
 * `new URL`: older Android System WebViews parse custom schemes non-standardly. The query goes
 * through the same allow-list as the web link, so anything else (another host, a path, an unknown
 * provider, a bad or repeated value) is `undefined`. Unrelated extra params are ignored, as on the web.
 */
export function parseAddDeviceDeepLink(url: string): AddDeviceLink | undefined {
  if (url.length > 2200) return undefined;
  // Some desktop OSes add a trailing slash to an empty path: `flashcards://add-device/?...`.
  const prefix = url.slice(0, ADD_DEVICE_DEEP_LINK_BASE.length).toLowerCase();
  if (prefix !== ADD_DEVICE_DEEP_LINK_BASE) return undefined;
  let rest = url.slice(ADD_DEVICE_DEEP_LINK_BASE.length);
  if (rest.startsWith('/')) rest = rest.slice(1);
  if (!rest.startsWith('?')) return undefined;
  const hash = rest.indexOf('#');
  return parseAddDeviceParams(hash === -1 ? rest : rest.slice(0, hash));
}

/** The same link again keeps the current object, so a repeated scan or tap re-routes nothing. */
export function mergeOpenedAddDeviceLink(
  prev: AddDeviceLink | undefined,
  next: AddDeviceLink,
): AddDeviceLink {
  return prev?.provider === next.provider && prev.collectionId === next.collectionId ? prev : next;
}

interface LocationLike {
  readonly href: string;
  readonly search: string;
}
interface HistoryLike {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/**
 * Reads the link from the address bar and removes its params at once (so a reload, a bookmark
 * or a shared screenshot never repeats it). Returns `undefined` when there is none or it is
 * malformed.
 */
export function takeAddDeviceLink(
  location: LocationLike,
  history: HistoryLike,
): AddDeviceLink | undefined {
  if (!hasAddDeviceParams(location.search)) return undefined;
  const link = parseAddDeviceParams(location.search);
  try {
    history.replaceState(history.state, '', stripAddDeviceParams(location.href));
  } catch {
    // A sandboxed frame may refuse; the link is still read only once per page load.
  }
  return link;
}

let consumed: { link: AddDeviceLink | undefined } | undefined;

/** `takeAddDeviceLink` on the real window, once per page load (StrictMode-safe). */
export function consumeAddDeviceLinkFromLocation(): AddDeviceLink | undefined {
  if (consumed) return consumed.link;
  const link =
    typeof window === 'undefined' ? undefined : takeAddDeviceLink(window.location, window.history);
  consumed = { link };
  return link;
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
