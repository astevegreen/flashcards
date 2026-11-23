import type { CollectionState } from '../events/replay.ts';
import { compareCodeUnits } from '../study/queue.ts';

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
  if (!text?.includes('media:')) return;
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

function lowerSet(hashes: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>();
  for (const h of hashes ?? []) out.add(h.toLowerCase());
  return out;
}

interface MediaCheckSets {
  state: CollectionState;
  stored: Set<string>;
  backup: Set<string>;
  refs: Map<string, MediaReference>;
  spoken: Set<string>;
}

type MediaVerdict =
  | { kind: 'used' }
  | { kind: 'spoken' }
  | { kind: 'keptForBackups' }
  | { kind: 'unused'; file: UnusedMediaFile };

/** What one stored or listed file is: used, spoken audio, held for backups, or unused. */
function classifyMedia(sets: MediaCheckSets, hash: string): MediaVerdict {
  if (sets.refs.has(hash)) return { kind: 'used' };
  if (sets.spoken.has(hash)) return { kind: 'spoken' };
  const entry = sets.state.media.get(hash);
  if (!entry && sets.backup.has(hash)) return { kind: 'keptForBackups' };
  const stored = sets.stored.has(hash);
  return {
    kind: 'unused',
    file: {
      hash,
      inCollection: entry !== undefined,
      stored,
      keepFileForBackups: stored && sets.backup.has(hash),
      ...(entry ? { size: entry.size, mime: entry.mime, ext: entry.ext } : {}),
    },
  };
}

function missingMedia(sets: MediaCheckSets): MissingMediaFile[] {
  const missing: MissingMediaFile[] = [];
  const hashes = [...sets.refs.keys()].sort(compareCodeUnits);
  for (const hash of hashes) {
    const ref = sets.refs.get(hash);
    if (!ref || sets.stored.has(hash)) continue;
    missing.push({
      hash,
      noteIds: [...ref.noteIds].sort(compareCodeUnits),
      pageIds: [...ref.pageIds].sort(compareCodeUnits),
      elsewhere: ref.elsewhere,
      inCollection: sets.state.media.has(hash),
    });
  }
  return missing;
}

export function checkMedia(state: CollectionState, input: MediaCheckInput): MediaCheckReport {
  const sets: MediaCheckSets = {
    state,
    stored: lowerSet(input.storedHashes),
    backup: lowerSet(input.backupHashes),
    refs: collectMediaReferences(state),
    spoken: spokenAudioHashes(state),
  };
  const candidates = new Set<string>(sets.stored);
  for (const hash of state.media.keys()) candidates.add(hash.toLowerCase());

  const report: MediaCheckReport = {
    usedCount: 0,
    storedCount: sets.stored.size,
    unused: [],
    unusedBytes: 0,
    missing: missingMedia(sets),
    keptForBackups: 0,
    spokenAudio: 0,
  };
  for (const hash of [...candidates].sort(compareCodeUnits)) {
    const verdict = classifyMedia(sets, hash);
    if (verdict.kind === 'used') {
      if (sets.stored.has(hash)) report.usedCount += 1;
    } else if (verdict.kind === 'spoken') {
      report.spokenAudio += 1;
    } else if (verdict.kind === 'keptForBackups') {
      report.keptForBackups += 1;
    } else {
      report.unused.push(verdict.file);
      report.unusedBytes += Math.max(0, verdict.file.size ?? 0);
    }
  }
  return report;
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
