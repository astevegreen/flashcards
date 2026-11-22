/**
 * Korean-aware dictionary search (Phase 10, docs/design_blueprint.md):
 * - Hangul syllable (de)composition, 초성 (initial consonant) keys and jamo-insensitive prefix keys
 * - rule-based deinflection of verb/adjective endings, irregular conjugations included
 *   (ㅂ, ㄷ, ㅅ, ㅎ, 르, 러, 우, ㄹ-deletion, ㅡ-elision, 하다/되다 contractions)
 * - Revised Romanization → Hangul candidates (with resyllabification so `meogeosseoyo` → `먹었어요`)
 * - English equivalent normalization for the English → Korean reverse index
 *
 * Every function here over-generates candidates on purpose; callers validate them against the
 * installed pack's headwords (an IndexedDB `headword` lookup or an in-memory `Set`), so a bogus
 * candidate simply finds nothing. Pure TypeScript only (packages/core purity).
 */

const S_BASE = 0xac00;
const S_LAST = 0xd7a3;
const V_COUNT = 21;
const T_COUNT = 28;

/** The 19 initial consonants in Unicode order (compatibility jamo). */
export const CHOSEONG_JAMO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNGSEONG_JAMO = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONGSEONG_JAMO = [
  '',
  'ㄱ',
  'ㄲ',
  'ㄳ',
  'ㄴ',
  'ㄵ',
  'ㄶ',
  'ㄷ',
  'ㄹ',
  'ㄺ',
  'ㄻ',
  'ㄼ',
  'ㄽ',
  'ㄾ',
  'ㄿ',
  'ㅀ',
  'ㅁ',
  'ㅂ',
  'ㅄ',
  'ㅅ',
  'ㅆ',
  'ㅇ',
  'ㅈ',
  'ㅊ',
  'ㅋ',
  'ㅌ',
  'ㅍ',
  'ㅎ',
] as const;

/** Clusters and compound vowels split into the keys a 2-set keyboard types, for prefix keys. */
const JAMO_SPLIT: Readonly<Record<string, string>> = {
  ㄳ: 'ㄱㅅ',
  ㄵ: 'ㄴㅈ',
  ㄶ: 'ㄴㅎ',
  ㄺ: 'ㄹㄱ',
  ㄻ: 'ㄹㅁ',
  ㄼ: 'ㄹㅂ',
  ㄽ: 'ㄹㅅ',
  ㄾ: 'ㄹㅌ',
  ㄿ: 'ㄹㅍ',
  ㅀ: 'ㄹㅎ',
  ㅄ: 'ㅂㅅ',
  ㅘ: 'ㅗㅏ',
  ㅙ: 'ㅗㅐ',
  ㅚ: 'ㅗㅣ',
  ㅝ: 'ㅜㅓ',
  ㅞ: 'ㅜㅔ',
  ㅟ: 'ㅜㅣ',
  ㅢ: 'ㅡㅣ',
};

export interface HangulSyllableParts {
  /** Initial consonant index 0–18 (ㄱ…ㅎ, 11 = ㅇ). */
  l: number;
  /** Vowel index 0–20 (ㅏ…ㅣ). */
  v: number;
  /** Final consonant index 0–27 (0 = none). */
  t: number;
}

export function isHangulSyllable(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return ch.length === 1 && cp >= S_BASE && cp <= S_LAST;
}

/** True when `text` contains a Hangul syllable or compatibility jamo. */
export function containsHangul(text: string): boolean {
  return /[가-힣ㄱ-ㆎ]/.test(text);
}

function isAllHangulSyllables(text: string): boolean {
  return text.length > 0 && /^[가-힣]+$/.test(text);
}

export function decomposeHangulSyllable(ch: string): HangulSyllableParts | undefined {
  if (!isHangulSyllable(ch)) return undefined;
  const idx = (ch.codePointAt(0) ?? 0) - S_BASE;
  return {
    l: Math.floor(idx / (V_COUNT * T_COUNT)),
    v: Math.floor((idx % (V_COUNT * T_COUNT)) / T_COUNT),
    t: idx % T_COUNT,
  };
}

export function composeHangulSyllable(l: number, v: number, t = 0): string {
  return String.fromCodePoint(S_BASE + (l * V_COUNT + v) * T_COUNT + t);
}

