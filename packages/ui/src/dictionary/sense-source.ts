import type { DictionarySenseSource } from '@flash/core/dictionary';

/** Per-sense source badge (Phase 10: every sense shows where it came from). */
export const SENSE_SOURCE_LABEL: Readonly<Record<DictionarySenseSource, string>> = {
  krdict: 'KRDict',
  app: 'App',
};

/** Attribution for a sense's badge (its tooltip): who wrote the sense, under which terms. */
export const SENSE_SOURCE_ATTRIBUTION: Readonly<Record<DictionarySenseSource, string>> = {
  krdict:
    'From 한국어기초사전 (Korean Basic Dictionary) © National Institute of Korean Language (국립국어원), CC BY-SA 2.0 KR.',
  app: 'Written for this app in its own words; not taken from KRDict or any other dictionary.',
};

/** Badge colours: the app's own wording stands apart from dictionary text. */
export const SENSE_SOURCE_CLASS: Readonly<Record<DictionarySenseSource, string>> = {
  krdict: 'bg-[var(--surface-2)] text-[var(--muted)]',
  app: 'bg-[var(--accent-soft)] text-[var(--accent)]',
};
