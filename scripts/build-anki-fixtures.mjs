#!/usr/bin/env node
/**
 * Deterministic tiny Anki `.apkg` fixtures for the Phase 12 importer tests (unit, golden, e2e).
 *
 * Usage: node scripts/build-anki-fixtures.mjs [--out <dir>]   (default: tests/fixtures/anki/)
 *
 * Every byte is reproducible: SQLite files come from sql.js with fixed rows, zip entries use a
 * fixed DOS timestamp, deflate uses node:zlib at a fixed level, and anki21b payloads use raw
 * (stored) zstd blocks, which need no compressor. `scripts/tests/anki-fixtures.test.mjs`
 * rebuilds them and compares against the committed files.
 *
 * Malicious fixtures are hand-built zips: path traversal (`../`, absolute, backslash, drive
 * letter), too many files, a deflate bomb whose headers lie about its size, a zstd bomb made of
 * RLE blocks, and fields full of script / iframe / event-handler HTML.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'anki');

const FS = '\u001f';
const enc = new TextEncoder();

// ---------------------------------------------------------------------------------------------
// Zip writer (STORE or DEFLATE, fixed timestamp, optional lying size headers)
// ---------------------------------------------------------------------------------------------

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01

function u16(n) {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function u32(n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/**
 * @param {Array<{ name: string, data: Uint8Array, deflate?: boolean, declaredSize?: number }>} entries
 */
export function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const body = entry.deflate
      ? new Uint8Array(deflateRawSync(entry.data, { level: 9 }))
      : entry.data;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(entry.data) >>> 0;
    const size = entry.declaredSize ?? entry.data.length;
    const common = [
      ...u16(20),
      ...u16(0x0800), // UTF-8 names
      ...u16(method),
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(body.length),
      ...u32(size),
      ...u16(name.length),
      ...u16(0),
    ];
    const local = new Uint8Array([...u32(0x04034b50), ...common]);
    parts.push(local, name, body);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...common,
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
      ]),
      name,
    );
    offset += local.length + name.length + body.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralSize),
    ...u32(offset),
    ...u16(0),
  ]);
  return concat([...parts, ...central, end]);
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Protobuf + zstd (raw / RLE blocks) encoders for anki21b
// ---------------------------------------------------------------------------------------------

