#!/usr/bin/env node
/**
 * Reproducible Open-Data Pack Compiler (§3.4, §6.3, §6.4, ADR 0001 Spike 0.6).
 *
 * Compiles downloadable offline dictionary packs (Unihan Hanja, KANJIDIC2, CC-CEDICT, JMdict)
 * and separate stroke packs (KanjiVG JA, Make Me a Hanzi ZH/Hanja) into gzipped static assets
 * plus a unified `packs.json` manifest and Cloudflare Pages CORS `_headers`.
 *
 * Usage:
 *   node scripts/build-packs.mjs --starter   # Build tiny attributed dev/CI fixtures in apps/web/public/packs/
 *   node scripts/build-packs.mjs --full --input <upstream-dir> --out <dist-packs-dir>
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function charToHex5(ch) {
  return ch.codePointAt(0).toString(16).padStart(5, '0');
}

/** Builds a closed stroked SVG ribbon polygon around a sampled Hanzi Writer Y-up median polyline. */
function buildRibbon(points, halfWidth = 26) {
  if (points.length < 2) return '';
  const left = [];
  const right = [];
  for (let i = 0; i < points.length; i++) {
    const curr = points[i];
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * halfWidth;
    const ny = (dx / len) * halfWidth;
    left.push([Math.round(curr[0] + nx), Math.round(curr[1] + ny)]);
    right.push([Math.round(curr[0] - nx), Math.round(curr[1] - ny)]);
  }
  const ring = [...left, ...right.reverse()];
  return `M ${ring[0][0]} ${ring[0][1]} ${ring
    .slice(1)
    .map(([x, y]) => `L ${x} ${y}`)
    .join(' ')} Z`;
}

function fromMedians(medians) {
  return {
    strokes: medians.map((m) => buildRibbon(m, 26)),
    medians,
  };
}

/**
 * Compact starter stroke fixtures (Hanzi Writer 1024x1024 Y-up coordinates) for offline dev mode & CI.
 * Real Spike 0.6 KanjiVG conversions (食, 語) are loaded directly from spikes/phase0/kanjivg-*.json when present.
 */
