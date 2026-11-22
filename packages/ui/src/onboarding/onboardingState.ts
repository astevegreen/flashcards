import type { Storage } from '@flash/platform';

/**
 * First-run onboarding record (Phase 13 / Phase 14 "study first, set up later"). Per device:
 * kept in the device's own key-value store and never synced as an event, like reminder settings,
 * so a second device that syncs an existing collection never sees onboarding (it is only offered
 * while the collection is empty) and each fresh install decides for itself.
 */
export const ONBOARDING_KV_KEY = 'onboarding_v1';

export type OnboardingStatus = 'completed' | 'skipped';

/** The deferred "Sync my devices" prompt, offered once after the first finished session. */
export type SyncPromptState = 'pending' | 'opened' | 'dismissed';

export interface OnboardingRecord {
  status: OnboardingStatus;
  at: number;
  language?: string;
  deckSlug?: string;
  syncPrompt?: SyncPromptState;
}

type KvStore = Pick<Storage, 'getKv' | 'setKv'>;

function isSyncPromptState(value: unknown): value is SyncPromptState {
  return value === 'pending' || value === 'opened' || value === 'dismissed';
}

/** Validates a stored record (anything malformed reads as "not onboarded yet"). */
export function parseOnboardingRecord(raw: unknown): OnboardingRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r['status'] !== 'completed' && r['status'] !== 'skipped') return undefined;
  const record: OnboardingRecord = {
    status: r['status'],
    at: typeof r['at'] === 'number' && Number.isFinite(r['at']) ? r['at'] : 0,
  };
  if (typeof r['language'] === 'string') record.language = r['language'];
  if (typeof r['deckSlug'] === 'string') record.deckSlug = r['deckSlug'];
  if (isSyncPromptState(r['syncPrompt'])) record.syncPrompt = r['syncPrompt'];
  return record;
}

export async function loadOnboardingRecord(
  storage: KvStore,
): Promise<OnboardingRecord | undefined> {
  try {
    return parseOnboardingRecord(await storage.getKv(ONBOARDING_KV_KEY));
  } catch {
    return undefined;
  }
}

const cachedReads = new WeakMap<KvStore, Promise<OnboardingRecord | undefined>>();
/** The settled record per storage object (absent until the first read settles or a save). */
const settled = new WeakMap<KvStore, OnboardingRecord | undefined>();

/** One stable read per storage object, for React `use()` (so first paint never shifts). */
export function onboardingRecordResource(storage: KvStore): Promise<OnboardingRecord | undefined> {
  let read = cachedReads.get(storage);
  if (!read) {
    const pending = loadOnboardingRecord(storage);
    read = pending;
    cachedReads.set(storage, pending);
    void pending.then((record) => {
      // A save while the read was in flight wins over what the read found.
      if (cachedReads.get(storage) === pending) settled.set(storage, record);
    });
  }
  return read;
}

/**
 * The record as last read or saved, synchronously, for UI that must decide in the same render
 * whether to show something (so it never appears late). `undefined` until the first read settles.
 */
export function peekOnboardingRecord(storage: KvStore): OnboardingRecord | undefined {
  return settled.get(storage);
}

export async function saveOnboardingRecord(
  storage: KvStore,
  record: OnboardingRecord,
): Promise<void> {
  cachedReads.set(storage, Promise.resolve(record));
  settled.set(storage, record);
  try {
    await storage.setKv(ONBOARDING_KV_KEY, record);
  } catch {
    // Best effort: the worst case is that onboarding is offered again on an empty collection.
  }
}

/** True when the deferred sync prompt should be offered (onboarded here, prompt not answered). */
export function wantsSyncPrompt(record: OnboardingRecord | undefined): boolean {
  return record?.status === 'completed' && record.syncPrompt === 'pending';
}
