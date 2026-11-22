import type {
  PackCatalogDef,
  PackCatalogEntryDef,
  PackIdDef,
  PackKindDef,
} from '@flash/content-schema';
import type { HanziStrokeData, StrokeScript } from '../drawing/types.ts';

export type PackKind = PackKindDef;
export type PackId = PackIdDef;
export type PackCatalog = PackCatalogDef;
export type PackCatalogEntry = PackCatalogEntryDef;

export type DictionaryPackId =
  'dict-hanja-unihan' | 'dict-kanjidic2' | 'dict-cc-cedict' | 'dict-jmdict';

export type StrokePackId = 'strokes-ja-kanjivg' | 'strokes-zh-mmah';

export interface DictionaryEntry {
  id: string; // `${packId}:${key}`
  packId: DictionaryPackId;
  headword: string; // e.g., '學', '食', '学习', '食べる'
  altForms?: string[]; // Traditional/simplified/variant forms
  readings: string[]; // e.g., ['학'], ['ショク', 'た.べる'], ['xue2 xi2']
  meanings: string[]; // English glosses
  eumhun?: string[]; // Korean Hanja 음훈 e.g. ['배울 학']
  strokeCount?: number;
  radical?: string;
  grade?: string; // e.g., 'Education Hanja', 'JLPT N5', 'HSK 1', 'Grade 2'
  frequency?: number;
  /** Precomputed lowercase lookup tokens for IndexedDB multiEntry index. */
  searchTokens: string[];
}

export interface DictionaryPackManifest {
  format_version: 1;
  id: DictionaryPackId;
  kind: 'dictionary';
  name: string;
  version: string;
  language: string;
  description: string;
  license_name: string;
  license_url: string;
  attribution: string;
  source_url: string;
}

export interface StrokePackManifest {
  format_version: 1;
  id: StrokePackId;
  kind: 'strokes';
  name: string;
  version: string;
  language: string;
  script: StrokeScript;
  description: string;
  license_name: string;
  license_url: string;
  attribution: string;
  source_url: string;
}

export interface DictionaryPackPayload {
  manifest: DictionaryPackManifest;
  entries: Omit<DictionaryEntry, 'id' | 'packId' | 'searchTokens'>[];
}

export interface StrokePackPayload {
  manifest: StrokePackManifest;
  /** Map of single CJK character -> Hanzi Writer compatible `{ strokes, medians }` data. */
  characters: Record<string, HanziStrokeData>;
}

export type DecodedPackPayload = DictionaryPackPayload | StrokePackPayload;

export interface DataLicenseAttribution {
  id: string;
  packId?: PackId;
  name: string;
  scope: string;
  licenseName: string;
  licenseUrl: string;
  sourceUrl: string;
  attribution: string;
  noticeText: string;
}