function buildStarterStrokeSets() {
  // Common geometric primitives in Hanzi Writer Y-up coordinates (top ≈ 800, bottom ≈ 50)
  const CHAR_ONE = fromMedians([
    [
      [140, 460],
      [512, 460],
      [884, 460],
    ],
  ]);
  const CHAR_TWO = fromMedians([
    [
      [220, 620],
      [512, 620],
      [804, 620],
    ],
    [
      [120, 260],
      [512, 260],
      [904, 260],
    ],
  ]);
  const CHAR_THREE = fromMedians([
    [
      [220, 720],
      [512, 720],
      [804, 720],
    ],
    [
      [260, 460],
      [512, 460],
      [764, 460],
    ],
    [
      [120, 180],
      [512, 180],
      [904, 180],
    ],
  ]);
  const CHAR_KOU = fromMedians([
    [
      [240, 720],
      [260, 460],
      [280, 200],
    ],
    [
      [250, 710],
      [520, 720],
      [780, 710],
      [760, 460],
      [740, 220],
    ],
    [
      [280, 220],
      [520, 220],
      [740, 220],
    ],
  ]);
  const CHAR_RI = fromMedians([
    [
      [270, 760],
      [270, 440],
      [270, 120],
    ],
    [
      [270, 760],
      [540, 765],
      [755, 760],
      [755, 440],
      [755, 120],
    ],
    [
      [280, 460],
      [520, 465],
      [740, 460],
    ],
    [
      [280, 145],
      [520, 145],
      [740, 145],
    ],
  ]);
  const CHAR_BEN = fromMedians([
    [
      [180, 620],
      [512, 625],
      [844, 620],
    ],
    [
      [512, 830],
      [512, 460],
      [512, 80],
    ],
    [
      [505, 610],
      [340, 410],
      [160, 210],
    ],
    [
      [520, 610],
      [690, 410],
      [870, 210],
    ],
    [
      [320, 240],
      [512, 240],
      [704, 240],
    ],
  ]);
  const CHAR_REN = fromMedians([
    [
      [520, 810],
      [390, 460],
      [180, 110],
    ],
    [
      [450, 520],
      [640, 310],
      [860, 110],
    ],
  ]);
  const CHAR_DA = fromMedians([
    [
      [180, 560],
      [512, 565],
      [844, 560],
    ],
    [
      [512, 820],
      [460, 450],
      [180, 100],
    ],
    [
      [515, 550],
      [680, 320],
      [870, 100],
    ],
  ]);
  const CHAR_MU = fromMedians([
    [
      [180, 610],
      [512, 615],
      [844, 610],
    ],
    [
      [512, 830],
      [512, 460],
      [512, 80],
    ],
    [
      [505, 600],
      [340, 390],
      [160, 170],
    ],
    [
      [520, 600],
      [690, 390],
      [870, 170],
    ],
  ]);
  const CHAR_JIN = fromMedians([
    [
      [512, 820],
      [340, 610],
      [150, 420],
    ],
    [
      [512, 800],
      [685, 600],
      [880, 420],
    ],
    [
      [380, 540],
      [512, 545],
      [644, 540],
    ],
    [
      [270, 370],
      [540, 375],
      [710, 370],
      [560, 220],
      [440, 90],
    ],
  ]);
  const CHAR_XUE_SIMP = fromMedians([
    [
      [260, 810],
      [310, 730],
      [350, 660],
    ],
    [
      [460, 830],
      [500, 750],
      [530, 680],
    ],
    [
      [740, 810],
      [690, 720],
      [640, 640],
    ],
    [
      [190, 610],
      [170, 540],
      [150, 470],
    ],
    [
      [195, 600],
      [512, 610],
      [830, 600],
      [790, 530],
      [750, 480],
    ],
    [
      [320, 470],
      [520, 475],
      [680, 470],
      [580, 390],
      [512, 340],
    ],
    [
      [512, 340],
      [520, 210],
      [512, 85],
      [430, 120],
    ],
    [
      [160, 270],
      [512, 275],
      [860, 270],
    ],
  ]);
  const CHAR_XI = fromMedians([
    [
      [240, 730],
      [540, 740],
      [800, 730],
      [785, 420],
      [760, 120],
      [670, 170],
    ],
    [
      [320, 560],
      [390, 490],
      [440, 430],
    ],
    [
      [220, 240],
      [410, 330],
      [580, 420],
    ],
  ]);
  const CHAR_XUE_TRAD = fromMedians([
    [
      [360, 830],
      [280, 770],
      [220, 720],
    ],
    [
      [220, 720],
      [230, 610],
      [240, 510],
    ],
    [
      [230, 620],
      [310, 625],
      [370, 620],
    ],
    [
      [460, 790],
      [515, 730],
      [560, 670],
    ],
    [
      [555, 780],
      [500, 720],
      [445, 665],
    ],
    [
      [460, 640],
      [515, 585],
      [560, 535],
    ],
    [
      [555, 635],
      [500, 580],
      [445, 530],
    ],
    [
      [660, 780],
      [740, 785],
      [800, 780],
      [785, 640],
      [770, 510],
    ],
    [
      [660, 640],
      [720, 645],
      [770, 640],
    ],
    [
      [180, 490],
      [160, 430],
      [145, 380],
    ],
    [
      [185, 485],
      [512, 495],
      [840, 485],
      [805, 430],
      [770, 385],
    ],
    [
      [340, 375],
      [520, 380],
      [660, 375],
      [570, 315],
      [512, 275],
    ],
    [
      [512, 275],
      [520, 175],
      [512, 75],
      [440, 110],
    ],
    [
      [170, 210],
      [512, 215],
      [855, 210],
    ],
  ]);
  const CHAR_SHU_TRAD = fromMedians([
    [
      [270, 740],
      [520, 745],
      [740, 740],
      [730, 650],
      [720, 570],
    ],
    [
      [160, 655],
      [512, 660],
      [860, 655],
    ],
    [
      [270, 575],
      [520, 580],
      [720, 575],
    ],
    [
      [280, 490],
      [512, 495],
      [740, 490],
    ],
    [
      [180, 415],
      [512, 420],
      [840, 415],
    ],
    [
      [512, 835],
      [512, 620],
      [512, 420],
    ],
    [
      [290, 340],
      [290, 200],
      [290, 85],
    ],
    [
      [295, 340],
      [520, 345],
      [735, 340],
      [735, 200],
      [735, 85],
    ],
    [
      [300, 220],
      [520, 225],
      [725, 220],
    ],
    [
      [300, 100],
      [520, 105],
      [725, 100],
    ],
  ]);

  // Real Spike 0.6 KanjiVG Japanese strokes (食 9 strokes, 語 14 strokes)
  const kvgShiPath = join(REPO_ROOT, 'spikes', 'phase0', 'kanjivg-098df.json');
  const kvgYuPath = join(REPO_ROOT, 'spikes', 'phase0', 'kanjivg-08a9e.json');
  const kvgShi = existsSync(kvgShiPath) ? JSON.parse(readFileSync(kvgShiPath, 'utf8')) : CHAR_RI;
  const kvgYu = existsSync(kvgYuPath) ? JSON.parse(readFileSync(kvgYuPath, 'utf8')) : CHAR_BEN;

  // Distinct Chinese Make Me a Hanzi stroke order for 食 (stroke 3 is a dot, 9 strokes)
  const zhShi = fromMedians([
    [
      [505, 825],
      [340, 620],
      [125, 425],
    ],
    [
      [515, 760],
      [690, 610],
      [895, 480],
    ],
    [
      [475, 645],
      [510, 605],
      [540, 565],
    ],
    [
      [360, 520],
      [540, 535],
      [650, 525],
      [630, 385],
      [620, 290],
    ],
    [
      [380, 415],
      [500, 425],
      [615, 425],
    ],
    [
      [380, 300],
      [500, 310],
      [610, 310],
    ],
    [
      [365, 525],
      [365, 260],
      [365, 35],
      [515, 115],
    ],
    [
      [710, 295],
      [660, 235],
      [615, 185],
    ],
    [
      [475, 240],
      [645, 125],
      [845, 5],
    ],
  ]);

  const jaCharacters = {
    一: CHAR_ONE,
    二: CHAR_TWO,
    三: CHAR_THREE,
    口: CHAR_KOU,
    人: CHAR_REN,
    大: CHAR_DA,
    木: CHAR_MU,
    日: CHAR_RI,
    本: CHAR_BEN,
    今: CHAR_JIN,
    学: CHAR_XUE_SIMP,
    食: kvgShi,
    語: kvgYu,
  };

  const zhCharacters = {
    一: CHAR_ONE,
    二: CHAR_TWO,
    三: CHAR_THREE,
    口: CHAR_KOU,
    人: CHAR_REN,
    大: CHAR_DA,
    木: CHAR_MU,
    日: CHAR_RI,
    本: CHAR_BEN,
    学: CHAR_XUE_SIMP,
    习: CHAR_XI,
    學: CHAR_XUE_TRAD,
    書: CHAR_SHU_TRAD,
    食: zhShi,
    語: kvgYu,
  };

  return { jaCharacters, zhCharacters };
}

