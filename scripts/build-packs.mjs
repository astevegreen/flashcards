#!/usr/bin/env node
/**
 * Reproducible Open-Data Pack Compiler (§3.4, §6.3, §6.4, ADR 0001 Spike 0.6).
 *
 * Compiles downloadable offline dictionary packs (Unihan Hanja, KANJIDIC2, CC-CEDICT, JMdict, KRDict)
 * and separate stroke packs (KanjiVG JA, Make Me a Hanzi ZH/Hanja) into gzipped static assets
 * plus a unified `packs.json` manifest and Cloudflare Pages CORS `_headers`.
 *
 * Usage:
 *   node scripts/build-packs.mjs --starter [--out <dir>] [--base-url <https-url>]
 *       Tiny attributed dev/CI fixtures (default out: apps/web/public/packs/). Never needs network.
 *   node scripts/fetch-upstream-packs.mjs && node scripts/build-packs.mjs --full
 *       [--input <upstream-dir>] [--out <dir>] [--base-url <https-url>] [--skip-jmdict] [--no-char-files]
 *       Real packs from upstream open data (default input: .cache/upstream-open-data/, default out:
 *       dist-packs/, both gitignored). Each pack must stay <= 25 MiB gzipped (Cloudflare Pages limit).
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

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

/* ------------------------------------------------------------------------------------------ */
/* Shared pack metadata, writers & catalog emission (starter + full)                           */
/* ------------------------------------------------------------------------------------------ */

/** Cloudflare Pages hard per-file limit (25 MiB). Packs above this must move to R2 (see docs §3.4). */
const MAX_STATIC_FILE_BYTES = 25 * 1024 * 1024;
/** Mirrors `PACK_SECURITY_LIMITS` in packages/core/src/dictionary/pack-codec.ts — the runtime rejects packs above these. */
const RUNTIME_LIMITS = {
  maxCompressedBytes: 50 * 1024 * 1024,
  maxUncompressedBytes: 150 * 1024 * 1024,
  maxEntries: 400_000,
};

const CC_BY_SA_4 = {
  license_name: 'CC BY-SA 4.0',
  license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
};

