import type { CollectionState } from '../events/replay.ts';

/**
 * Check media: which media files the collection stores but nothing uses, and which ones notes or
 * pages reference but this device does not have. Pure; the caller passes what storage holds.
 *
 * A file counts as used when any note (archived ones too, since they can be restored), page,
 * deck, note type, layout, course or preference mentions `media:<sha256>`, or when it is cached
 * spoken audio (TTS). Unused files still in the collection are removed with `MediaRemoved`
 * events, so every device drops them. A stored file that a kept backup lists stays on the device
 * until that backup rolls off, so restoring the backup still finds it.
 */

const MEDIA_REF_RE = /media:([0-9a-f]{64})/gi;

export interface MediaReference {
  noteIds: string[];
  pageIds: string[];
  /** Mentioned outside notes and pages (deck, note type, layout, course, preferences). */
  elsewhere: boolean;
}

function scan(value: unknown, onHash: (hash: string) => void): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text || !text.includes('media:')) return;
  MEDIA_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_REF_RE.exec(text)) !== null) {
    if (m[1]) onHash(m[1].toLowerCase());
  }
}

/** Every `media:<sha256>` the collection mentions, with what mentions it. */
export function collectMediaReferences(state: CollectionState): Map<string, MediaReference> {
  const refs = new Map<string, MediaReference>();
  const get = (hash: string): MediaReference => {
    let ref = refs.get(hash);
    if (!ref) {
      ref = { noteIds: [], pageIds: [], elsewhere: false };
      refs.set(hash, ref);
    }
    return ref;
  };
  for (const note of state.notes.values()) {
    const seen = new Set<string>();
    scan(note.fields, (hash) => {
      if (seen.has(hash)) return;
      seen.add(hash);
      get(hash).noteIds.push(note.id);
    });
  }
  for (const page of state.pages.values()) {
    const seen = new Set<string>();
    scan(page, (hash) => {
      if (seen.has(hash)) return;
      seen.add(hash);
      get(hash).pageIds.push(page.id);
    });
  }
  const elsewhere = (value: unknown): void =>
    scan(value, (hash) => {
      get(hash).elsewhere = true;
    });
  elsewhere([...state.decks.values()]);
  elsewhere([...state.noteTypes.values()]);
  elsewhere([...state.layouts.values()]);
  elsewhere([...state.courses.values()]);
  elsewhere(state.preferences);
  elsewhere([...state.pendingDeckPatches.values()]);
  elsewhere([...state.pendingPagePatches.values()]);
  return refs;
}

/** Cached spoken audio: never offered for removal (it is found by text, not by reference). */
function spokenAudioHashes(state: CollectionState): Set<string> {
  const out = new Set<string>();
  for (const m of state.media.values()) {
    if (m.tts_key !== undefined || m.tts_lang_key !== undefined) out.add(m.hash.toLowerCase());
  }
  for (const hash of state.ttsMediaByKey.values()) out.add(hash.toLowerCase());
  for (const hash of state.ttsMediaByLangKey.values()) out.add(hash.toLowerCase());
  return out;
}

export interface UnusedMediaFile {
  hash: string;
  /** Size in bytes when the collection records it. */
  size?: number;
  mime?: string;
  ext?: string;
  /** Listed in the collection (removed with a `MediaRemoved` event). */
  inCollection: boolean;
  /** This device stores the file. */
  stored: boolean;
  /** A kept backup lists it, so the file itself stays on this device for now. */
  keepFileForBackups: boolean;
}

export interface MissingMediaFile {
  hash: string;
  noteIds: string[];
  pageIds: string[];
  elsewhere: boolean;
  /** Listed in the collection, so sync may still download it from another device. */
  inCollection: boolean;
}

export interface MediaCheckReport {
  /** Files the collection uses and this device stores. */
  usedCount: number;
  storedCount: number;
  unused: UnusedMediaFile[];
  /** Bytes of the unused files whose size is known. */
  unusedBytes: number;
  missing: MissingMediaFile[];
  /** Files outside the collection that stay stored only because a kept backup lists them. */
  keptForBackups: number;
  /** Cached spoken audio, which is never offered for removal. */
  spokenAudio: number;
}

export interface MediaCheckInput {
  /** Hashes of every media file this device stores (`Storage.listMediaHashes`). */
  storedHashes: Iterable<string>;
  /** Hashes kept backups list (`mediaHashesUsedByBackups`). */
  backupHashes?: Iterable<string>;
}

export function checkMedia(state: CollectionState, input: MediaCheckInput): MediaCheckReport {
  const stored = new Set<string>();
  for (const h of input.storedHashes) stored.add(h.toLowerCase());
  const backup = new Set<string>();
  for (const h of input.backupHashes ?? []) backup.add(h.toLowerCase());
  const refs = collectMediaReferences(state);
  const spoken = spokenAudioHashes(state);

  const candidates = new Set<string>(stored);
  for (const hash of state.media.keys()) candidates.add(hash.toLowerCase());

  const unused: UnusedMediaFile[] = [];
  let usedCount = 0;
  let keptForBackups = 0;
  let spokenAudio = 0;
  let unusedBytes = 0;
  for (const hash of [...candidates].sort()) {
    const isStored = stored.has(hash);
    if (refs.has(hash)) {
      if (isStored) usedCount += 1;
      continue;
    }
    if (spoken.has(hash)) {
      spokenAudio += 1;
      continue;
    }
    const entry = state.media.get(hash);
    if (!entry && backup.has(hash)) {
      keptForBackups += 1;
      continue;
    }
    if (entry && entry.size > 0) unusedBytes += entry.size;
    unused.push({
      hash,
      inCollection: entry !== undefined,
      stored: isStored,
      keepFileForBackups: isStored && backup.has(hash),
      ...(entry ? { size: entry.size, mime: entry.mime, ext: entry.ext } : {}),
    });
  }

  const missing: MissingMediaFile[] = [];
  for (const [hash, ref] of [...refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (stored.has(hash)) continue;
    missing.push({
      hash,
      noteIds: [...ref.noteIds].sort(),
      pageIds: [...ref.pageIds].sort(),
      elsewhere: ref.elsewhere,
      inCollection: state.media.has(hash),
    });
  }

  return {
    usedCount,
    storedCount: stored.size,
    unused,
    unusedBytes,
    missing,
    keptForBackups,
    spokenAudio,
  };
}

export interface MediaRemovalStep {
  type: 'MediaRemoved';
  payload: { hash: string };
}

/** The events that take the report's unused files out of the collection. */
export function planMediaRemoval(report: MediaCheckReport): MediaRemovalStep[] {
  return report.unused
    .filter((f) => f.inCollection)
    .map((f) => ({ type: 'MediaRemoved', payload: { hash: f.hash } }));
}

/** Stored files the removal may delete from this device (not the ones a kept backup lists). */
export function mediaFilesToDelete(report: MediaCheckReport): string[] {
  return report.unused.filter((f) => f.stored && !f.keepFileForBackups).map((f) => f.hash);
}