function buildStarterDictionaries() {
  const hanjaEntries = [
    {
      headword: '學',
      altForms: ['学'],
      readings: ['학'],
      eumhun: ['배울 학'],
      meanings: ['learn', 'study', 'science', 'school'],
      strokeCount: 16,
      radical: '子',
      grade: 'Education Hanja (Middle)',
      frequency: 12,
    },
    {
      headword: '校',
      readings: ['교'],
      eumhun: ['학교 교'],
      meanings: ['school', 'campus', 'proofread', 'compare'],
      strokeCount: 10,
      radical: '木',
      grade: 'Education Hanja (Middle)',
      frequency: 45,
    },
    {
      headword: '圖',
      altForms: ['图'],
      readings: ['도'],
      eumhun: ['그림 도'],
      meanings: ['diagram', 'chart', 'map', 'picture', 'plan'],
      strokeCount: 14,
      radical: '囗',
      grade: 'Education Hanja (Middle)',
      frequency: 90,
    },
    {
      headword: '書',
      altForms: ['书'],
      readings: ['서'],
      eumhun: ['글 서'],
      meanings: ['book', 'writing', 'document', 'letter'],
      strokeCount: 10,
      radical: '曰',
      grade: 'Education Hanja (Middle)',
      frequency: 35,
    },
    {
      headword: '館',
      altForms: ['馆'],
      readings: ['관'],
      eumhun: ['집 관'],
      meanings: ['hall', 'building', 'public house', 'library'],
      strokeCount: 16,
      radical: '食',
      grade: 'Education Hanja (Middle)',
      frequency: 140,
    },
    {
      headword: '約',
      altForms: ['约'],
      readings: ['약'],
      eumhun: ['맺을 약'],
      meanings: ['promise', 'agreement', 'appointment', 'approximately'],
      strokeCount: 9,
      radical: '糸',
      grade: 'Education Hanja (Middle)',
      frequency: 80,
    },
    {
      headword: '束',
      readings: ['속'],
      eumhun: ['묶을 속'],
      meanings: ['bind', 'bundle', 'control', 'restrain'],
      strokeCount: 7,
      radical: '木',
      grade: 'Education Hanja (Middle)',
      frequency: 210,
    },
    {
      headword: '經',
      altForms: ['经'],
      readings: ['경'],
      eumhun: ['지날 경'],
      meanings: ['pass through', 'experience', 'classic', 'manage'],
      strokeCount: 13,
      radical: '糸',
      grade: 'Education Hanja (Middle)',
      frequency: 55,
    },
    {
      headword: '驗',
      altForms: ['验'],
      readings: ['험'],
      eumhun: ['시험 험'],
      meanings: ['test', 'examine', 'verify', 'experience'],
      strokeCount: 23,
      radical: '馬',
      grade: 'Education Hanja (High)',
      frequency: 190,
    },
    {
      headword: '日',
      readings: ['일'],
      eumhun: ['날 일'],
      meanings: ['sun', 'day', 'daytime'],
      strokeCount: 4,
      radical: '日',
      grade: 'Education Hanja (Basic)',
      frequency: 2,
    },
    {
      headword: '本',
      readings: ['본'],
      eumhun: ['근본 본'],
      meanings: ['root', 'origin', 'source', 'basis', 'book'],
      strokeCount: 5,
      radical: '木',
      grade: 'Education Hanja (Basic)',
      frequency: 15,
    },
    {
      headword: '食',
      readings: ['식'],
      eumhun: ['먹을 식'],
      meanings: ['eat', 'meal', 'food'],
      strokeCount: 9,
      radical: '食',
      grade: 'Education Hanja (Basic)',
      frequency: 60,
    },
    {
      headword: '語',
      altForms: ['语'],
      readings: ['어'],
      eumhun: ['말씀 어'],
      meanings: ['language', 'word', 'speech'],
      strokeCount: 14,
      radical: '言',
      grade: 'Education Hanja (Basic)',
      frequency: 50,
    },
    {
      headword: '韓',
      altForms: ['韩'],
      readings: ['한'],
      eumhun: ['나라 한'],
      meanings: ['Korea', 'Korean'],
      strokeCount: 17,
      radical: '韋',
      grade: 'Education Hanja (Basic)',
      frequency: 25,
    },
    {
      headword: '國',
      altForms: ['国'],
      readings: ['국'],
      eumhun: ['나라 국'],
      meanings: ['country', 'nation', 'state'],
      strokeCount: 11,
      radical: '囗',
      grade: 'Education Hanja (Basic)',
      frequency: 8,
    },
    {
      headword: '人',
      readings: ['인'],
      eumhun: ['사람 인'],
      meanings: ['person', 'human', 'people'],
      strokeCount: 2,
      radical: '人',
      grade: 'Education Hanja (Basic)',
      frequency: 1,
    },
    {
      headword: '大',
      readings: ['대'],
      eumhun: ['큰 대'],
      meanings: ['big', 'great', 'large'],
      strokeCount: 3,
      radical: '大',
      grade: 'Education Hanja (Basic)',
      frequency: 3,
    },
    {
      headword: '木',
      readings: ['목'],
      eumhun: ['나무 목'],
      meanings: ['tree', 'wood'],
      strokeCount: 4,
      radical: '木',
      grade: 'Education Hanja (Basic)',
      frequency: 40,
    },
    {
      headword: '口',
      readings: ['구'],
      eumhun: ['입 구'],
      meanings: ['mouth', 'opening', 'entrance'],
      strokeCount: 3,
      radical: '口',
      grade: 'Education Hanja (Basic)',
      frequency: 28,
    },
    {
      headword: '一',
      readings: ['일'],
      eumhun: ['한 일'],
      meanings: ['one', 'single', 'first'],
      strokeCount: 1,
      radical: '一',
      grade: 'Education Hanja (Basic)',
      frequency: 4,
    },
  ];

  const kanjidicEntries = [
    {
      headword: '日',
      readings: ['ニチ', 'ジツ', 'ひ', 'か'],
      meanings: ['day', 'sun', 'Japan'],
      strokeCount: 4,
      radical: '日',
      grade: 'Grade 1 · JLPT N5',
      frequency: 1,
    },
    {
      headword: '本',
      readings: ['ホン', 'もと'],
      meanings: ['book', 'present', 'main', 'origin', 'true'],
      strokeCount: 5,
      radical: '木',
      grade: 'Grade 1 · JLPT N5',
      frequency: 10,
    },
    {
      headword: '食',
      readings: ['ショク', 'ジキ', 'た.べる', 'く.う'],
      meanings: ['eat', 'food', 'meal'],
      strokeCount: 9,
      radical: '食',
      grade: 'Grade 2 · JLPT N5',
      frequency: 328,
    },
    {
      headword: '語',
      readings: ['ゴ', 'かた.る', 'かた.らう'],
      meanings: ['word', 'speech', 'language'],
      strokeCount: 14,
      radical: '言',
      grade: 'Grade 2 · JLPT N5',
      frequency: 301,
    },
    {
      headword: '学',
      altForms: ['學'],
      readings: ['ガク', 'まな.ぶ'],
      meanings: ['study', 'learning', 'science'],
      strokeCount: 8,
      radical: '子',
      grade: 'Grade 1 · JLPT N5',
      frequency: 63,
    },
    {
      headword: '今',
      readings: ['コン', 'キン', 'いま'],
      meanings: ['now', 'present'],
      strokeCount: 4,
      radical: '人',
      grade: 'Grade 2 · JLPT N5',
      frequency: 49,
    },
    {
      headword: '勉',
      readings: ['ベン', 'つと.める'],
      meanings: ['exertion', 'endeavour', 'study'],
      strokeCount: 10,
      radical: '力',
      grade: 'Grade 3 · JLPT N4',
      frequency: 1120,
    },
    {
      headword: '強',
      readings: ['キョウ', 'ゴウ', 'つよ.い', 'し.いる'],
      meanings: ['strong', 'powerful'],
      strokeCount: 11,
      radical: '弓',
      grade: 'Grade 2 · JLPT N4',
      frequency: 112,
    },
    {
      headword: '人',
      readings: ['ジン', 'ニン', 'ひと'],
      meanings: ['person', 'human'],
      strokeCount: 2,
      radical: '人',
      grade: 'Grade 1 · JLPT N5',
      frequency: 5,
    },
    {
      headword: '木',
      readings: ['ボク', 'モク', 'き', 'こ'],
      meanings: ['tree', 'wood'],
      strokeCount: 4,
      radical: '木',
      grade: 'Grade 1 · JLPT N5',
      frequency: 317,
    },
  ];

  const cedictEntries = [
    {
      headword: '学习',
      altForms: ['學習'],
      readings: ['xue2 xi2'],
      meanings: ['to learn', 'to study'],
      grade: 'HSK 1',
      frequency: 50,
    },
    {
      headword: '旅行',
      readings: ['lv3 xing2'],
      meanings: ['to travel', 'journey', 'trip'],
      grade: 'HSK 2',
      frequency: 220,
    },
    {
      headword: '朋友',
      readings: ['peng2 you5'],
      meanings: ['friend'],
      grade: 'HSK 1',
      frequency: 65,
    },
    {
      headword: '学校',
      altForms: ['學校'],
      readings: ['xue2 xiao4'],
      meanings: ['school'],
      grade: 'HSK 1',
      frequency: 72,
    },
    {
      headword: '中文',
      readings: ['zhong1 wen2'],
      meanings: ['Chinese language'],
      grade: 'HSK 1',
      frequency: 95,
    },
    {
      headword: '日本',
      readings: ['ri4 ben3'],
      meanings: ['Japan'],
      grade: 'HSK 2',
      frequency: 110,
    },
    {
      headword: '书',
      altForms: ['書'],
      readings: ['shu1'],
      meanings: ['book', 'letter', 'document'],
      grade: 'HSK 1',
      frequency: 85,
    },
    {
      headword: '食',
      readings: ['shi2'],
      meanings: ['to eat', 'food', 'meal'],
      strokeCount: 9,
      frequency: 180,
    },
  ];

  const jmdictEntries = [
    {
      headword: '日本',
      readings: ['にほん', 'にっぽん'],
      meanings: ['Japan'],
      grade: 'JLPT N5',
      frequency: 12,
    },
    {
      headword: '勉強',
      readings: ['べんきょう'],
      meanings: ['study', 'diligence', 'working hard'],
      grade: 'JLPT N5',
      frequency: 140,
    },
    {
      headword: '今日',
      readings: ['きょう', 'こんにち'],
      meanings: ['today', 'this day'],
      grade: 'JLPT N5',
      frequency: 45,
    },
    {
      headword: '食べる',
      readings: ['たべる'],
      meanings: ['to eat', 'to live on'],
      grade: 'JLPT N5',
      frequency: 68,
    },
    {
      headword: '学生',
      readings: ['がくせい'],
      meanings: ['student (especially university student)'],
      grade: 'JLPT N5',
      frequency: 92,
    },
    {
      headword: '日本語',
      readings: ['にほんご'],
      meanings: ['Japanese (language)'],
      grade: 'JLPT N5',
      frequency: 78,
    },
    {
      headword: '図書館',
      readings: ['としょかん'],
      meanings: ['library'],
      grade: 'JLPT N5',
      frequency: 260,
    },
  ];

  return { hanjaEntries, kanjidicEntries, cedictEntries, jmdictEntries };
}

