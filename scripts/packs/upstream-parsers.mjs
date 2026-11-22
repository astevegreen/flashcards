/**
 * Pure upstream open-data parsers for `build-packs.mjs --full` (§3.4, §6.3, §6.4).
 *
 * Every parser takes raw upstream text and returns entries in exactly the shape consumed by
 * `decodePackArchive` (`packages/core/src/dictionary/pack-codec.ts`):
 *   dictionary → `{ headword, altForms?, readings, meanings, eumhun?, strokeCount?, radical?, grade?, frequency? }`,
 *                plus the optional Phase 10 word fields `{ pos?, level?, origin?, homonym?, forms?, senses? }` (KRDict)
 *   strokes    → `{ [char]: { strokes: string[], medians: number[][][] } }` (Hanzi Writer 1024² Y-up)
 * No I/O here so the parsers can be unit-tested on small inline fixtures.
 */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes the five predefined XML entities plus numeric references (JMdict's custom DTD entities are left intact). */
export function decodeXmlText(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, ent) => {
    if (ent[0] === '#') {
      const cp =
        ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return String.fromCodePoint(cp);
    }
    return XML_ENTITIES[ent.toLowerCase()];
  });
}

function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const t = v.normalize('NFC').trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

const TAG_RE_CACHE = new Map();

/** Returns every text body of `<tag ...>body</tag>` inside `xml`, with attribute string. */
function tagsWithAttrs(xml, tag) {
  let re = TAG_RE_CACHE.get(tag);
  if (!re) {
    re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
    TAG_RE_CACHE.set(tag, re);
  }
  return [...xml.matchAll(re)].map((m) => ({ attrs: m[1] ?? '', text: decodeXmlText(m[2]) }));
}

function tags(xml, tag) {
  return tagsWithAttrs(xml, tag).map((t) => t.text);
}

/** Kangxi radical number (1–214) → canonical CJK Unified Ideograph (U+2F00 block NFKC-folds to it). */
export function kangxiRadicalChar(num) {
  const n = Number.parseInt(String(num), 10);
  if (!Number.isInteger(n) || n < 1 || n > 214) return undefined;
  return String.fromCodePoint(0x2f00 + n - 1).normalize('NFKC');
}

function codepointFieldToChar(v) {
  const m = /^U\+([0-9A-F]{4,6})/i.exec(v);
  return m ? String.fromCodePoint(parseInt(m[1], 16)) : undefined;
}

/** Splits on top-level `,`/`;` (ignoring separators inside parentheses). */
export function splitDefinition(def) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of def) {
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if ((ch === ',' || ch === ';') && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return uniq(parts);
}

/* ------------------------------------------------------------------------------------------ */
/* Unihan → dict-hanja-unihan                                                                  */
/* ------------------------------------------------------------------------------------------ */

function parseUnihanTable(text, wantedFields, into) {
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const [cpField, field, value] = line.split('\t');
    if (!wantedFields.has(field) || value === undefined) continue;
    const ch = codepointFieldToChar(cpField);
    if (!ch) continue;
    let rec = into.get(ch);
    if (!rec) {
      rec = {};
      into.set(ch, rec);
    }
    rec[field] = value.trim();
  }
}

export function unihanVersion(readingsText) {
  return /^#\s*Unicode Version\s+([\d.]+)/m.exec(readingsText)?.[1];
}

/**
 * Builds Korean Hanja entries from Unihan `kHangul` (readings + source flags), `kDefinition`,
 * `kTotalStrokes`, `kRSUnicode`, and simplified / Japanese-shinjitai variants.
 *
 * `kHangul` values look like `학:0E` — flag `E` marks one of the 1,800 Basic Hanja for Educational Use
 * (교육용 기초 한자, Ministry of Education 2000), so the education list needs no separate source.
 */