/** Per-pack manifest metadata shared by starter and full builds. */
const PACK_META = {
  'dict-hanja-unihan': {
    filename: 'dict-hanja-unihan.json.gz',
    kind: 'dictionary',
    name: 'Hanja Dictionary (Unihan + Education Hanja)',
    language: 'ko',
    description:
      'Korean Hanja readings (음훈), English definitions, radicals, and stroke counts derived from Unicode Unihan.',
    license_name: 'Unicode License v3',
    license_url: 'https://www.unicode.org/license.txt',
    attribution:
      'Copyright © 1991–2026 Unicode, Inc. Derived from the Unicode Character Database (Unihan).',
    source_url: 'https://www.unicode.org/charts/unihan.html',
  },
  'dict-kanjidic2': {
    filename: 'dict-kanjidic2.json.gz',
    kind: 'dictionary',
    name: 'KANJIDIC2 (Japanese Kanji)',
    language: 'ja',
    description: 'Japanese Kanji readings (on/kun), English meanings, grade, and strokes.',
    ...CC_BY_SA_4,
    attribution:
      'KANJIDIC2 is the property of the Electronic Dictionary Research and Development Group (EDRDG).',
    source_url: 'https://www.edrdg.org/wiki/index.php/KANJIDIC_Project',
  },
  'dict-cc-cedict': {
    filename: 'dict-cc-cedict.json.gz',
    kind: 'dictionary',
    name: 'CC-CEDICT (Mandarin Chinese)',
    language: 'zh-Hans',
    description: 'Simplified & Traditional Mandarin words, Pinyin, and English definitions.',
    ...CC_BY_SA_4,
    attribution: 'CC-CEDICT community dictionary maintained by MDBG.',
    source_url: 'https://www.mdbg.net/chinese/dictionary?page=cc-cedict',
  },
  'dict-jmdict': {
    filename: 'dict-jmdict.json.gz',
    kind: 'dictionary',
    name: 'JMdict (Japanese Words — Optional, Large)',
    language: 'ja',
    description: 'Comprehensive Japanese-English word dictionary (optional large pack).',
    ...CC_BY_SA_4,
    attribution:
      'JMdict is the property of the Electronic Dictionary Research and Development Group (EDRDG).',
    source_url: 'https://www.edrdg.org/jmdict/j_jmdict.html',
    optional: true,
  },
  'dict-krdict': {
    filename: 'dict-krdict.json.gz',
    kind: 'dictionary',
    name: 'Korean Basic Dictionary (KRDict, English)',
    language: 'ko',
    description:
      'Korean words with per-sense English equivalents and definitions, part of speech, learner level, pronunciation, Hanja origin and examples (NIKL 한국어기초사전).',
    license_name: 'CC BY-SA 2.0 KR',
    license_url: 'https://creativecommons.org/licenses/by-sa/2.0/kr/',
    attribution:
      '한국어기초사전 (Korean Basic Dictionary) © National Institute of Korean Language (국립국어원).',
    source_url: 'https://krdict.korean.go.kr/',
  },
  'strokes-ja-kanjivg': {
    filename: 'strokes-ja-kanjivg.json.gz',
    kind: 'strokes',
    name: 'Japanese Stroke Data (KanjiVG)',
    language: 'ja',
    script: 'ja',
    description:
      'Japanese Kanji stroke order vectors and medians for graded drawing & lookup (kept separate from Chinese).',
    license_name: 'CC BY-SA 3.0',
    license_url: 'https://creativecommons.org/licenses/by-sa/3.0/',
    attribution: 'KanjiVG is copyright © 2009–2026 Ulrich Apel and contributors.',
    source_url: 'https://kanjivg.tagaini.net/',
  },
  'strokes-zh-mmah': {
    filename: 'strokes-zh-mmah.json.gz',
    kind: 'strokes',
    name: 'Chinese & Hanja Stroke Data (Make Me a Hanzi)',
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
};

function makeManifest(id, version, extra = {}) {
  const m = PACK_META[id];
  // Key order matches the historical starter fixtures so their sha256 stays stable.
  return {
    format_version: 1,
    id,
    kind: m.kind,
    name: m.name,
    version,
    language: m.language,
    ...(m.script ? { script: m.script } : {}),
    description: m.description,
    license_name: m.license_name,
    license_url: m.license_url,
    attribution: m.attribution,
    source_url: m.source_url,
    ...extra,
  };
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

function assertWithinLimits(filename, stats, entryCount) {
  const problems = [];
  if (stats.compressed_bytes > MAX_STATIC_FILE_BYTES) {
    problems.push(
      `${stats.compressed_bytes} B gzipped exceeds the 25 MiB Cloudflare Pages file limit — host it on R2 instead (docs/design_blueprint.md §3.4)`,
    );
  }
  if (stats.compressed_bytes > RUNTIME_LIMITS.maxCompressedBytes) {
    problems.push('exceeds runtime maxCompressedBytes');
  }
  if (stats.uncompressed_bytes > RUNTIME_LIMITS.maxUncompressedBytes) {
    problems.push(
      `${stats.uncompressed_bytes} B uncompressed exceeds runtime maxUncompressedBytes`,
    );
  }
  if (entryCount > RUNTIME_LIMITS.maxEntries) {
    problems.push(`${entryCount} entries exceeds runtime maxEntries`);
  }
  if (problems.length > 0) {
    throw new Error(`Pack ${filename}: ${problems.join('; ')}`);
  }
}

const LICENSE_SECTIONS = [
  [
    'dict-hanja-unihan',
    'Unicode License v3 (https://www.unicode.org/license.txt)',
    'Unicode Character Database (Unihan) — https://www.unicode.org/charts/unihan.html',
    'Copyright © 1991–2026 Unicode, Inc. Fields kHangul, kDefinition, kTotalStrokes, kRSUnicode and variant\n   mappings were converted to JSON. The full Unicode License v3 text is reproduced in UNICODE-LICENSE.txt\n   (full builds) and at the URL above.',
  ],
  [
    'dict-kanjidic2',
    'CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/) — share-alike',
    'EDRDG KANJIDIC2 — https://www.edrdg.org/wiki/index.php/KANJIDIC_Project',
    "KANJIDIC2 is the property of the Electronic Dictionary Research and Development Group and is used in\n   conformance with the Group's licence (https://www.edrdg.org/edrdg/licence.html). Changes: on/kun/nanori\n   readings, English meanings, grade, JLPT, frequency, stroke count and classical radical extracted to JSON.",
  ],
  [
    'dict-cc-cedict',
    'CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/) — share-alike',
    'MDBG CC-CEDICT — https://www.mdbg.net/chinese/dictionary?page=cc-cedict',
    'Based on CEDICT © 1997, 1998 Paul Andrew Denisowski. Changes: converted to JSON; pinyin "u:" written as "v".',
  ],
  [
    'dict-jmdict',
    'CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/) — share-alike',
    'EDRDG JMdict (English) — https://www.edrdg.org/jmdict/j_jmdict.html',
    "JMdict is the property of the Electronic Dictionary Research and Development Group and is used in\n   conformance with the Group's licence (https://www.edrdg.org/edrdg/licence.html). Changes: headwords,\n   readings, English glosses (one string per sense) and priority/frequency bands extracted to JSON.",
  ],
  [
    'dict-krdict',
    'CC BY-SA 2.0 KR (https://creativecommons.org/licenses/by-sa/2.0/kr/) — share-alike',
    'NIKL 한국어기초사전 (Korean Basic Dictionary), English edition — https://krdict.korean.go.kr/',
    'Text © National Institute of Korean Language (국립국어원). Changes: headword, homonym number, part of\n   speech, vocabulary level, 원어 (Hanja origin), standard pronunciation, conjugations, Korean definitions,\n   English equivalents/definitions and up to 3 examples per sense extracted to JSON. Audio and images are\n   not included. The starter (dev/CI) pack is a small hand-authored sample in the same format.',
  ],
  [
    'strokes-ja-kanjivg',
    'CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/) — share-alike',
    'KanjiVG (Ulrich Apel & contributors) — https://kanjivg.tagaini.net/',
    'Changes: stroke centerlines resampled and converted from 109×109 SVG to Hanzi Writer 1024×1024 JSON\n   (medians + ribbon outlines).',
  ],
  [
    'strokes-zh-mmah',
    'Arphic Public License (1999) (https://ftp.gnu.org/gnu/non-gnu/chinese-fonts-truetype/LICENSE)',
    'Make Me a Hanzi graphics.txt — https://github.com/skishore/makemeahanzi',
    "graphics.txt is derived from the Arphic PL KaitiM GB and Arphic PL UKai fonts © 1994–1999 Arphic\n   Technology Co., Ltd. and is redistributed (re-encoded as JSON, medians rounded) under the Arphic Public\n   License, whose full text is reproduced in ARPHIC-PL.txt (full builds). Make Me a Hanzi's dictionary.txt\n   (LGPL) is NOT used.",
  ],
];

function buildLicensesText(versions = {}) {
  const lines = [
    'Flashcards Offline Data Packs — Upstream Licenses & Attributions',
    '================================================================',
    '',
    'These data packs are adapted from the open-data sources below. CC BY-SA packs are distributed under',
    'the same licence (share-alike); the app code that reads them is licensed separately.',
    '',
  ];
  LICENSE_SECTIONS.forEach(([id, license, source, notes], i) => {
    lines.push(`${i + 1}. ${id}: ${license}`);
    lines.push(`   Source: ${source}`);
    if (versions[id]) lines.push(`   Upstream version: ${versions[id]}`);
    lines.push(`   ${notes}`);
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * Writes every pack, optional per-character stroke files, `packs.json`, `_headers` and `LICENSES.txt`.
 * `urlPrefix` is either a same-origin path (`/packs`) or an absolute https base URL.
 */
function emitPacks({ outDir, urlPrefix, packs, catalogName, updatedAt, writeCharFiles, versions }) {
  mkdirSync(outDir, { recursive: true });
  const prefix = urlPrefix.replace(/\/+$/, '');

  const catalogPacks = packs.map(({ id, payload, entryCount, charFileNotice }) => {
    const meta = PACK_META[id];
    let charTemplate;
    if (meta.kind === 'strokes' && writeCharFiles) {
      const charDir = join(outDir, 'strokes', meta.script);
      mkdirSync(charDir, { recursive: true });
      for (const [ch, data] of Object.entries(payload.characters)) {
        const body = charFileNotice ? { ...data, notice: charFileNotice } : data;
        writeFileSync(join(charDir, `${charToHex5(ch)}.json`), JSON.stringify(body), 'utf8');
      }
      charTemplate = `${prefix}/strokes/${meta.script}/{hex5}.json`;
    }

    const stats = writeGzipPack(outDir, meta.filename, payload);
    assertWithinLimits(meta.filename, stats, entryCount);
    const m = payload.manifest;
    console.log(
      `  ${meta.filename.padEnd(28)} ${String(entryCount).padStart(7)} entries  ${(stats.compressed_bytes / 1048576).toFixed(2).padStart(6)} MiB gz  ${(stats.uncompressed_bytes / 1048576).toFixed(2).padStart(7)} MiB raw`,
    );
    return {
      id: m.id,
      kind: m.kind,
      name: m.name,
      description: m.description,
      version: m.version,
      language: m.language,
      ...(m.script ? { script: m.script } : {}),
      url: `${prefix}/${meta.filename}`,
      compressed_bytes: stats.compressed_bytes,
      uncompressed_bytes: stats.uncompressed_bytes,
      entry_count: entryCount,
      sha256: stats.sha256,
      license_name: m.license_name,
      license_url: m.license_url,
      attribution: m.attribution,
      source_url: m.source_url,
      ...(meta.optional ? { optional: true } : {}),
      ...(charTemplate ? { char_url_template: charTemplate } : {}),
    };
  });

  const catalog = {
    format_version: 1,
    name: catalogName,
    updated_at: updatedAt,
    packs: catalogPacks,
  };

  writeFileSync(join(outDir, 'packs.json'), JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  writeFileSync(
    join(outDir, '_headers'),
    '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=3600\n',
    'utf8',
  );
  writeFileSync(join(outDir, 'LICENSES.txt'), buildLicensesText(versions), 'utf8');
  return catalog;
}

/* ------------------------------------------------------------------------------------------ */
/* Starter (dev/CI fixtures)                                                                   */
/* ------------------------------------------------------------------------------------------ */

async function buildStarterPacks({ outDir, urlPrefix }) {
  const version = '2026.11.0-starter';
  const { jaCharacters, zhCharacters } = buildStarterStrokeSets();
  const { hanjaEntries, kanjidicEntries, cedictEntries, jmdictEntries } =
    buildStarterDictionaries();
  // Korean words: hand-authored rows rendered as KRDict LMF XML and run through the real parser,
  // so the starter build exercises exactly the code path used for the full KRDict download.
  const { parseKrdictXml } = await import('./packs/upstream-parsers.mjs');
  const { renderKrdictStarterXml } = await import('./packs/krdict-starter.mjs');
  const krdictEntries = parseKrdictXml(renderKrdictStarterXml());

  const dict = (id, entries, extra) => ({
    id,
    payload: { manifest: makeManifest(id, version, extra), entries },
    entryCount: entries.length,
  });
  const strokes = (id, characters) => ({
    id,
    payload: { manifest: makeManifest(id, version), characters },
    entryCount: Object.keys(characters).length,
  });

  const catalog = emitPacks({
    outDir,
    urlPrefix,
    catalogName: 'Flashcards Offline Packs (Starter / Dev Fixtures)',
    updatedAt: '2026-11-21T00:00:00Z',
    writeCharFiles: true,
    packs: [
      dict('dict-hanja-unihan', hanjaEntries),
      dict('dict-kanjidic2', kanjidicEntries),
      dict('dict-cc-cedict', cedictEntries),
      dict('dict-jmdict', jmdictEntries),
      dict('dict-krdict', krdictEntries, {
        description:
          'Starter sample: a few dozen common Korean words in the KRDict format (POS, level, pronunciation, Hanja, examples). Install the full KRDict pack for complete coverage.',
        modification_notice:
          'Hand-authored sample entries in the KRDict (한국어기초사전) structure for offline dev/CI; not copied from NIKL data.',
      }),
      strokes('strokes-ja-kanjivg', jaCharacters),
      strokes('strokes-zh-mmah', zhCharacters),
    ],
  });
  console.log(`Built ${catalog.packs.length} starter packs + packs.json in ${outDir}`);
}

/* ------------------------------------------------------------------------------------------ */
/* Full (real upstream open data, see scripts/fetch-upstream-packs.mjs)                        */
/* ------------------------------------------------------------------------------------------ */

function readMaybeGz(path) {
  const buf = readFileSync(path);
  return (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
}

function requireInput(inputDir, rel) {
  const p = join(inputDir, rel);
  if (!existsSync(p)) {
    throw new Error(
      `Missing upstream file ${p}. Run \`node scripts/fetch-upstream-packs.mjs --dir ${inputDir}\` first.`,
    );
  }
  return p;
}

/** Every *.xml / *.xml.gz under <input>/krdict/ (sorted, so builds are reproducible). */
function listKrdictXmlFiles(inputDir) {
  const dir = join(inputDir, 'krdict');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => /\.xml(\.gz)?$/i.test(f))
    .sort()
    .map((f) => join(dir, f));
}

async function buildFullPacks({ inputDir, outDir, urlPrefix, writeCharFiles, includeJmdict }) {
  const parsers = await import('./packs/upstream-parsers.mjs');
  // Reuse the runtime's own KanjiVG converter so build output matches on-device conversions.
  const { convertKanjivgSvgToHanziWriter } = await import(
    pathToFileURL(join(REPO_ROOT, 'packages', 'core', 'src', 'drawing', 'kanjivg.ts')).href
  );
  const sourcesPath = join(inputDir, 'sources.json');
  const sources = existsSync(sourcesPath) ? JSON.parse(readFileSync(sourcesPath, 'utf8')) : {};

  const packs = [];
  const versions = {};
  const builtOn = new Date().toISOString().slice(0, 10);
  const add = (id, version, body, entryCount, upstreamKey, notice) => {
    versions[id] = version;
    const src = sources[upstreamKey];
    packs.push({
      id,
      payload: {
        manifest: makeManifest(id, version, {
          ...(src ? { upstream_sha256: src.sha256 } : {}),
          ...(notice ? { modification_notice: notice } : {}),
        }),
        ...body,
      },
      entryCount,
      ...(notice ? { charFileNotice: notice } : {}),
    });
  };

  console.log('Parsing Unihan …');
  const readings = readFileSync(requireInput(inputDir, 'unihan/Unihan_Readings.txt'), 'utf8');
  const hanja = parsers.parseUnihanHanja({
    readings,
    irgSources: readFileSync(requireInput(inputDir, 'unihan/Unihan_IRGSources.txt'), 'utf8'),
    variants: readFileSync(requireInput(inputDir, 'unihan/Unihan_Variants.txt'), 'utf8'),
  });
  add(
    'dict-hanja-unihan',
    `unihan-${parsers.unihanVersion(readings) ?? 'unknown'}`,
    { entries: hanja },
    hanja.length,
    'unihan',
  );

  console.log('Parsing KANJIDIC2 …');
  const kanjidicXml = readMaybeGz(requireInput(inputDir, 'raw/kanjidic2.xml.gz'));
  const kanjidic = parsers.parseKanjidic2(kanjidicXml);
  add(
    'dict-kanjidic2',
    `kanjidic2-${parsers.kanjidic2Version(kanjidicXml) ?? 'unknown'}`,
    { entries: kanjidic },
    kanjidic.length,
    'kanjidic2',
  );

  console.log('Parsing CC-CEDICT …');
  const cedictText = readMaybeGz(requireInput(inputDir, 'raw/cedict_1_0_ts_utf-8_mdbg.txt.gz'));
  const cedict = parsers.parseCedict(cedictText);
  add(
    'dict-cc-cedict',
    `cedict-${parsers.cedictVersion(cedictText) ?? 'unknown'}`,
    { entries: cedict },
    cedict.length,
    'cedict',
  );

  if (includeJmdict) {
    console.log('Parsing JMdict (large) …');
    const jmdictXml = readMaybeGz(requireInput(inputDir, 'raw/JMdict_e.gz'));
    const jmdict = parsers.parseJmdict(jmdictXml);
    add(
      'dict-jmdict',
      `jmdict-${parsers.jmdictVersion(jmdictXml) ?? 'unknown'}`,
      { entries: jmdict },
      jmdict.length,
      'jmdict',
    );
  }

  // KRDict's "사전 전체 내려받기" export sits behind a site popup, not a stable anonymous URL, so the
  // owner places it in <input>/krdict/ by hand (see scripts/fetch-upstream-packs.mjs). Skip when absent.
  const krdictFiles = listKrdictXmlFiles(inputDir);
  if (krdictFiles.length > 0) {
    console.log(`Parsing KRDict (${krdictFiles.length} XML file(s)) …`);
    const krdict = krdictFiles.flatMap((f) => parsers.parseKrdictXml(readMaybeGz(f)));
    add(
      'dict-krdict',
      `krdict-${sources.krdict?.version ?? 'manual'}`,
      { entries: krdict },
      krdict.length,
      'krdict',
    );
  } else {
    console.warn(
      `Skipping dict-krdict: no KRDict XML in ${join(inputDir, 'krdict')}. Download it manually (see scripts/fetch-upstream-packs.mjs).`,
    );
  }

  console.log('Converting KanjiVG strokes …');
  const kanjivg = parsers.parseKanjivgXml(
    readMaybeGz(requireInput(inputDir, 'raw/kanjivg.xml.gz')),
    convertKanjivgSvgToHanziWriter,
  );
  add(
    'strokes-ja-kanjivg',
    `kanjivg-${sources.kanjivg?.version ?? 'unknown'}`,
    { characters: kanjivg },
    Object.keys(kanjivg).length,
    'kanjivg',
  );

  console.log('Parsing Make Me a Hanzi strokes …');
  const mmah = parsers.parseMmahGraphics(
    readFileSync(requireInput(inputDir, 'raw/mmah-graphics.txt'), 'utf8'),
  );
  add(
    'strokes-zh-mmah',
    `mmah-${(sources.mmah?.version ?? 'unknown').slice(0, 7)}`,
    { characters: mmah },
    Object.keys(mmah).length,
    'mmah',
    // Arphic PL §2(a): every modified file must state how and when it was changed.
    `Modified ${builtOn}: re-encoded from Make Me a Hanzi graphics.txt (${(sources.mmah?.version ?? 'unknown').slice(0, 7)}) as JSON with medians rounded to integers. Arphic Public License; see ARPHIC-PL.txt.`,
  );

  // Clear previous per-character files so stale glyphs never linger between upstream versions.
  rmSync(join(outDir, 'strokes'), { recursive: true, force: true });
  console.log(`Writing packs to ${outDir} …`);
  const catalog = emitPacks({
    outDir,
    urlPrefix,
    catalogName: 'Flashcards Offline Packs (Full Open Data)',
    updatedAt: new Date().toISOString(),
    writeCharFiles,
    packs,
    versions,
  });

  copyFileSync(requireInput(inputDir, 'raw/ARPHICPL.TXT'), join(outDir, 'ARPHIC-PL.txt'));
  const unicodeLicense = join(inputDir, 'raw', 'unicode-license.txt');
  if (existsSync(unicodeLicense)) copyFileSync(unicodeLicense, join(outDir, 'UNICODE-LICENSE.txt'));
  console.log(`Built ${catalog.packs.length} full packs + packs.json in ${outDir}`);
}

/* ------------------------------------------------------------------------------------------ */
/* CLI                                                                                         */
/* ------------------------------------------------------------------------------------------ */

function parseCli(argv) {
  const opts = {
    full: false,
    input: undefined,
    out: undefined,
    baseUrl: undefined,
    charFiles: true,
    jmdict: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') opts.full = true;
    else if (a === '--starter') opts.full = false;
    else if (a === '--input') opts.input = resolve(argv[++i]);
    else if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--no-char-files') opts.charFiles = false;
    else if (a === '--skip-jmdict') opts.jmdict = false;
    else throw new Error(`Unknown argument "${a}"`);
  }
  if (opts.baseUrl !== undefined && !/^https:\/\/[^/\s]+/.test(opts.baseUrl)) {
    throw new Error(`--base-url must be an absolute https:// URL (got "${opts.baseUrl}")`);
  }
  return opts;
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const urlPrefix = opts.baseUrl ?? '/packs';
  if (opts.full) {
    await buildFullPacks({
      inputDir: opts.input ?? join(REPO_ROOT, '.cache', 'upstream-open-data'),
      outDir: opts.out ?? join(REPO_ROOT, 'dist-packs'),
      urlPrefix,
      writeCharFiles: opts.charFiles,
      includeJmdict: opts.jmdict,
    });
  } else {
    await buildStarterPacks({
      outDir: opts.out ?? join(REPO_ROOT, 'apps', 'web', 'public', 'packs'),
      urlPrefix,
    });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