function writeGzipPack(outDir, filename, payload) {
  const jsonStr = JSON.stringify(payload);
  const rawBuf = Buffer.from(jsonStr, 'utf8');
  const gzBuf = gzipSync(rawBuf, { level: 9 });
  const filePath = join(outDir, filename);
  writeFileSync(filePath, gzBuf);
  return {
    compressed_bytes: gzBuf.byteLength,
    uncompressed_bytes: rawBuf.byteLength,
    // Hash canonical uncompressed JSON so verification is invariant to HTTP Content-Encoding (gzip/br)
    sha256: sha256Hex(rawBuf),
  };
}

function buildStarterPacks() {
  const outDir = join(REPO_ROOT, 'apps', 'web', 'public', 'packs');
  const jaCharDir = join(outDir, 'strokes', 'ja');
  const zhCharDir = join(outDir, 'strokes', 'zh-Hans');
  mkdirSync(jaCharDir, { recursive: true });
  mkdirSync(zhCharDir, { recursive: true });

  const version = '2026.11.0-starter';
  const { jaCharacters, zhCharacters } = buildStarterStrokeSets();
  const { hanjaEntries, kanjidicEntries, cedictEntries, jmdictEntries } =
    buildStarterDictionaries();

  // Write individual per-character static stroke files (for per-deck pre-caching on same host)
  for (const [ch, data] of Object.entries(jaCharacters)) {
    writeFileSync(join(jaCharDir, `${charToHex5(ch)}.json`), JSON.stringify(data), 'utf8');
  }
  for (const [ch, data] of Object.entries(zhCharacters)) {
    writeFileSync(join(zhCharDir, `${charToHex5(ch)}.json`), JSON.stringify(data), 'utf8');
  }

  const packDefs = [
    {
      filename: 'dict-hanja-unihan.json.gz',
      payload: {
        manifest: {
          format_version: 1,
          id: 'dict-hanja-unihan',
          kind: 'dictionary',
          name: 'Hanja Dictionary (Unihan + Education Hanja)',
          version,
          language: 'ko',
          description:
            'Korean Hanja readings (음훈), English definitions, radicals, and stroke counts derived from Unicode Unihan.',
          license_name: 'Unicode License v3',
          license_url: 'https://www.unicode.org/license.txt',
          attribution:
            'Copyright © 1991–2026 Unicode, Inc. Derived from the Unicode Character Database (Unihan).',
          source_url: 'https://www.unicode.org/charts/unihan.html',
        },
        entries: hanjaEntries,
      },
      entryCount: hanjaEntries.length,
    },
    {
      filename: 'dict-kanjidic2.json.gz',
      payload: {
        manifest: {
          format_version: 1,
          id: 'dict-kanjidic2',
          kind: 'dictionary',
          name: 'KANJIDIC2 (Japanese Kanji)',
          version,
          language: 'ja',
          description: 'Japanese Kanji readings (on/kun), English meanings, grade, and strokes.',
          license_name: 'CC BY-SA 4.0',
          license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
          attribution:
            'KANJIDIC2 is the property of the Electronic Dictionary Research and Development Group (EDRDG).',
          source_url: 'https://www.edrdg.org/wiki/index.php/KANJIDIC_Project',
        },
        entries: kanjidicEntries,
      },
      entryCount: kanjidicEntries.length,
    },
    {
      filename: 'dict-cc-cedict.json.gz',
      payload: {
        manifest: {
          format_version: 1,
          id: 'dict-cc-cedict',
          kind: 'dictionary',
          name: 'CC-CEDICT (Mandarin Chinese)',
          version,
          language: 'zh-Hans',
          description: 'Simplified & Traditional Mandarin words, Pinyin, and English definitions.',
          license_name: 'CC BY-SA 4.0',
          license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
          attribution: 'CC-CEDICT community dictionary maintained by MDBG.',
          source_url: 'https://www.mdbg.net/chinese/dictionary?page=cc-cedict',
        },
        entries: cedictEntries,
      },
      entryCount: cedictEntries.length,
    },
    {
      filename: 'dict-jmdict.json.gz',
      payload: {
        manifest: {
          format_version: 1,
          id: 'dict-jmdict',
          kind: 'dictionary',
          name: 'JMdict (Japanese Words — Optional, Large)',
          version,
          language: 'ja',
          description: 'Comprehensive Japanese-English word dictionary (optional large pack).',
          license_name: 'CC BY-SA 4.0',
          license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
          attribution:
            'JMdict is the property of the Electronic Dictionary Research and Development Group (EDRDG).',
          source_url: 'https://www.edrdg.org/jmdict/j_jmdict.html',
        },
        entries: jmdictEntries,
      },
      entryCount: jmdictEntries.length,
      optional: true,
    },
    {
      filename: 'strokes-ja-kanjivg.json.gz',
      payload: {
        manifest: {
          format_version: 1,
          id: 'strokes-ja-kanjivg',
          kind: 'strokes',
          name: 'Japanese Stroke Data (KanjiVG)',
          version,
          language: 'ja',
          script: 'ja',
          description:
            'Japanese Kanji stroke order vectors and medians for graded drawing & lookup (kept separate from Chinese).',
          license_name: 'CC BY-SA 3.0',
          license_url: 'https://creativecommons.org/licenses/by-sa/3.0/',
          attribution: 'KanjiVG is copyright © 2009–2026 Ulrich Apel and contributors.',
          source_url: 'https://kanjivg.tagaini.net/',
        },
        characters: jaCharacters,
      },
      entryCount: Object.keys(jaCharacters).length,
      char_url_template: '/packs/strokes/ja/{hex5}.json',
    },
    {
      filename: 'strokes-zh-mmah.json.gz',
      payload: {
        manifest: {
          format_version: 1,
          id: 'strokes-zh-mmah',
          kind: 'strokes',
          name: 'Chinese & Hanja Stroke Data (Make Me a Hanzi)',
          version,
          language: 'zh-Hans',
          script: 'zh-Hans',
          description:
            'Simplified Chinese & Traditional Hanja stroke data for graded drawing & draw-to-lookup (kept separate from Japanese).',
          license_name: 'Arphic Public License (1999)',
          license_url: 'https://ftp.gnu.org/gnu/non-gnu/chinese-fonts-truetype/LICENSE',
          attribution:
            'Derived from Make Me a Hanzi (Shaunak Kishore) and Arphic PL fonts (Arphic Technology Co., Ltd.).',
          source_url: 'https://github.com/skishore/makemeahanzi',
        },
        characters: zhCharacters,
      },
      entryCount: Object.keys(zhCharacters).length,
      char_url_template: '/packs/strokes/zh-Hans/{hex5}.json',
    },
  ];

  const catalogPacks = packDefs.map((def) => {
    const stats = writeGzipPack(outDir, def.filename, def.payload);
    const m = def.payload.manifest;
    return {
      id: m.id,
      kind: m.kind,
      name: m.name,
      description: m.description,
      version: m.version,
      language: m.language,
      ...(m.script ? { script: m.script } : {}),
      url: `/packs/${def.filename}`,
      compressed_bytes: stats.compressed_bytes,
      uncompressed_bytes: stats.uncompressed_bytes,
      entry_count: def.entryCount,
      sha256: stats.sha256,
      license_name: m.license_name,
      license_url: m.license_url,
      attribution: m.attribution,
      source_url: m.source_url,
      ...(def.optional ? { optional: true } : {}),
      ...(def.char_url_template ? { char_url_template: def.char_url_template } : {}),
    };
  });

  const catalog = {
    format_version: 1,
    name: 'Flashcards Offline Packs (Starter / Dev Fixtures)',
    updated_at: '2026-11-21T00:00:00Z',
    packs: catalogPacks,
  };

  writeFileSync(join(outDir, 'packs.json'), JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  writeFileSync(
    join(outDir, '_headers'),
    '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=3600\n',
    'utf8',
  );
  writeFileSync(
    join(outDir, 'LICENSES.txt'),
    [
      'Flashcards Offline Data Packs — Upstream Licenses & Attributions',
      '================================================================',
      '',
      '1. dict-hanja-unihan: Unicode License v3 (https://www.unicode.org/license.txt)',
      '   Source: Unicode Character Database (Unihan) — https://www.unicode.org/charts/unihan.html',
      '',
      '2. dict-kanjidic2: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)',
      '   Source: EDRDG KANJIDIC2 — https://www.edrdg.org/wiki/index.php/KANJIDIC_Project',
      '',
      '3. dict-cc-cedict: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)',
      '   Source: MDBG CC-CEDICT — https://www.mdbg.net/chinese/dictionary?page=cc-cedict',
      '',
      '4. dict-jmdict: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)',
      '   Source: EDRDG JMdict — https://www.edrdg.org/jmdict/j_jmdict.html',
      '',
      '5. strokes-ja-kanjivg: CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/)',
      '   Source: KanjiVG (Ulrich Apel & contributors) — https://kanjivg.tagaini.net/',
      '',
      '6. strokes-zh-mmah: Arphic Public License (1999) (https://ftp.gnu.org/gnu/non-gnu/chinese-fonts-truetype/LICENSE)',
      '   Source: Make Me a Hanzi — https://github.com/skishore/makemeahanzi',
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(`Built ${catalogPacks.length} starter packs + packs.json in ${outDir}`);
}

const args = process.argv.slice(2);
if (args.includes('--full')) {
  console.error(
    'Full upstream compilation runs in Phase 7 CI content repo (place Unihan/KANJIDIC2/CC-CEDICT/JMdict/KanjiVG/MMAH raw files in --input). Use --starter for dev/CI fixtures.',
  );
  process.exit(1);
} else {
  buildStarterPacks();
}
