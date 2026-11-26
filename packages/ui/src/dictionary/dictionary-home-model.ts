import type { DictionaryBrowseFacet, DictionaryDirection } from '@flash/core/dictionary';
import type { DictionaryPackId } from '@flash/platform';

/** What the dictionary lists when nothing is typed and a browse group is open. */
export interface DictionaryBrowseSelection {
  packId: DictionaryPackId;
  facet: DictionaryBrowseFacet;
  /** Heading shown above the list, e.g. `Beginner · 초급`. */
  title: string;
  initial?: string;
  pos?: string;
}

/**
 * English names for KRDict topic groups (주제 및 상황 범주 and the top level of 의미 범주).
 * Topics missing here show in Korean only.
 */
const TOPIC_LABEL: Readonly<Record<string, string>> = {
  // 주제 및 상황 범주
  인사하기: 'Greetings',
  소개하기: 'Introductions',
  '소개하기(자기소개)': 'Introducing yourself',
  '소개하기(가족 소개)': 'Introducing family',
  '개인 정보 교환하기': 'Personal details',
  '위치 표현하기': 'Locations',
  길찾기: 'Directions',
  '교통 이용하기': 'Transport',
  '물건 사기': 'Shopping',
  '음식 주문하기': 'Ordering food',
  '요리 설명하기': 'Cooking',
  '시간 표현하기': 'Telling the time',
  '날짜 표현하기': 'Dates',
  '요일 표현하기': 'Days of the week',
  '날씨 표현하기': 'Weather',
  '하루 생활': 'Daily life',
  학교생활: 'School life',
  '직장 생활': 'Work life',
  '한국 생활': 'Life in Korea',
  약속하기: 'Making plans',
  전화하기: 'Phone calls',
  감사하기: 'Thanks',
  사과하기: 'Apologies',
  여행: 'Travel',
  취미: 'Hobbies',
  '여가 생활': 'Leisure',
  건강: 'Health',
  '병원 이용하기': 'At the hospital',
  '공공 기관 이용하기': 'Public services',
  '감정, 기분 표현하기': 'Feelings',
  '성격 표현하기': 'Personality',
  '외모 표현하기': 'Appearance',
  '집 구하기': 'Finding a home',
  집안일: 'Housework',
  '가족 행사': 'Family events',
  '사건, 사고, 재해 기술하기': 'Accidents and disasters',
  '문화 비교하기': 'Comparing cultures',
  // 의미 범주 (top level)
  인간: 'People',
  삶: 'Life',
  식생활: 'Food and eating',
  의생활: 'Clothing',
  주생활: 'Home',
  '사회 생활': 'Society',
  '경제 생활': 'Money and work',
  교육: 'Education',
  종교: 'Religion',
  문화: 'Culture',
  '정치와 행정': 'Politics',
  자연: 'Nature',
  동식물: 'Animals and plants',
  개념: 'Concepts',
};

/** `Ordering food · 음식 주문하기`, or the Korean topic alone. */
export function topicLabel(topic: string): string {
  const en = TOPIC_LABEL[topic];
  return en ? `${en} · ${topic}` : topic;
}

const PART_OF_SPEECH_LABEL: Readonly<Record<string, string>> = {
  noun: 'Nouns',
  verb: 'Verbs',
  adjective: 'Adjectives',
  adverb: 'Adverbs',
  pronoun: 'Pronouns',
  numeral: 'Numerals',
  determiner: 'Determiners',
  interjection: 'Interjections',
  particle: 'Particles',
  'bound noun': 'Bound nouns',
  'auxiliary verb': 'Auxiliary verbs',
  'auxiliary adjective': 'Auxiliary adjectives',
  affix: 'Affixes',
  ending: 'Endings',
};

export function partOfSpeechLabel(pos: string): string {
  return PART_OF_SPEECH_LABEL[pos] ?? pos;
}

export const MAX_RECENT_LOOKUPS = 8;

/** `query` moved to the front of the recent list (deduplicated, capped). */
export function pushRecentLookup(recents: readonly string[], query: string): string[] {
  const q = query.normalize('NFC').trim();
  if (!q) return [...recents];
  return [q, ...recents.filter((r) => r !== q)].slice(0, MAX_RECENT_LOOKUPS);
}

const RECENT_KEY = 'flash:dictionary:recent';
const DIRECTION_KEY = 'flash:dictionary:direction';

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage blocked (private mode, quota): remembering is a convenience only.
  }
}

/** Recent lookups on this device only (never synced). */
export function readRecentLookups(): string[] {
  const raw = readStorage(RECENT_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .slice(0, MAX_RECENT_LOOKUPS);
  } catch {
    return [];
  }
}

export function writeRecentLookups(recents: readonly string[]): void {
  writeStorage(RECENT_KEY, recents.length > 0 ? JSON.stringify(recents) : null);
}

export function readLookupDirection(): DictionaryDirection {
  return readStorage(DIRECTION_KEY) === 'from-english' ? 'from-english' : 'to-english';
}

export function writeLookupDirection(direction: DictionaryDirection): void {
  writeStorage(DIRECTION_KEY, direction);
}

const LANGUAGE_NAME: Readonly<Record<string, string>> = {
  ko: '한국어',
  ja: '日本語',
  'zh-Hans': '中文',
};

/** The target-language name on the direction toggle: the filtered pack's, else Korean first. */
export function directionTargetName(languages: readonly string[]): string {
  const lang = languages.includes('ko') ? 'ko' : languages[0];
  return (lang && LANGUAGE_NAME[lang]) ?? 'Target';
}

/**
 * Runs dictionary searches so that only the newest one applies its results (C15). A slow search
 * for an earlier query that finishes after a later one is dropped, a failed search shows no
 * results instead of an unhandled rejection, and `setBusy` ends with the newest search.
 */
export function createLatestSearch<T>(
  apply: (results: T[]) => void,
  setBusy: (busy: boolean) => void,
): (search: (() => Promise<T[]>) | null) => Promise<void> {
  let latest = 0;
  return async (search) => {
    latest += 1;
    const id = latest;
    if (!search) {
      apply([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const results = await search();
      if (id === latest) apply(results);
    } catch {
      if (id === latest) apply([]);
    } finally {
      if (id === latest) setBusy(false);
    }
  };
}