export function parseUnihanHanja({ readings, irgSources, variants }) {
  const recs = new Map();
  parseUnihanTable(readings, new Set(['kHangul', 'kDefinition']), recs);
  parseUnihanTable(irgSources ?? '', new Set(['kTotalStrokes', 'kRSUnicode']), recs);
  parseUnihanTable(
    variants ?? '',
    new Set(['kSimplifiedVariant', 'kTraditionalVariant', 'kJapaneseNewVariant']),
    recs,
  );

  const entries = [];
  for (const [ch, rec] of recs) {
    if (!rec.kHangul) continue;
    const edu = [];
    const other = [];
    for (const tok of rec.kHangul.split(/\s+/)) {
      const [hangul, flags = ''] = tok.split(':');
      if (!hangul) continue;
      (flags.includes('E') ? edu : other).push(hangul);
    }
    const readingsList = uniq([...edu, ...other]);
    if (readingsList.length === 0) continue;

    const altForms = uniq(
      ['kSimplifiedVariant', 'kTraditionalVariant', 'kJapaneseNewVariant']
        .flatMap((f) => (rec[f] ?? '').split(/\s+/))
        .map(codepointFieldToChar)
        .filter((c) => c && c !== ch),
    );
    const strokeCount = Number.parseInt((rec.kTotalStrokes ?? '').split(/\s+/)[0], 10);
    const radNum = (rec.kRSUnicode ?? '').split(/\s+/)[0]?.split('.')[0]?.replace(/'+$/, '');
    const radical = radNum ? kangxiRadicalChar(radNum) : undefined;

    entries.push({
      headword: ch,
      ...(altForms.length > 0 ? { altForms } : {}),
      readings: readingsList,
      meanings: rec.kDefinition ? splitDefinition(rec.kDefinition) : [],
      ...(Number.isInteger(strokeCount) && strokeCount > 0 ? { strokeCount } : {}),
      ...(radical ? { radical } : {}),
      ...(edu.length > 0 ? { grade: 'Education Hanja (Basic 1800)' } : {}),
    });
  }
  // Education Hanja first, then by code point — stable, deterministic output.
  entries.sort(
    (a, b) =>
      Number(Boolean(b.grade)) - Number(Boolean(a.grade)) ||
      a.headword.codePointAt(0) - b.headword.codePointAt(0),
  );
  return entries;
}

/* ------------------------------------------------------------------------------------------ */
/* KANJIDIC2 → dict-kanjidic2                                                                  */
/* ------------------------------------------------------------------------------------------ */

export function kanjidic2Version(xml) {
  return /<database_version>([^<]+)<\/database_version>/.exec(xml)?.[1]?.trim();
}

const OLD_JLPT_TO_N = { 4: 'N5', 3: 'N4', 2: 'N3/N2', 1: 'N1' };

function kanjidicGradeLabel(grade, jlpt) {
  const parts = [];
  const g = Number.parseInt(grade ?? '', 10);
  if (g >= 1 && g <= 6) parts.push(`Grade ${g}`);
  else if (g === 8) parts.push('Jōyō (secondary)');
  else if (g === 9 || g === 10) parts.push('Jinmeiyō');
  const j = OLD_JLPT_TO_N[Number.parseInt(jlpt ?? '', 10)];
  if (j) parts.push(`JLPT ${j}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function parseKanjidic2(xml) {
  const entries = [];
  for (const block of xml.split('<character>').slice(1)) {
    const literal = tags(block, 'literal')[0];
    if (!literal) continue;
    const on = [];
    const kun = [];
    for (const r of tagsWithAttrs(block, 'reading')) {
      if (r.attrs.includes('"ja_on"')) on.push(r.text);
      else if (r.attrs.includes('"ja_kun"')) kun.push(r.text);
    }
    const nanori = tags(block, 'nanori');
    const meanings = tagsWithAttrs(block, 'meaning')
      .filter((m) => !m.attrs.includes('m_lang'))
      .map((m) => m.text);
    const readings = uniq([...on, ...kun, ...nanori]);
    if (readings.length === 0 && meanings.length === 0) continue;

    const radical = kangxiRadicalChar(
      tagsWithAttrs(block, 'rad_value').find((r) => r.attrs.includes('"classical"'))?.text,
    );
    const strokeCount = Number.parseInt(tags(block, 'stroke_count')[0] ?? '', 10);
    const freq = Number.parseInt(tags(block, 'freq')[0] ?? '', 10);
    const grade = kanjidicGradeLabel(tags(block, 'grade')[0], tags(block, 'jlpt')[0]);
    const variants = tagsWithAttrs(block, 'variant')
      .filter((v) => v.attrs.includes('"ucs"'))
      .map((v) => String.fromCodePoint(parseInt(v.text, 16)))
      .filter((c) => c !== literal);

    entries.push({
      headword: literal,
      ...(variants.length > 0 ? { altForms: uniq(variants) } : {}),
      readings,
      meanings: uniq(meanings),
      ...(Number.isInteger(strokeCount) && strokeCount > 0 ? { strokeCount } : {}),
      ...(radical ? { radical } : {}),
      ...(grade ? { grade } : {}),
      ...(Number.isInteger(freq) && freq > 0 ? { frequency: freq } : {}),
    });
  }
  return entries;
}

/* ------------------------------------------------------------------------------------------ */
/* JMdict → dict-jmdict                                                                        */
/* ------------------------------------------------------------------------------------------ */

export function jmdictVersion(xml) {
  return /<!-- JMdict created: ([\d-]+) -->/.exec(xml)?.[1];
}

const COMMON_PRI = new Set(['news1', 'ichi1', 'spec1', 'spec2', 'gai1']);

/**
 * Parses JMdict (English) entries. Headword = first kanji form (else first kana form); other kanji forms
 * become `altForms`; each sense becomes one meaning string (glosses joined with `; `).
 * `nfXX` frequency bands (500 words each, from the Mainichi corpus) become an approximate rank.
 */
export function parseJmdict(xml) {
  const entries = [];
  for (const block of xml.split('<entry>').slice(1)) {
    const kebs = tags(block, 'keb');
    const rebs = tags(block, 'reb');
    if (rebs.length === 0 && kebs.length === 0) continue;
    const meanings = tags(block, 'sense')
      .map((sense) => tags(sense, 'gloss').join('; '))
      .filter(Boolean);
    if (meanings.length === 0) continue;

    const pri = [...tags(block, 'ke_pri'), ...tags(block, 're_pri')];
    let frequency;
    for (const p of pri) {
      const nf = /^nf(\d\d)$/.exec(p);
      if (nf) {
        const rank = Number.parseInt(nf[1], 10) * 500 - 250;
        frequency = frequency === undefined ? rank : Math.min(frequency, rank);
      }
    }
    const common = pri.some((p) => COMMON_PRI.has(p));
    if (frequency === undefined && common) frequency = 30000;

    const headword = kebs[0] ?? rebs[0];
    const altForms = uniq(kebs.slice(1));
    entries.push({
      headword,
      ...(altForms.length > 0 ? { altForms } : {}),
      readings: uniq(rebs),
      meanings,
      ...(common ? { grade: 'Common word' } : {}),
      ...(frequency !== undefined ? { frequency } : {}),
    });
  }
  return entries;
}

/* ------------------------------------------------------------------------------------------ */
/* CC-CEDICT → dict-cc-cedict                                                                  */
/* ------------------------------------------------------------------------------------------ */

export function cedictVersion(text) {
  return /^#! date=(\d{4}-\d{2}-\d{2})/m.exec(text)?.[1];
}

/** CC-CEDICT writes ü as `u:`; normalize to the `v` convention used by IMEs and the starter fixtures. */
export function normalizeCedictPinyin(p) {
  return p.replace(/u:/g, 'v').replace(/U:/g, 'V').replace(/\s+/g, ' ').trim();
}

const CEDICT_LINE = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/;

export function parseCedict(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const m = CEDICT_LINE.exec(line.trimEnd());
    if (!m) continue;
    const [, trad, simp, pinyin, glossBody] = m;
    const meanings = uniq(glossBody.split('/'));
    if (meanings.length === 0) continue;
    entries.push({
      headword: simp,
      ...(trad !== simp ? { altForms: [trad] } : {}),
      readings: [normalizeCedictPinyin(pinyin)],
      meanings,
    });
  }
  return entries;
}

/* ------------------------------------------------------------------------------------------ */
/* KanjiVG → strokes-ja-kanjivg                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * Splits the single-file KanjiVG release XML into per-character blocks and converts each with the
 * runtime's own `convertKanjivgSvgToHanziWriter` (109² Y-down → 1024² Y-up), so build output and
 * runtime conversions stay byte-identical. Variant glyphs (`kvg:kanji_XXXXX-Kaisho` etc.) are skipped.
 */
export function parseKanjivgXml(xml, convert) {
  const characters = {};
  const re = /<kanji id="kvg:kanji_([0-9a-f]{5})">([\s\S]*?)<\/kanji>/g;
  for (const m of xml.matchAll(re)) {
    const ch = String.fromCodePoint(parseInt(m[1], 16));
    const data = convert(m[2]);
    if (data.strokes.length > 0 && data.strokes.length === data.medians.length) {
      characters[ch] = { strokes: data.strokes, medians: data.medians };
    }
  }
  return characters;
}

/* ------------------------------------------------------------------------------------------ */
/* Make Me a Hanzi → strokes-zh-mmah                                                           */
/* ------------------------------------------------------------------------------------------ */

/** `graphics.txt` is JSON-lines already in Hanzi Writer 1024² Y-up space (`{character, strokes, medians}`). */
export function parseMmahGraphics(text) {
  const characters = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (typeof row.character !== 'string' || [...row.character].length !== 1) continue;
    if (!Array.isArray(row.strokes) || !Array.isArray(row.medians)) continue;
    if (row.strokes.length === 0 || row.strokes.length !== row.medians.length) continue;
    characters[row.character] = {
      strokes: row.strokes,
      medians: row.medians.map((m) => m.map(([x, y]) => [Math.round(x), Math.round(y)])),
    };
  }
  return characters;
}

/* ------------------------------------------------------------------------------------------ */
/* KRDict (NIKL 한국어기초사전) English edition → dict-krdict                                    */
/* ------------------------------------------------------------------------------------------ */

/** KRDict 품사 → English part-of-speech label. `품사 없음` (grammar patterns, phrases) maps to none. */
export const KRDICT_POS = {
  명사: 'noun',
  대명사: 'pronoun',
  수사: 'numeral',
  조사: 'particle',
  동사: 'verb',
  형용사: 'adjective',
  관형사: 'determiner',
  부사: 'adverb',
  감탄사: 'interjection',
  접사: 'affix',
  '의존 명사': 'bound noun',
  '보조 동사': 'auxiliary verb',
  '보조 형용사': 'auxiliary adjective',
  어미: 'ending',
};
const KRDICT_LEVEL = { 초급: 'beginner', 중급: 'intermediate', 고급: 'advanced' };
const KRDICT_EXAMPLE_TYPE = { 구: 'phrase', 문장: 'sentence', 대화: 'dialogue' };
/** Keep packs small: KRDict lists many examples per sense; the first few carry the usage. */
export const KRDICT_MAX_EXAMPLES_PER_SENSE = 3;

const FEAT_RE = /<feat\b([^>]*?)\/?>/g;
const ATTR_RE = /\b(att|val)\s*=\s*"([^"]*)"/g;

/** All `<feat att="…" val="…"/>` pairs inside `xml` (attribute order agnostic), in document order. */
function feats(xml) {
  const out = [];
  for (const m of xml.matchAll(FEAT_RE)) {
    let att;
    let val;
    for (const a of m[1].matchAll(ATTR_RE)) {
      if (a[1] === 'att') att = decodeXmlText(a[2]);
      else val = decodeXmlText(a[2]);
    }
    if (att !== undefined && val !== undefined) out.push([att, val.normalize('NFC').trim()]);
  }
  return out;
}

function feat(xml, name) {
  return feats(xml).find(([a]) => a === name)?.[1];
}

/** Child element bodies `<Tag …>body</Tag>` (non-nesting tags only, which is all KRDict uses). */
function elements(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1]);
}

/** The element's own `<feat>`s, with every nested child element removed first. */
function ownFeats(xml) {
  let body = xml;
  for (let i = 0; i < 8; i++) {
    const next = body.replace(/<([A-Za-z]+)\b[^>]*>(?:(?!<\1\b)[\s\S])*?<\/\1>/g, '');
    if (next === body) break;
    body = next;
  }
  return feats(body);
}

const HAN_RUN = /^[㐀-䶿一-鿿豈-﫿]+/;

/** `▽韓國` → `韓國`; strips KRDict's editorial marks from 원어. */
export function cleanKrdictOrigin(origin) {
  return (
    (origin ?? '')
      .replace(/[▽▼^·-]/g, '')
      .normalize('NFC')
      .trim() || undefined
  );
}

/** Pronunciations (`WordForm[type=발음]`) and listed conjugations (`WordForm[type=활용]`). */
function parseKrdictWordForms(block) {
  const readings = [];
  const forms = [];
  for (const wf of elements(block, 'WordForm')) {
    const own = new Map(ownFeats(wf));
    const type = own.get('type');
    if (type === '발음') {
      const p = own.get('pronunciation');
      if (p) readings.push(p);
    } else if (type === '활용') {
      const f = own.get('writtenForm');
      if (f) forms.push(f);
    }
  }
  return { readings, forms };
}

/** English equivalents of one sense, plus the first English definition. */
function parseKrdictEquivalents(senseBlock) {
  const equivalents = [];
  let definition;
  for (const eq of elements(senseBlock, 'Equivalent')) {
    const f = new Map(feats(eq));
    if (f.get('language') !== '영어') continue;
    if (f.get('lemma')) equivalents.push(...splitDefinition(f.get('lemma')));
    if (!definition && f.get('definition')) definition = f.get('definition');
  }
  return { equivalents, definition };
}

/** The first few examples of one sense (`SenseExample/{type,example}`). */
function parseKrdictExamples(senseBlock) {
  const examples = [];
  for (const ex of elements(senseBlock, 'SenseExample')) {
    if (examples.length >= KRDICT_MAX_EXAMPLES_PER_SENSE) break;
    const pairs = feats(ex);
    const type = KRDICT_EXAMPLE_TYPE[pairs.find(([a]) => a === 'type')?.[1]];
    const text = pairs
      .filter(([a]) => a === 'example')
      .map(([, v]) => v)
      .filter(Boolean)
      .join(' / ');
    if (text) examples.push({ text, ...(type ? { type } : {}) });
  }
  return examples;
}

/** One `<Sense>`, or `undefined` when it has neither an English equivalent nor a definition. */
function parseKrdictSense(senseBlock) {
  const { equivalents, definition } = parseKrdictEquivalents(senseBlock);
  if (equivalents.length === 0 && !definition) return undefined;
  const examples = parseKrdictExamples(senseBlock);
  const definitionNative = new Map(ownFeats(senseBlock)).get('definition');
  return {
    equivalents: uniq(equivalents),
    ...(definition ? { definition } : {}),
    ...(definitionNative ? { definitionNative } : {}),
    ...(examples.length > 0 ? { examples } : {}),
    source: 'krdict',
  };
}

/** The entry-level optional fields from the `<LexicalEntry>`'s own feats. */
function krdictEntryMeta(own) {
  const pos = KRDICT_POS[own.get('partOfSpeech')];
  const level = KRDICT_LEVEL[own.get('vocabularyLevel')];
  const origin = cleanKrdictOrigin(own.get('origin'));
  const hanja = origin ? HAN_RUN.exec(origin)?.[0] : undefined;
  const homonym = Number.parseInt(own.get('homonym_number') ?? '', 10);
  return {
    hanja,
    pos,
    level,
    origin,
    homonym: Number.isInteger(homonym) && homonym > 0 ? homonym : undefined,
  };
}

/** One `<LexicalEntry>` as a pack entry, or `undefined` when it has no headword or usable sense. */
function parseKrdictEntry(block) {
  const lemmaBlock = elements(block, 'Lemma')[0] ?? '';
  const headword = feat(lemmaBlock, 'writtenForm');
  if (!headword) return undefined;
  const own = new Map(ownFeats(block));
  const { readings, forms } = parseKrdictWordForms(block);
  const senses = elements(block, 'Sense')
    .map(parseKrdictSense)
    .filter((s) => s !== undefined);
  if (senses.length === 0) return undefined;
  const { hanja, pos, level, origin, homonym } = krdictEntryMeta(own);
  return {
    headword: headword.normalize('NFC'),
    ...(hanja ? { altForms: [hanja] } : {}),
    readings: uniq(readings),
    meanings: senses.map((s) =>
      s.equivalents.length > 0 ? s.equivalents.join('; ') : s.definition,
    ),
    ...(pos ? { pos: [pos] } : {}),
    ...(level ? { level } : {}),
    ...(origin ? { origin } : {}),
    ...(homonym === undefined ? {} : { homonym }),
    ...(forms.length > 0 ? { forms: uniq(forms) } : {}),
    senses,
  };
}

/**
 * Parses one KRDict LMF XML file (the "사전 전체 내려받기" export; English edition or the full
 * multilingual one — only `영어` equivalents are kept). Shape per `<LexicalEntry>`:
 *   Lemma/writtenForm, homonym_number, partOfSpeech, vocabularyLevel, origin (원어),
 *   WordForm[type=발음]/pronunciation, WordForm[type=활용]/writtenForm,
 *   Sense/definition + Equivalent[language=영어]/{lemma,definition} + SenseExample/{type,example}.
 * Output matches `decodePackArchive` (packages/core/src/dictionary/pack-codec.ts).
 */
export function parseKrdictXml(xml) {
  const entries = [];
  for (const block of elements(xml, 'LexicalEntry')) {
    const entry = parseKrdictEntry(block);
    if (entry) entries.push(entry);
  }
  return entries;
}