/** `한국어` → `ㅎㄱㅇ`. Non-Hangul characters are dropped; typed compatibility consonants are kept. */
export function toChoseong(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const parts = decomposeHangulSyllable(ch);
    if (parts) out += CHOSEONG_JAMO[parts.l] ?? '';
    else if (CHOSEONG_JAMO.includes(ch)) out += ch;
  }
  return out;
}

/** True when the query is only initial consonants (e.g. `ㅎㄱ`), the 초성 search gesture. */
export function isChoseongQuery(query: string): boolean {
  const q = query.normalize('NFC').replace(/\s+/g, '');
  if (q.length === 0) return false;
  for (const ch of q) {
    if (!CHOSEONG_JAMO.includes(ch)) return false;
  }
  return true;
}

/**
 * Jamo-insensitive key: every syllable decomposed into the keys typed on a 2-set keyboard
 * (`한국` → `ㅎㅏㄴㄱㅜㄱ`, `과` → `ㄱㅗㅏ`). A half-composed query (`한ㄱ`, `하`) is a prefix of the key
 * of every word it could become, which is what makes mid-IME prefix matching cheap.
 */
export function toJamoKey(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const parts = decomposeHangulSyllable(ch);
    if (parts) {
      const l = CHOSEONG_JAMO[parts.l] ?? '';
      const v = JUNGSEONG_JAMO[parts.v] ?? '';
      const t = JONGSEONG_JAMO[parts.t] ?? '';
      out += l + (JAMO_SPLIT[v] ?? v) + (JAMO_SPLIT[t] ?? t);
    } else if (/[ㄱ-ㆎ]/.test(ch)) {
      out += JAMO_SPLIT[ch] ?? ch;
    } else if (!/\s/.test(ch)) {
      out += ch.toLowerCase();
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Deinflection                                                                                */
/* ------------------------------------------------------------------------------------------ */

const L_R = 5; // ㄹ
const L_NG = 11; // ㅇ
const L_H = 18; // ㅎ
const V_A = 0;
const V_AE = 1;
const V_YA = 2;
const V_YAE = 3;
const V_EO = 4;
const V_E = 5;
const V_YEO = 6;
const V_O = 8;
const V_WA = 9;
const V_WAE = 10;
const V_OE = 11;
const V_U = 13;
const V_WO = 14;
const V_EU = 18;
const V_I = 20;
const T_N = 4;
const T_D = 7;
const T_L = 8;
const T_B = 17;
const T_S = 19;
const T_SS = 20;
const T_H = 27;

/** Endings that attach to any stem unchanged (`먹고`, `가고`, `먹습니다`, pre-final `겠`). */
const DIRECT_ENDINGS = [
  '다',
  '고',
  '고요',
  '고서',
  '지',
  '지만',
  '지요',
  '지도',
  '죠',
  '게',
  '기',
  '기로',
  '던',
  '거나',
  '자',
  '다가',
  '도록',
  '군요',
  '는군요',
  '잖아요',
  '네',
  '네요',
  '나요',
  '니',
  '는',
  '는데',
  '는데요',
  '는지',
  '는다',
  '습니다',
  '습니까',
  '겠',
] as const;
/** ㄹ-stems drop their ㄹ before ㄴ-initial endings (`살다` → `사는`, `사네요`, `사니`). */
const L_DROP_DIRECT_INITIAL = new Set(['는', '네', '니', '나']);

/** Endings that follow vowel stems and ㄹ-stems directly, or consonant stems after `으`. */
const VOWEL_ENDINGS = [
  '면',
  '면서',
  '니까',
  '세요',
  '셔요',
  '십니다',
  '십시오',
  '시',
  '셨',
  '시겠',
  '려고',
  '려면',
  '러',
  '며',
] as const;
/** ㄹ-stems drop their ㄹ before these (`사세요`, `사십니다`, `사니까`), but keep it before `면`. */
const L_DROP_VOWEL_ENDINGS: ReadonlySet<string> = new Set([
  '니까',
  '세요',
  '셔요',
  '십니다',
  '십시오',
  '시',
  '셨',
  '시겠',
]);
const EU_ENDINGS: readonly string[] = [
  ...VOWEL_ENDINGS.map((e) => `으${e}`),
  '은',
  '은데',
  '은데요',
  '은지',
  '을',
  '을까',
  '을까요',
  '을게',
  '을게요',
  '을래',
  '을래요',
  '을지',
  '을수록',
  '읍시다',
];

/** Endings fused onto the stem's last syllable as a final consonant: `간`, `갈까요`, `갑니다`. */
const BATCHIM_ENDINGS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [T_N, ['', '다', '데', '데요', '가요', '지']],
  [T_L, ['', '까', '까요', '게', '게요', '래', '래요', '지', '수록']],
  [T_B, ['니다', '니까', '시다']],
];

/** What may follow the 아/어 vowel: `먹어`, `먹어요`, `먹어서`, `먹어도`, `먹어야` … */
const AO_FOLLOWERS = ['', '요', '서', '서요', '도', '도요', '야', '야지', '야지요', '라'] as const;

/** Noun particles and the copula, so `한국어를`, `학교에서`, `친구예요` find the noun. */
const NOUN_PARTICLES = [
  '이에요',
  '예요',
  '입니다',
  '이다',
  '이야',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '에',
  '에서',
  '에게',
  '한테',
  '께',
  '께서',
  '와',
  '과',
  '하고',
  '이랑',
  '랑',
  '도',
  '만',
  '의',
  '로',
  '으로',
  '까지',
  '부터',
  '보다',
  '처럼',
  '요',
] as const;

function lastSyllable(s: string): HangulSyllableParts | undefined {
  return s.length > 0 ? decomposeHangulSyllable(s.slice(-1)) : undefined;
}

function replaceLast(s: string, parts: HangulSyllableParts): string {
  return s.slice(0, -1) + composeHangulSyllable(parts.l, parts.v, parts.t);
}

function withFinal(s: string, t: number): string | undefined {
  const parts = lastSyllable(s);
  return parts ? replaceLast(s, { ...parts, t }) : undefined;
}

/**
 * Undoes the 아/어 vowel attaching to a stem, where `r` ends with the syllable carrying it
 * (`먹어` → `먹`, `가` → `가`, `봐` → `보`, `해` → `하`, `몰라` → `모르`, `추워` → `춥`, …).
 */
function undoAoVowel(r: string): string[] {
  const s = lastSyllable(r);
  if (!s || s.t !== 0) return [];
  const out: string[] = [];
  const prefix = r.slice(0, -1);
  const prev = lastSyllable(prefix);
  const self = (v: number, t = 0): string => prefix + composeHangulSyllable(s.l, v, t);

  // Uncontracted 아/어/여 syllable after the stem: 먹어, 보아, 하여; ㄷ-irregular 들어 → 듣; ㅅ-irregular 나아 → 낫.
  if (s.l === L_NG && (s.v === V_A || s.v === V_EO || s.v === V_YEO) && prev) {
    out.push(prefix);
    if (prev.t === T_L) out.push(replaceLast(prefix, { ...prev, t: T_D }));
    if (prev.t === 0) out.push(replaceLast(prefix, { ...prev, t: T_S }));
  }

  switch (s.v) {
    case V_A:
      out.push(r); // 가 → 가
      out.push(self(V_EU)); // 바빠 → 바쁘 (ㅡ elision)
      if (s.l === L_R && prev && prev.t === T_L) {
        out.push(replaceLast(prefix, { ...prev, t: 0 }) + '르'); // 몰라 → 모르 (르 irregular)
      }
      break;
    case V_EO:
      out.push(r); // 서 → 서
      out.push(self(V_EU)); // 써 → 쓰, 커 → 크
      out.push(self(V_U)); // 퍼 → 푸 (우 irregular)
      if (s.l === L_R && prev && prev.t === T_L) {
        out.push(replaceLast(prefix, { ...prev, t: 0 }) + '르'); // 불러 → 부르
      }
      if (s.l === L_R && prefix.endsWith('르')) out.push(prefix); // 푸르러 → 푸르 (러 irregular)
      break;
    case V_WA:
      out.push(self(V_O)); // 봐 → 보, 와 → 오
      if (s.l === L_NG && prev && prev.t === 0) out.push(replaceLast(prefix, { ...prev, t: T_B })); // 도와 → 돕
      break;
    case V_WO:
      out.push(self(V_U)); // 줘 → 주, 배워 → 배우
      if (s.l === L_NG && prev && prev.t === 0) out.push(replaceLast(prefix, { ...prev, t: T_B })); // 추워 → 춥
      break;
    case V_YEO:
      out.push(self(V_I)); // 마셔 → 마시
      out.push(r); // 펴 → 펴
      break;
    case V_AE:
      if (s.l === L_H) out.push(self(V_A)); // 해 → 하 (하다 contraction)
      out.push(r); // 보내 → 보내
      out.push(self(V_A, T_H)); // 파래 → 파랗 (ㅎ irregular)
      out.push(self(V_EO, T_H)); // 그래 → 그렇
      break;
    case V_YAE:
      out.push(self(V_YA, T_H)); // 하얘 → 하얗
      out.push(r);
      break;
    case V_WAE:
      out.push(self(V_OE)); // 돼 → 되
      break;
    case V_E:
      out.push(r);
      break;
    default:
      out.push(r);
  }
  return out;
}

/** Stems that a vowel-attaching ending (`면`, `세요`, fused `ㄴ`/`ㄹ`/`ㅂ`) can sit on. */
function pushVowelStems(x: string, lDrop: boolean, out: string[]): void {
  const lx = lastSyllable(x);
  if (!lx) return;
  if (lx.t === 0) {
    out.push(x); // 가면 → 가
    if (lDrop) out.push(replaceLast(x, { ...lx, t: T_L })); // 사세요 → 살
    out.push(replaceLast(x, { ...lx, t: T_H })); // 파라면 → 파랗 (ㅎ irregular)
    if (lx.l === L_NG && lx.v === V_U && x.length >= 2) {
      const p = x.slice(0, -1);
      const lp = lastSyllable(p);
      if (lp && lp.t === 0) out.push(replaceLast(p, { ...lp, t: T_B })); // 추우면 → 춥 (ㅂ irregular)
    }
  } else if (lx.t === T_L) {
    out.push(x); // 살면 → 살
  }
}

/** One deinflection step: every stem the surface form `s` could have been built from. */
function expandSurface(s: string): string[] {
  const out: string[] = [];

  for (const e of DIRECT_ENDINGS) {
    if (s.length <= e.length || !s.endsWith(e)) continue;
    const x = s.slice(0, -e.length);
    out.push(x);
    if (L_DROP_DIRECT_INITIAL.has(e.slice(0, 1))) {
      const lx = lastSyllable(x);
      if (lx && lx.t === 0) out.push(replaceLast(x, { ...lx, t: T_L }));
    }
  }

  for (const e of EU_ENDINGS) {
    if (s.length <= e.length || !s.endsWith(e)) continue;
    const x = s.slice(0, -e.length);
    const lx = lastSyllable(x);
    if (!lx) continue;
    if (lx.t !== 0) {
      out.push(x); // 먹으면 → 먹
      if (lx.t === T_L) out.push(replaceLast(x, { ...lx, t: T_D })); // 들으면 → 듣 (ㄷ irregular)
    } else {
      out.push(replaceLast(x, { ...lx, t: T_S })); // 나으면 → 낫 (ㅅ irregular)
    }
  }

  for (const e of VOWEL_ENDINGS) {
    if (s.length <= e.length || !s.endsWith(e)) continue;
    pushVowelStems(s.slice(0, -e.length), L_DROP_VOWEL_ENDINGS.has(e), out);
  }

  for (const [t, rests] of BATCHIM_ENDINGS) {
    for (const rest of rests) {
      if (s.length <= rest.length || !s.endsWith(rest)) continue;
      const r = rest.length > 0 ? s.slice(0, -rest.length) : s;
      const lr = lastSyllable(r);
      if (!lr || lr.t !== t) continue;
      const open = withFinal(r, 0);
      if (open) pushVowelStems(open, true, out); // 간다 → 가, 산 → 살, 추운 → 춥, 파란 → 파랗
    }
  }

  for (const f of AO_FOLLOWERS) {
    if (f.length > 0 && (s.length <= f.length || !s.endsWith(f))) continue;
    out.push(...undoAoVowel(f.length > 0 ? s.slice(0, -f.length) : s));
  }

  // Past 았/었/였, possibly fused into the stem (갔, 봤, 했, 됐, 몰랐, 추웠, 셨).
  const ls = lastSyllable(s);
  if (ls && ls.t === T_SS) {
    const open = withFinal(s, 0);
    if (open) out.push(...undoAoVowel(open));
  }

  return out;
}

export interface KoreanLemmaCandidate {
  /** Dictionary form to look up, e.g. `먹다`, or a bare noun such as `한국`. */
  lemma: string;
  /** Number of rules applied (0 = the input itself). Lower ranks higher. */
  steps: number;
}

export interface DeinflectOptions {
  maxDepth?: number;
  maxCandidates?: number;
}

/**
 * Rule-based deinflection: `먹었어요` → `먹다`, `도와요` → `돕다`, `들어요` → `듣다`,
 * `몰라요` → `모르다`, `사세요` → `살다`, `공부해요` → `공부하다` (and `공부`), `학교에서` → `학교`.
 * Over-generates on purpose; validate with `lookupKoreanLemmas` or a headword index.
 */
export function deinflectKorean(word: string, opts: DeinflectOptions = {}): KoreanLemmaCandidate[] {
  const w = word.normalize('NFC').replace(/\s+/g, '');
  if (!isAllHangulSyllables(w)) return [];
  const maxDepth = opts.maxDepth ?? 5;
  const maxCandidates = opts.maxCandidates ?? 200;

  const best = new Map<string, number>();
  const add = (lemma: string, steps: number): void => {
    const prev = best.get(lemma);
    if (prev === undefined || steps < prev) best.set(lemma, steps);
  };
  add(w, 0);

  // BFS over two kinds of state: noun states (the input, or a noun with particles peeled off)
  // may lose further particles (`학교에서도` → `학교에서` → `학교`); every state may also be a
  // conjugated predicate. Verb stems are not particle-stripped, so `도와` never yields `도`.
  const visited = new Set<string>([`n:${w}`]);
  const queue: Array<readonly [string, number, boolean]> = [[w, 0, true]];
  const enqueue = (state: string, depth: number, noun: boolean): void => {
    const key = `${noun ? 'n' : 'v'}:${state}`;
    if (!visited.has(key) && visited.size < 400) {
      visited.add(key);
      queue.push([state, depth, noun]);
    }
  };
  for (let head = 0; head < queue.length; head++) {
    const item = queue[head];
    if (!item) break;
    const [state, depth, noun] = item;
    if (depth >= maxDepth) continue;
    if (noun) {
      for (const p of NOUN_PARTICLES) {
        if (state.length <= p.length || !state.endsWith(p)) continue;
        const bare = state.slice(0, -p.length);
        add(bare, depth + 1);
        enqueue(bare, depth + 1, true);
      }
    }
    for (const stem of expandSurface(state)) {
      if (!isAllHangulSyllables(stem)) continue;
      add(`${stem}다`, depth + 1);
      // Copula stem 이 (`학생이었어요` → `학생이`, `친구였어요` → `친구이`, `선생님이세요`) → the noun.
      if (stem.length >= 2) {
        const last = lastSyllable(stem);
        if (last && last.l === L_NG && last.v === V_I && last.t === 0) {
          add(stem.slice(0, -1), depth + 2);
        }
      }
      enqueue(stem, depth + 1, false);
    }
  }

  // 하다-verbs also suggest their noun: 공부해요 → 공부하다 → 공부.
  for (const [lemma, steps] of [...best]) {
    if (steps > 0 && lemma.length > 2 && lemma.endsWith('하다')) add(lemma.slice(0, -2), steps + 1);
  }

  return [...best]
    .map(([lemma, steps]) => ({ lemma, steps }))
    .sort((a, b) => a.steps - b.steps || (a.lemma < b.lemma ? -1 : a.lemma > b.lemma ? 1 : 0))
    .slice(0, maxCandidates);
}

/** Deinflects `word` and keeps only lemmas the pack actually has, best first. */
export function lookupKoreanLemmas(
  word: string,
  hasHeadword: (headword: string) => boolean,
): KoreanLemmaCandidate[] {
  return deinflectKorean(word).filter((c) => hasHeadword(c.lemma));
}

/* ------------------------------------------------------------------------------------------ */
/* Revised Romanization → Hangul                                                               */
/* ------------------------------------------------------------------------------------------ */

interface RomPiece {
  s: string;
  idx: number;
  cost: number;
}

const ROM_INITIALS: readonly RomPiece[] = [
  { s: 'kk', idx: 1, cost: 0 },
  { s: 'tt', idx: 4, cost: 0 },
  { s: 'pp', idx: 8, cost: 0 },
  { s: 'ss', idx: 10, cost: 0 },
  { s: 'jj', idx: 13, cost: 0 },
  { s: 'ch', idx: 14, cost: 0 },
  { s: 'g', idx: 0, cost: 0 },
  { s: 'n', idx: 2, cost: 0 },
  { s: 'd', idx: 3, cost: 0 },
  { s: 'r', idx: 5, cost: 0 },
  { s: 'm', idx: 6, cost: 0 },
  { s: 'b', idx: 7, cost: 0 },
  { s: 's', idx: 9, cost: 0 },
  { s: 'j', idx: 12, cost: 0 },
  { s: 'k', idx: 15, cost: 0 },
  { s: 't', idx: 16, cost: 0 },
  { s: 'p', idx: 17, cost: 0 },
  { s: 'h', idx: 18, cost: 0 },
  // Lenient spellings people actually type (McCune–Reischauer-ish `kimchi`, `shi`, loanword `l`).
  { s: 'k', idx: 0, cost: 1 },
  { s: 't', idx: 3, cost: 1 },
  { s: 'p', idx: 7, cost: 1 },
  { s: 'l', idx: 5, cost: 1 },
  { s: 'sh', idx: 9, cost: 1 },
  { s: 'ch', idx: 12, cost: 1 },
];

const ROM_VOWELS: readonly RomPiece[] = [
  { s: 'yae', idx: 3, cost: 0 },
  { s: 'wae', idx: 10, cost: 0 },
  { s: 'yeo', idx: 6, cost: 0 },
  { s: 'ae', idx: 1, cost: 0 },
  { s: 'ya', idx: 2, cost: 0 },
  { s: 'eo', idx: 4, cost: 0 },
  { s: 'ye', idx: 7, cost: 0 },
  { s: 'wa', idx: 9, cost: 0 },
  { s: 'oe', idx: 11, cost: 0 },
  { s: 'yo', idx: 12, cost: 0 },
  { s: 'wo', idx: 14, cost: 0 },
  { s: 'we', idx: 15, cost: 0 },
  { s: 'wi', idx: 16, cost: 0 },
  { s: 'yu', idx: 17, cost: 0 },
  { s: 'eu', idx: 18, cost: 0 },
  { s: 'ui', idx: 19, cost: 0 },
  { s: 'a', idx: 0, cost: 0 },
  { s: 'e', idx: 5, cost: 0 },
  { s: 'o', idx: 8, cost: 0 },
  { s: 'u', idx: 13, cost: 0 },
  { s: 'i', idx: 20, cost: 0 },
];

const ROM_FINALS: readonly RomPiece[] = [
  { s: 'ng', idx: 21, cost: 0 },
  { s: 'k', idx: 1, cost: 0 },
  { s: 'n', idx: 4, cost: 0 },
  { s: 't', idx: 7, cost: 0 },
  { s: 'l', idx: 8, cost: 0 },
  { s: 'm', idx: 16, cost: 0 },
  { s: 'p', idx: 17, cost: 0 },
  // Spelling-based finals (RR is pronunciation-based; learners often romanize the spelling).
  { s: 'g', idx: 1, cost: 1 },
  { s: 'kk', idx: 2, cost: 1 },
  { s: 's', idx: 19, cost: 1 },
  { s: 'ss', idx: 20, cost: 1 },
  { s: 'b', idx: 17, cost: 1 },
  { s: 'd', idx: 7, cost: 1 },
];

/** Final consonant index for an initial moved back across a syllable boundary (연음 reversed). */
const INITIAL_TO_FINAL: Readonly<Record<number, number>> = {
  0: 1, // ㄱ
  1: 2, // ㄲ
  2: 4, // ㄴ
  3: 7, // ㄷ
  5: 8, // ㄹ
  6: 16, // ㅁ
  7: 17, // ㅂ
  9: 19, // ㅅ
  10: 20, // ㅆ
  12: 22, // ㅈ
  14: 23, // ㅊ
  15: 24, // ㅋ
  16: 25, // ㅌ
  17: 26, // ㅍ
  18: 27, // ㅎ
};

export interface RomanizationCandidate {
  hangul: string;
  /** 0 = strict Revised Romanization; each lenient letter or resyllabification adds 1. */
  cost: number;
}

const ROM_RE = /^[a-z][a-z'\-\s]*$/;
const MAX_ROM_PARSES = 48;

function parseRomanChunk(chunk: string): RomanizationCandidate[] {
  const memo = new Map<number, RomanizationCandidate[]>();
  const parseFrom = (i: number): RomanizationCandidate[] => {
    if (i === chunk.length) return [{ hangul: '', cost: 0 }];
    const cached = memo.get(i);
    if (cached) return cached;
    const found = new Map<string, number>();
    // A vowel right after a vowel (`e|o` in `meo`) is far more often one RR digraph than two syllables.
    const hiatus =
      i > 0 && 'aeiouwy'.includes(chunk[i - 1] ?? '') && 'aeiou'.includes(chunk[i] ?? '');
    const initials: RomPiece[] = [
      { s: '', idx: L_NG, cost: hiatus ? 0.5 : 0 },
      ...ROM_INITIALS.filter((p) => chunk.startsWith(p.s, i)).map((p) =>
        // RR writes ㄹㄹ as ll (몰라 → molla), so l after a final l is strict.
        p.s === 'l' && chunk[i - 1] === 'l' ? { ...p, cost: 0 } : p,
      ),
    ];
    for (const init of initials) {
      const j = i + init.s.length;
      for (const vowel of ROM_VOWELS) {
        if (!chunk.startsWith(vowel.s, j)) continue;
        const k = j + vowel.s.length;
        const finals: RomPiece[] = [
          { s: '', idx: 0, cost: 0 },
          ...ROM_FINALS.filter((p) => chunk.startsWith(p.s, k)),
        ];
        for (const fin of finals) {
          const syl = composeHangulSyllable(init.idx, vowel.idx, fin.idx);
          for (const rest of parseFrom(k + fin.s.length)) {
            const text = syl + rest.hangul;
            const cost = init.cost + vowel.cost + fin.cost + rest.cost;
            const prev = found.get(text);
            if (prev === undefined || cost < prev) found.set(text, cost);
          }
        }
      }
    }
    const list = [...found]
      .map(([hangul, cost]) => ({ hangul, cost }))
      .sort(
        (a, b) => a.cost - b.cost || a.hangul.length - b.hangul.length || cmp(a.hangul, b.hangul),
      )
      .slice(0, MAX_ROM_PARSES);
    memo.set(i, list);
    return list;
  };
  return parseFrom(0);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** RR writes pronunciation (`먹었어요` → `meogeosseoyo`); move initials back into finals to recover spellings. */
function resyllabifications(hangul: string, maxMoves = 3): RomanizationCandidate[] {
  const out: RomanizationCandidate[] = [];
  const walk = (chars: string[], from: number, moves: number): void => {
    out.push({ hangul: chars.join(''), cost: moves * 0.5 });
    if (moves >= maxMoves) return;
    for (let i = from; i < chars.length - 1; i++) {
      const a = decomposeHangulSyllable(chars[i] ?? '');
      const b = decomposeHangulSyllable(chars[i + 1] ?? '');
      if (!a || !b || a.t !== 0 || b.l === L_NG) continue;
      const fin = INITIAL_TO_FINAL[b.l];
      if (fin === undefined) continue;
      const next = [...chars];
      next[i] = composeHangulSyllable(a.l, a.v, fin);
      next[i + 1] = composeHangulSyllable(L_NG, b.v, b.t);
      walk(next, i + 1, moves + 1);
    }
  };
  walk([...hangul], 0, 0);
  return out;
}

/**
 * Revised Romanization (plus common lenient spellings) → Hangul candidates, best first:
 * `hanguk` → `한국`, `meogeosseoyo` → `머거써요` … `먹었어요`. Returns `[]` for non-Latin input.
 */
export function romanizationToHangul(input: string, maxResults = 24): RomanizationCandidate[] {
  const q = input.normalize('NFC').trim().toLowerCase();
  if (q.length < 2 || q.length > 40 || !ROM_RE.test(q)) return [];
  const chunks = q.split(/[\s'-]+/).filter(Boolean);
  let combos: RomanizationCandidate[] = [{ hangul: '', cost: 0 }];
  for (const chunk of chunks) {
    const parsed = parseRomanChunk(chunk);
    if (parsed.length === 0) return [];
    const next: RomanizationCandidate[] = [];
    for (const a of combos) {
      for (const b of parsed) next.push({ hangul: a.hangul + b.hangul, cost: a.cost + b.cost });
    }
    combos = next
      .sort((a, b) => a.cost - b.cost || cmp(a.hangul, b.hangul))
      .slice(0, MAX_ROM_PARSES);
  }
  const best = new Map<string, number>();
  for (const c of combos) {
    for (const v of resyllabifications(c.hangul)) {
      const cost = c.cost + v.cost;
      const prev = best.get(v.hangul);
      if (prev === undefined || cost < prev) best.set(v.hangul, cost);
    }
  }
  return [...best]
    .map(([hangul, cost]) => ({ hangul, cost }))
    .sort((a, b) => a.cost - b.cost || cmp(a.hangul, b.hangul))
    .slice(0, maxResults);
}

/* ------------------------------------------------------------------------------------------ */
/* English equivalents (reverse index)                                                         */
/* ------------------------------------------------------------------------------------------ */

/** `To eat` → `eat`, `a book` → `book`, `be cold.` → `be cold`. Used on both index and query side. */
export function normalizeEnglishEquivalent(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[()[\]"“”‘’.!?;:,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:to|a|an|the)\s+/, '')
    .trim();
}

/* ------------------------------------------------------------------------------------------ */
/* Query analysis                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface KoreanQueryAnalysis {
  /** Deinflected lemma → steps, for Hangul queries (includes the query itself at 0). */
  lemmas: Map<string, number>;
  /** Hangul candidate or its deinflected lemma → cost, for romanized queries. */
  romanized: Map<string, number>;
  /** Set when the query is only initial consonants. */
  choseong?: string;
  /** Jamo key of a Hangul query, for jamo-insensitive prefix matching. */
  jamoKey?: string;
  /** Jamo keys of the best romanization parses, for prefix matching while typing (`hangu`). */
  romanizedJamoPrefixes: string[];
  /** Normalized English key for the reverse index. */
  english?: string;
}

const MAX_ROMANIZED_FOR_DEINFLECTION = 24;
const MAX_ROMANIZED_LEMMAS = 400;

let lastAnalysis: { raw: string; value: KoreanQueryAnalysis } | undefined;

/** Analyzes a raw query once (memoized for the last query, since ranking re-asks per entry). */
export function analyzeKoreanQuery(rawQuery: string): KoreanQueryAnalysis {
  const raw = rawQuery.normalize('NFC').trim();
  if (lastAnalysis && lastAnalysis.raw === raw) return lastAnalysis.value;

  const lemmas = new Map<string, number>();
  const romanized = new Map<string, number>();
  const romanizedJamoPrefixes: string[] = [];
  let choseong: string | undefined;
  let jamoKey: string | undefined;
  let english: string | undefined;

  const compact = raw.replace(/\s+/g, '');
  if (compact && isChoseongQuery(compact)) {
    choseong = compact;
  } else if (compact && containsHangul(compact)) {
    jamoKey = toJamoKey(compact);
    for (const c of deinflectKorean(compact)) lemmas.set(c.lemma, c.steps);
  } else if (/[a-z]/i.test(raw)) {
    english = normalizeEnglishEquivalent(raw) || undefined;
    const roms = romanizationToHangul(raw);
    for (const r of roms) {
      if (!romanized.has(r.hangul)) romanized.set(r.hangul, r.cost);
    }
    for (const r of roms.slice(0, MAX_ROMANIZED_FOR_DEINFLECTION)) {
      for (const c of deinflectKorean(r.hangul, { maxCandidates: 80 })) {
        if (c.steps === 0) continue;
        const cost = r.cost + c.steps * 0.25;
        const prev = romanized.get(c.lemma);
        if (prev === undefined || cost < prev) romanized.set(c.lemma, cost);
        if (romanized.size >= MAX_ROMANIZED_LEMMAS) break;
      }
    }
    if (compact.length >= 3) {
      for (const r of roms.slice(0, 3)) romanizedJamoPrefixes.push(toJamoKey(r.hangul));
    }
  }

  const value: KoreanQueryAnalysis = {
    lemmas,
    romanized,
    romanizedJamoPrefixes,
    ...(choseong ? { choseong } : {}),
    ...(jamoKey ? { jamoKey } : {}),
    ...(english ? { english } : {}),
  };
  lastAnalysis = { raw, value };
  return value;
}