function varint(n) {
  const out = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

function pbVarint(field, value) {
  return [...varint(field * 8), ...varint(value)];
}

function pbBytes(field, bytes) {
  const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
  return [...varint(field * 8 + 2), ...varint(b.length), ...b];
}

function zstdRaw(data) {
  const out = [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58];
  let offset = 0;
  do {
    const size = Math.min(128 * 1024 - 1, data.length - offset);
    const last = offset + size >= data.length ? 1 : 0;
    const bh = (size << 3) | last;
    out.push(
      bh & 0xff,
      (bh >> 8) & 0xff,
      (bh >> 16) & 0xff,
      ...data.subarray(offset, offset + size),
    );
    offset += size;
  } while (offset < data.length);
  return new Uint8Array(out);
}

/** A zstd "bomb": `blocks` RLE blocks of ~2 MiB each from a few hundred input bytes. */
function zstdRleBomb(blocks) {
  const out = [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58];
  const size = (1 << 21) - 1;
  for (let i = 0; i < blocks; i++) {
    const last = i === blocks - 1 ? 1 : 0;
    const bh = (size << 3) | (1 << 1) | last;
    out.push(bh & 0xff, (bh >> 8) & 0xff, (bh >> 16) & 0xff, 0x41);
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------------------------
// SQLite collections (schema 11 = anki2/anki21, schema 18 = anki21b)
// ---------------------------------------------------------------------------------------------

/** Keeps fixtures tiny (Anki itself uses 4 KiB pages; readers must not care). */
const SMALL_PAGES = 'PRAGMA page_size = 512;';

const SCHEMA_COMMON = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
`;

/**
 * Anki's own schema-18 DDL for the tables the reader touches, `COLLATE unicase`, unique name
 * indexes and `WITHOUT ROWID` included. sql.js has no `unicase` collation (and no API to add
 * one), so `createSchema18` creates the tables without it and `restoreUnicase` then writes the
 * real declarations into `sqlite_master`: the fixture carries the exact schema a real export
 * has, and the reader must cope with the missing collation.
 */
const SCHEMA_18 = [
  [
    'notetypes',
    'CREATE TABLE notetypes (id integer NOT NULL PRIMARY KEY, name text NOT NULL COLLATE unicase, mtime_secs integer NOT NULL, usn integer NOT NULL, config blob NOT NULL)',
  ],
  ['idx_notetypes_name', 'CREATE UNIQUE INDEX idx_notetypes_name ON notetypes (name)'],
  ['idx_notetypes_usn', 'CREATE INDEX idx_notetypes_usn ON notetypes (usn)'],
  [
    'fields',
    'CREATE TABLE fields (ntid integer NOT NULL, ord integer NOT NULL, name text NOT NULL COLLATE unicase, config blob NOT NULL, PRIMARY KEY (ntid, ord)) without rowid',
  ],
  ['idx_fields_name_ntid', 'CREATE UNIQUE INDEX idx_fields_name_ntid ON fields (name, ntid)'],
  [
    'templates',
    'CREATE TABLE templates (ntid integer NOT NULL, ord integer NOT NULL, name text NOT NULL COLLATE unicase, mtime_secs integer NOT NULL, usn integer NOT NULL, config blob NOT NULL, PRIMARY KEY (ntid, ord)) without rowid',
  ],
  [
    'idx_templates_name_ntid',
    'CREATE UNIQUE INDEX idx_templates_name_ntid ON templates (name, ntid)',
  ],
  ['idx_templates_usn', 'CREATE INDEX idx_templates_usn ON templates (usn)'],
  [
    'decks',
    'CREATE TABLE decks (id integer PRIMARY KEY NOT NULL, name text NOT NULL COLLATE unicase, mtime_secs integer NOT NULL, usn integer NOT NULL, common blob NOT NULL, kind blob NOT NULL)',
  ],
  ['idx_decks_name', 'CREATE UNIQUE INDEX idx_decks_name ON decks (name)'],
  [
    'config',
    'CREATE TABLE config (KEY text NOT NULL PRIMARY KEY, usn integer NOT NULL, mtime_secs integer NOT NULL, val blob NOT NULL) without rowid',
  ],
  [
    'tags',
    'CREATE TABLE tags (tag text NOT NULL PRIMARY KEY COLLATE unicase, usn integer NOT NULL, collapsed boolean NOT NULL, config blob NULL) without rowid',
  ],
];

const UNICASE = ' COLLATE unicase';

function createSchema18(db) {
  for (const [, sql] of SCHEMA_18) db.run(sql.replaceAll(UNICASE, ''));
}

/** Writes Anki's real `COLLATE unicase` declarations into the schema (after the rows exist). */
function restoreUnicase(db) {
  db.run('PRAGMA writable_schema = ON');
  for (const [name, sql] of SCHEMA_18) {
    if (sql.includes(UNICASE))
      db.run('UPDATE sqlite_master SET sql = ? WHERE name = ?', [sql, name]);
  }
  db.run('PRAGMA writable_schema = OFF');
}

let sqlPromise;
function sqlJs() {
  sqlPromise ??= require('sql.js')();
  return sqlPromise;
}

const CRT = 1_600_000_000;

function legacyModel(id, name, type, fields, templates) {
  return {
    id,
    name,
    type,
    mod: CRT,
    usn: 0,
    sortf: 0,
    did: 1,
    css: '.card { font-family: arial; }',
    flds: fields.map((f, ord) => ({
      name: f,
      ord,
      sticky: false,
      rtl: false,
      font: 'Arial',
      size: 20,
    })),
    tmpls: templates.map(([tname, qfmt, afmt], ord) => ({
      name: tname,
      ord,
      qfmt,
      afmt,
      did: null,
    })),
    req: [],
  };
}

function legacyDeck(id, name, dyn = 0) {
  return { id, name, dyn, mod: CRT, usn: 0, desc: '', collapsed: false, conf: 1 };
}

/**
 * Cards are `[id, nid, did, ord, odid = 0, queue = 0]` (queue -1 = suspended, -2/-3 = buried).
 * @param {{ models: object[], decks: object[], notes: Array<[number, string, number, string, string[]]>,
 *   cards: Array<[number, number, number, number, number?, number?]>, revlog?: number[][], schedVer?: number }} spec
 */
async function legacyCollection(spec) {
  const SQL = await sqlJs();
  const db = new SQL.Database();
  db.run(SMALL_PAGES);
  db.run(SCHEMA_COMMON);
  const models = Object.fromEntries(spec.models.map((m) => [String(m.id), m]));
  const decks = Object.fromEntries(spec.decks.map((d) => [String(d.id), d]));
  const conf = { schedVer: spec.schedVer ?? 2, nextPos: 1 };
  db.run('INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)', [
    CRT,
    CRT * 1000,
    CRT * 1000,
    JSON.stringify(conf),
    JSON.stringify(models),
    JSON.stringify(decks),
    '{}',
    '{}',
  ]);
  insertNotesCards(db, spec);
  const bytes = db.export();
  db.close();
  return bytes;
}

function insertNotesCards(db, spec) {
  for (const [id, guid, mid, tags, flds] of spec.notes) {
    const tagText = tags.length ? ` ${tags.join(' ')} ` : '';
    db.run('INSERT INTO notes VALUES (?, ?, ?, ?, 0, ?, ?, ?, 0, 0, ?)', [
      id,
      guid,
      mid,
      CRT,
      tagText,
      flds.join(FS),
      flds[0] ?? '',
      '',
    ]);
  }
  for (const [id, nid, did, ord, odid = 0, queue = 0] of spec.cards) {
    db.run('INSERT INTO cards VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 0, 0, 0, 0, 0, 0, ?, 0, ?)', [
      id,
      nid,
      did,
      ord,
      CRT,
      queue,
      id,
      odid,
      '',
    ]);
  }
  for (const [id, cid, ease, ivl, lastIvl, factor, time, type] of spec.revlog ?? []) {
    db.run('INSERT INTO revlog VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)', [
      id,
      cid,
      ease,
      ivl,
      lastIvl,
      factor,
      time,
      type,
    ]);
  }
}

/** The "please update Anki" stub new Anki versions put next to `collection.anki21b`. */
async function stubCollection() {
  const basic = legacyModel(
    1,
    'Basic',
    0,
    ['Front', 'Back'],
    [['Card 1', '{{Front}}', '{{Back}}']],
  );
  return legacyCollection({
    models: [basic],
    decks: [legacyDeck(1, 'Default')],
    notes: [
      [
        1,
        'stub',
        1,
        [],
        ['Please update to the latest Anki version, then import the .colpkg/.apkg file again.', ''],
      ],
    ],
    cards: [[1, 1, 1, 0]],
  });
}

// ---------------------------------------------------------------------------------------------
// Fixture definitions
// ---------------------------------------------------------------------------------------------

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const MP3_TINY = new Uint8Array([
  0x49,
  0x44,
  0x33,
  0x03,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0xff,
  0xfb,
  0x90,
  0x64,
  ...new Array(32).fill(0),
]);

const BASIC_REVERSED = legacyModel(
  1_600_000_000_001,
  'Basic (and reversed card)',
  0,
  ['Front', 'Back'],
  [
    ['Card 1', '{{Front}}', '{{FrontSide}}<hr id=answer>{{Back}}'],
    ['Card 2', '{{Back}}', '{{FrontSide}}<hr id=answer>{{Front}}'],
  ],
);

async function basicReversed() {
  const collection = await legacyCollection({
    models: [BASIC_REVERSED],
    decks: [legacyDeck(1, 'Default'), legacyDeck(1_600_000_000_100, 'Japanese::Vocab')],
    notes: [
      [
        1_600_000_001_000,
        'guidDog01',
        BASIC_REVERSED.id,
        ['animals::mammals', 'pets'],
        ['<b>犬</b>', 'dog<br>(animal)'],
      ],
      [
        1_600_000_002_000,
        'guidCat02',
        BASIC_REVERSED.id,
        ['animals::mammals'],
        ['猫&nbsp;', '<div>cat</div><div>feline</div>'],
      ],
    ],
    cards: [
      [1_600_000_001_001, 1_600_000_001_000, 1_600_000_000_100, 0],
      [1_600_000_001_002, 1_600_000_001_000, 1_600_000_000_100, 1],
      [1_600_000_002_001, 1_600_000_002_000, 1_600_000_000_100, 0],
      [1_600_000_002_002, 1_600_000_002_000, 1_600_000_000_100, 1],
    ],
  });
  return buildZip([
    { name: 'collection.anki2', data: collection, deflate: true },
    { name: 'media', data: enc.encode('{}') },
  ]);
}

const CLOZE = legacyModel(
  1_600_000_000_002,
  'Cloze',
  1,
  ['Text', 'Back Extra'],
  [['Cloze', '{{cloze:Text}}', '{{cloze:Text}}<br>{{Back Extra}}']],
);

async function cloze() {
  const collection = await legacyCollection({
    models: [CLOZE],
    decks: [legacyDeck(1, 'Default'), legacyDeck(1_600_000_000_200, 'Geography')],
    notes: [
      [
        1_600_000_003_000,
        'guidTokyo3',
        CLOZE.id,
        ['geo::asia'],
        ['{{c1::東京}}は日本の{{c2::首都::capital}}です', 'Tokyo'],
      ],
      [
        1_600_000_004_000,
        'guidSeoul4',
        CLOZE.id,
        ['geo::asia', 'korea'],
        ['<i>{{c1::Seoul}}</i> is in {{c2::Korea}}', ''],
      ],
    ],
    cards: [
      [1_600_000_003_001, 1_600_000_003_000, 1_600_000_000_200, 0],
      [1_600_000_003_002, 1_600_000_003_000, 1_600_000_000_200, 1],
      [1_600_000_004_001, 1_600_000_004_000, 1_600_000_000_200, 0],
      [1_600_000_004_002, 1_600_000_004_000, 1_600_000_000_200, 1],
    ],
  });
  // Anki 2.1 legacy exports: real data in collection.anki21 plus a stub collection.anki2.
  return buildZip([
    { name: 'collection.anki2', data: await stubCollection(), deflate: true },
    { name: 'collection.anki21', data: collection, deflate: true },
    { name: 'media', data: enc.encode('{}') },
  ]);
}

const JAPANESE = legacyModel(
  1_600_000_000_003,
  'Japanese (recognition)',
  0,
  ['Expression', 'Meaning', 'Reading'],
  [
    [
      'Recognition',
      '{{kanji:Reading}}',
      '{{FrontSide}}<hr id=answer>{{furigana:Reading}}<br>{{Meaning}}{{tts ja_JP:Expression}}',
    ],
  ],
);

async function japaneseFurigana() {
  const collection = await legacyCollection({
    models: [JAPANESE],
    decks: [legacyDeck(1, 'Default'), legacyDeck(1_600_000_000_300, 'Japanese::Sentences')],
    notes: [
      [
        1_600_000_005_000,
        'guidStudy5',
        JAPANESE.id,
        ['jlpt::n5'],
        [
          '私は日本語を勉強します',
          'I study Japanese',
          '私[わたし]は 日本語[にほんご]を 勉強[べんきょう]します',
        ],
      ],
      [
        1_600_000_006_000,
        'guidEat006',
        JAPANESE.id,
        ['jlpt::n5', 'verbs'],
        ['食べる', 'to eat', ' 食べる[たべる]'],
      ],
      [
        1_600_000_007_000,
        'guidTwo007',
        JAPANESE.id,
        [],
        ['日本語', 'Japanese language', '日本[にほん] 語[ご]'],
      ],
    ],
    cards: [
      [1_600_000_005_001, 1_600_000_005_000, 1_600_000_000_300, 0],
      [1_600_000_006_001, 1_600_000_006_000, 1_600_000_000_300, 0],
      [1_600_000_007_001, 1_600_000_007_000, 1_600_000_000_300, 0],
    ],
  });
  return buildZip([
    { name: 'collection.anki2', data: collection, deflate: true },
    { name: 'media', data: enc.encode('{}') },
  ]);
}

const BASIC = legacyModel(
  1_600_000_000_004,
  'Basic',
  0,
  ['Front', 'Back'],
  [['Card 1', '{{Front}}', '{{FrontSide}}<hr id=answer>{{Back}}']],
);

async function media() {
  const collection = await legacyCollection({
    models: [BASIC],
    decks: [legacyDeck(1, 'Default')],
    notes: [
      [
        1_600_000_008_000,
        'guidMedia8',
        BASIC.id,
        ['media'],
        ['<img src="tiny.png">犬', 'dog [sound:dog.mp3]'],
      ],
      [
        1_600_000_009_000,
        'guidMedia9',
        BASIC.id,
        ['media'],
        ['<img src="evil.svg"><img src="missing.jpg">猫', 'cat'],
      ],
    ],
    cards: [
      [1_600_000_008_001, 1_600_000_008_000, 1, 0],
      [1_600_000_009_001, 1_600_000_009_000, 1, 0],
    ],
  });
  const evilSvg = enc.encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  return buildZip([
    { name: 'collection.anki2', data: collection, deflate: true },
    {
      name: 'media',
      data: enc.encode(JSON.stringify({ 0: 'tiny.png', 1: 'dog.mp3', 2: 'evil.svg' })),
    },
    { name: '0', data: PNG_1X1 },
    { name: '1', data: MP3_TINY },
    { name: '2', data: evilSvg },
  ]);
}

async function htmlScript() {
  const collection = await legacyCollection({
    models: [BASIC],
    decks: [legacyDeck(1, 'Default')],
    notes: [
      [
        1_600_000_010_000,
        'guidHtml10',
        BASIC.id,
        ['xss'],
        [
          '<script>alert("front")</script>Hello<iframe src="https://evil.example"></iframe><img src=x onerror="alert(1)"> <b onclick="x()">world</b>',
          '<style>body{display:none}</style><a href="javascript:alert(1)">link</a> &lt;b&gt;not bold&lt;/b&gt; &amp; <svg><script>alert(2)</script></svg>done',
        ],
      ],
    ],
    cards: [[1_600_000_010_001, 1_600_000_010_000, 1, 0]],
  });
  return buildZip([
    { name: 'collection.anki2', data: collection, deflate: true },
    { name: 'media', data: enc.encode('{}') },
  ]);
}

/** Phase 14: a field shown only through `{{kana:…}}` and one shown only through `{{kanji:…}}`. */
const JAPANESE_KANA = legacyModel(
  1_600_000_000_006,
  'Japanese (kana reading)',
  0,
  ['Expression', 'Reading', 'Meaning'],
  [
    ['Reading', '{{kana:Reading}}', '{{FrontSide}}<hr id=answer>{{Meaning}}'],
    [
      'Kanji',
      '{{kanji:Expression}}',
      '{{FrontSide}}<hr id=answer>{{kanji:Expression}}<br>{{Meaning}}',
    ],
  ],
);

async function kana() {
  const collection = await legacyCollection({
    models: [JAPANESE_KANA],
    decks: [legacyDeck(1, 'Default'), legacyDeck(1_600_000_000_600, 'Japanese::Kana')],
    notes: [
      [
        1_600_000_015_000,
        'guidKana15',
        JAPANESE_KANA.id,
        ['kana'],
        [
          '日本語[にほんご]を 話[はな]す',
          '私[わたし]は 日本語[にほんご]を 話[はな]します',
          'I speak Japanese',
        ],
      ],
      [
        1_600_000_016_000,
        'guidKana16',
        JAPANESE_KANA.id,
        ['kana'],
        [' 食[た]べる', ' 食[た]べる [sound:taberu.mp3]', 'to eat'],
      ],
    ],
    cards: [
      [1_600_000_015_001, 1_600_000_015_000, 1_600_000_000_600, 0],
      [1_600_000_015_002, 1_600_000_015_000, 1_600_000_000_600, 1],
      [1_600_000_016_001, 1_600_000_016_000, 1_600_000_000_600, 0],
      [1_600_000_016_002, 1_600_000_016_000, 1_600_000_000_600, 1],
    ],
  });
  return buildZip([
    { name: 'collection.anki2', data: collection, deflate: true },
    { name: 'media', data: enc.encode('{}') },
  ]);
}

/** Phase 14: suspended (`queue = -1`) and buried (`-2`, `-3`) cards on a two-template model. */
async function suspended() {
  const collection = await legacyCollection({
    models: [BASIC_REVERSED],
    decks: [legacyDeck(1, 'Default'), legacyDeck(1_600_000_000_700, 'Korean::Fruit')],
    notes: [
      [1_600_000_017_000, 'guidSusp17', BASIC_REVERSED.id, ['fruit'], ['사과', 'apple']],
      [1_600_000_018_000, 'guidSusp18', BASIC_REVERSED.id, ['fruit'], ['바나나', 'banana']],
      [1_600_000_019_000, 'guidSusp19', BASIC_REVERSED.id, ['fruit'], ['포도', 'grape']],
    ],
    cards: [
      // 사과: forward card suspended, reverse card normal.
      [1_600_000_017_001, 1_600_000_017_000, 1_600_000_000_700, 0, 0, -1],
      [1_600_000_017_002, 1_600_000_017_000, 1_600_000_000_700, 1, 0, 0],
      // 바나나: buried by the user and as a sibling; neither is imported as suspended.
      [1_600_000_018_001, 1_600_000_018_000, 1_600_000_000_700, 0, 0, -3],
      [1_600_000_018_002, 1_600_000_018_000, 1_600_000_000_700, 1, 0, -2],
      // 포도: reverse card suspended.
      [1_600_000_019_001, 1_600_000_019_000, 1_600_000_000_700, 0, 0, 0],
      [1_600_000_019_002, 1_600_000_019_000, 1_600_000_000_700, 1, 0, -1],
    ],
  });
  return buildZip([
    { name: 'collection.anki2', data: collection, deflate: true },
    { name: 'media', data: enc.encode('{}') },
  ]);
}

/** A second 1x1 PNG and a second tiny MP3 with different bytes, so their hashes differ. */
const PNG_1X1_B = new Uint8Array([...PNG_1X1, 0x00]); // decoders ignore bytes after IEND
const MP3_TINY_B = new Uint8Array([...MP3_TINY.subarray(0, MP3_TINY.length - 1), 0x01]);

/** Phase 14: several images and sounds in one field (all are kept, duplicates once). */
async function multiMedia() {
  const collection = await legacyCollection({
    models: [BASIC],
    decks: [legacyDeck(1, 'Default'), legacyDeck(1_600_000_000_800, 'Korean::Media')],
    notes: [
      [
        1_600_000_020_000,
        'guidMulti20',
        BASIC.id,
        ['media'],
        [
          '<img src="apple.png"><img src="apple-2.png">사과 <img src="apple.png"><img src="gone.png">',
          'apple [sound:apple.mp3] [sound:apple-slow.mp3]',
        ],
      ],
      [
        1_600_000_021_000,
        'guidMulti21',
        BASIC.id,
        ['media'],
        ['<img src="apple-2.png">배', 'pear'],
      ],
    ],
    cards: [
      [1_600_000_020_001, 1_600_000_020_000, 1_600_000_000_800, 0],
      [1_600_000_021_001, 1_600_000_021_000, 1_600_000_000_800, 0],
    ],
  });
  return buildZip([
    { name: 'collection.anki2', data: collection, deflate: true },
    {
      name: 'media',
      data: enc.encode(
        JSON.stringify({
          0: 'apple.png',
          1: 'apple-2.png',
          2: 'apple.mp3',
          3: 'apple-slow.mp3',
        }),
      ),
    },
    { name: '0', data: PNG_1X1 },
    { name: '1', data: PNG_1X1_B },
    { name: '2', data: MP3_TINY },
    { name: '3', data: MP3_TINY_B },
  ]);
}

/** Review log: learn, review, lapse, relearn, cram, manual, rescheduled, unknown card, bad ease. */
const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

async function reviewHistory() {
  const collection = await legacyCollection({
    models: [BASIC],
    decks: [legacyDeck(1, 'Default'), legacyDeck(1_600_000_000_400, 'Filtered Cram', 1)],
    notes: [
      [1_600_000_011_000, 'guidRev011', BASIC.id, [], ['안녕하세요', 'hello']],
      [1_600_000_012_000, 'guidRev012', BASIC.id, [], ['감사합니다', 'thank you']],
    ],
    cards: [
      [1_600_000_011_001, 1_600_000_011_000, 1, 0],
      // Sitting in a filtered deck: its home deck (odid) is Default.
      [1_600_000_012_001, 1_600_000_012_000, 1_600_000_000_400, 0, 1],
    ],
    revlog: [
      // id (ms), cid, ease, ivl, lastIvl, factor, time (ms), type
      [T0, 1_600_000_011_001, 3, -600, 0, 0, 8000, 0],
      [T0 + 10 * 60_000, 1_600_000_011_001, 3, 1, -600, 2500, 6000, 0],
      [T0 + DAY, 1_600_000_011_001, 3, 3, 1, 2500, 5000, 1],
      [T0 + 4 * DAY, 1_600_000_011_001, 1, -600, 3, 2300, 12000, 1],
      [T0 + 4 * DAY + 10 * 60_000, 1_600_000_011_001, 3, 1, -600, 2300, 7000, 2],
      [T0 + 5 * DAY, 1_600_000_011_001, 4, 0, 0, 0, 0, 3],
      [T0 + 6 * DAY, 1_600_000_011_001, 0, 10, 1, 2300, 0, 4],
      [T0 + 7 * DAY, 1_600_000_011_001, 0, 12, 10, 2300, 0, 5],
      [T0 + 2 * DAY, 1_600_000_012_001, 2, 2, 0, 2500, 9000, 1],
      [T0 + 3 * DAY, 9_999_999_999_999, 3, 1, 0, 2500, 1000, 1],
      [T0 + 8 * DAY, 1_600_000_012_001, 7, 1, 0, 2500, 1000, 1],
    ],
  });
  return buildZip([
    { name: 'collection.anki2', data: collection, deflate: true },
    { name: 'media', data: enc.encode('{}') },
  ]);
}

/** anki21b: schema 18 SQLite + zstd + protobuf media map + `meta`, next to the legacy stub. */
async function anki21b() {
  const SQL = await sqlJs();
  const db = new SQL.Database();
  db.run(SMALL_PAGES);
  db.run(SCHEMA_COMMON);
  createSchema18(db);
  db.run("INSERT INTO col VALUES (1, ?, ?, ?, 18, 0, 0, 0, '', '', '', '', '')", [
    CRT,
    CRT * 1000,
    CRT * 1000,
  ]);
  const ntid = 1_600_000_000_005;
  db.run('INSERT INTO notetypes VALUES (?, ?, ?, 0, ?)', [
    ntid,
    'Korean Basic',
    CRT,
    new Uint8Array([...pbVarint(1, 0), ...pbVarint(2, 0)]),
  ]);
  db.run('INSERT INTO fields VALUES (?, 0, ?, ?)', [
    ntid,
    '한국어',
    new Uint8Array(pbBytes(3, 'Arial')),
  ]);
  db.run('INSERT INTO fields VALUES (?, 1, ?, ?)', [
    ntid,
    'English',
    new Uint8Array(pbBytes(3, 'Arial')),
  ]);
  db.run('INSERT INTO templates VALUES (?, 0, ?, ?, 0, ?)', [
    ntid,
    'Recognition',
    CRT,
    new Uint8Array([
      ...pbBytes(1, '{{한국어}}'),
      ...pbBytes(2, '{{FrontSide}}<hr id=answer>{{English}}'),
    ]),
  ]);
  db.run('INSERT INTO decks VALUES (1, ?, ?, 0, ?, ?)', [
    'Default',
    CRT,
    new Uint8Array(0),
    new Uint8Array(pbBytes(1, [])),
  ]);
  db.run('INSERT INTO decks VALUES (?, ?, ?, 0, ?, ?)', [
    1_600_000_000_500,
    `Korean${FS}Greetings`,
    CRT,
    new Uint8Array(0),
    new Uint8Array(pbBytes(1, [])),
  ]);
  db.run("INSERT INTO config VALUES ('schedVer', 0, ?, ?)", [CRT, enc.encode('2')]);
  insertNotesCards(db, {
    notes: [
      [
        1_600_000_013_000,
        'guidKor013',
        ntid,
        ['greetings::formal'],
        ['<img src="flag.png">안녕하세요', 'Hello'],
      ],
      [
        1_600_000_014_000,
        'guidKor014',
        ntid,
        ['greetings'],
        ['고마워요', 'Thanks <i>(polite)</i>'],
      ],
    ],
    cards: [
      [1_600_000_013_001, 1_600_000_013_000, 1_600_000_000_500, 0],
      [1_600_000_014_001, 1_600_000_014_000, 1_600_000_000_500, 0],
    ],
  });
  restoreUnicase(db);
  const collection = db.export();
  db.close();
  const mediaMap = new Uint8Array(
    pbBytes(1, [...pbBytes(1, 'flag.png'), ...pbVarint(2, PNG_1X1.length)]),
  );
  return buildZip([
    { name: 'collection.anki2', data: await stubCollection(), deflate: true },
    { name: 'collection.anki21b', data: zstdRaw(collection) },
    { name: 'media', data: zstdRaw(mediaMap) },
    { name: 'meta', data: new Uint8Array(pbVarint(1, 3)) },
    { name: '0', data: zstdRaw(PNG_1X1) },
  ]);
}

async function withCollection(extra) {
  return buildZip([
    { name: 'collection.anki2', data: await stubCollection(), deflate: true },
    ...extra,
  ]);
}

async function malicious() {
  const one = (name) => withCollection([{ name, data: enc.encode('owned') }]);
  const manyFiles = Array.from({ length: 60 }, (_, i) => ({
    name: `f${i}`,
    data: enc.encode(String(i)),
  }));
  return {
    'malicious-traversal.apkg': await one('../evil.txt'),
    'malicious-traversal-nested.apkg': await one('media/../../evil.txt'),
    'malicious-absolute.apkg': await one('/etc/evil.txt'),
    'malicious-backslash.apkg': await one(String.raw`..\evil.txt`),
    'malicious-drive-letter.apkg': await one('C:/evil.txt'),
    'malicious-too-many-files.apkg': await withCollection(manyFiles),
    // 4 MiB of zeros deflates to ~4 KiB; the headers claim 100 bytes.
    'malicious-zip-bomb.apkg': await withCollection([
      { name: '0', data: new Uint8Array(4 * 1024 * 1024), deflate: true, declaredSize: 100 },
    ]),
    // ~250 MiB from a few hundred bytes of zstd RLE blocks.
    'malicious-zstd-bomb.apkg': buildZip([
      { name: 'collection.anki2', data: await stubCollection(), deflate: true },
      { name: 'collection.anki21b', data: zstdRleBomb(120) },
      { name: 'meta', data: new Uint8Array(pbVarint(1, 3)) },
    ]),
    'not-anki.apkg': buildZip([{ name: 'readme.txt', data: enc.encode('not an Anki package') }]),
    'newer-format.apkg': buildZip([
      { name: 'collection.anki21b', data: zstdRaw(enc.encode('x')) },
      { name: 'meta', data: new Uint8Array(pbVarint(1, 9)) },
    ]),
  };
}

/** Builds every fixture; returns `{ fileName: bytes }` in a stable order. */
export async function buildAnkiFixtures() {
  return {
    'basic-reversed.apkg': await basicReversed(),
    'cloze.apkg': await cloze(),
    'japanese-furigana.apkg': await japaneseFurigana(),
    'media.apkg': await media(),
    'html-script.apkg': await htmlScript(),
    'review-history.apkg': await reviewHistory(),
    'anki21b.apkg': await anki21b(),
    'kana.apkg': await kana(),
    'suspended.apkg': await suspended(),
    'multi-media.apkg': await multiMedia(),
    ...(await malicious()),
  };
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const outDir =
    outIdx === -1 ? DEFAULT_FIXTURE_DIR : resolve(process.argv[outIdx + 1] ?? DEFAULT_FIXTURE_DIR);
  mkdirSync(outDir, { recursive: true });
  const fixtures = await buildAnkiFixtures();
  for (const [name, bytes] of Object.entries(fixtures)) {
    writeFileSync(join(outDir, name), bytes);
  }
  console.log(`Wrote ${Object.keys(fixtures).length} Anki fixtures to ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
