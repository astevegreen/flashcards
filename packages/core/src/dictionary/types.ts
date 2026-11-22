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
  'dict-hanja-unihan' | 'dict-kanjidic2' | 'dict-cc-cedict' | 'dict-jmdict' | 'dict-krdict';

export type StrokePackId = 'strokes-ja-kanjivg' | 'strokes-zh-mmah';

/** Learner vocabulary level (KRDict 초급 / 중급 / 고급). */
export type DictionaryLevel = 'beginner' | 'intermediate' | 'advanced';

/** Short source id shown as a per-sense badge (Phase 10: every sense shows where it came from). */
export type DictionarySenseSource = 'krdict';

export interface DictionaryExample {
  /** Example in the target language, e.g. `밥을 먹어요.` */
  text: string;
  /** Optional English translation (KRDict English edition examples are usually untranslated). */
  translation?: string;
  /** `phrase` (구), `sentence` (문장) or `dialogue` (대화). */
  type?: 'phrase' | 'sentence' | 'dialogue';
}

export interface DictionarySense {
  /** English equivalents (대역어), e.g. `['eat']`. Also feed the English→Korean reverse index. */
  equivalents: string[];
  /** English definition (대역어 뜻풀이). */
  definition?: string;
  /** Target-language definition (뜻풀이), when the pack keeps it. */
  definitionNative?: string;
  examples?: DictionaryExample[];
  source?: DictionarySenseSource;
}

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
  /**
   * Phase 10 word-pack fields (all optional so Phase 6 packs decode unchanged).
   * For `dict-krdict`, `readings` holds the standard pronunciation (표준 발음, e.g. `먹따`) and
   * `altForms` holds the Hanja spelling derived from 원어 (e.g. `韓國`) so Hanja ↔ word lookups hit.
   */
  pos?: string[]; // English part-of-speech labels, e.g. ['verb']
  level?: DictionaryLevel;
  /** 원어 / word origin as written upstream, e.g. `韓國`, `工夫하다`, `computer`. */
  origin?: string;
  /** Upstream homograph number (KRDict homonym_number), 0 when unique. */
  homonym?: number;
  /** Conjugated forms listed upstream (활용), e.g. ['먹어', '먹으니', '먹는']. */
  forms?: string[];
  senses?: DictionarySense[];
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
