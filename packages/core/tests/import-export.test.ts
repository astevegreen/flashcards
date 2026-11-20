import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { applyEvents, createEventFactory, replayAllEvents } from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, encodeUtf8 } from '../src/ids.ts';
import { buildEventsFromCsv, parseDelimitedText } from '../src/import/csv.ts';
import {
  exportFlashpkg,
  FlashpkgSecurityError,
  FlashpkgValidationError,
  importFlashpkg,
} from '../src/import/flashpkg.ts';
import { BUILTIN_NOTE_TYPES } from '../src/model/presets.ts';

describe('CSV / TSV Importer', () => {
  const koNoteType = BUILTIN_NOTE_TYPES.find((nt) => nt.id === 'preset:vocab-ko');
  if (!koNoteType) throw new Error('Missing preset:vocab-ko');

  it('handles UTF-8 BOM, quoted commas/newlines, escaped quotes, and trailing empty rows', () => {
    const raw =
      '\uFEFFWord,Meaning,Notes,Tags\r\n' +
      '"사과, 배","apple, pear","Line 1\n""quoted"" line 2","fruit;food"\r\n' +
      '학교,school,,daily\r\n' +
      ',,,\r\n\r\n';

    const parsed = parseDelimitedText(raw);
    expect(parsed.delimiter).toBe(',');
    expect(parsed.headers).toEqual(['Word', 'Meaning', 'Notes', 'Tags']);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual([
      '사과, 배',
      'apple, pear',
      'Line 1\n"quoted" line 2',
      'fruit;food',
    ]);
  });

  it('auto-detects TSV and supports Flashcards Deluxe Text 1..3 + Category 1..2 headers', () => {
    const tsv =
      'Text 1\tText 2\tText 3\tCategory 1\tCategory 2\n학교\t學校\tschool\ttopik-1\tplaces\n';
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', 1000));
    const res = buildEventsFromCsv(tsv, {
      deckId: 'deck-fd',
      noteType: koNoteType,
      eventFactory: factory,
      nowMs: 1000,
    });

    expect(res.importedCount).toBe(1);
    expect(res.warnings).toHaveLength(0);
    const state = replayAllEvents([
      factory.create(
        'DeckCreated',
        {
          deck_id: 'deck-fd',
          name: 'FD Import',
          note_type_id: koNoteType.id,
          language: 'ko',
        },
        900,
      ),
      ...res.events,
    ]);
    const note = [...state.notes.values()][0];
    expect(note).toBeDefined();
    expect(note?.fields).toEqual({ word: '학교', hanja: '學校', meaning: 'school' });
    expect(note?.tags).toEqual(['topik-1', 'places']);
  });

  it('warns on unknown headers, duplicate headers, and duplicate Card IDs', () => {
    const csv =
      'Word,Word,Meaning,MysteryCol,Card ID\n' +
      '하나,dup,one,ignored,id-1\n' +
      '둘,dup2,two,ignored,id-1\n';
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', 2000));
    const res = buildEventsFromCsv(csv, {
      deckId: 'deck-warn',
      noteType: koNoteType,
      eventFactory: factory,
      nowMs: 2000,
    });

    expect(res.importedCount).toBe(2);
    const codes = res.warnings.map((w) => w.code);
    expect(codes).toContain('duplicate_header');
    expect(codes).toContain('unknown_header');
    expect(codes).toContain('duplicate_card_id');
  });
});

describe('.flashpkg Export, Import, Upgrade Preservation & Security (§3.4, §13)', () => {
  it('round-trips a collection and preserves review history when upgrading a package', () => {
    const t0 = Date.UTC(2026, 1, 1, 10, 0, 0);
    const factoryA = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const deckId = 'deck-ko-pkg';

    const stateA = replayAllEvents([
      factoryA.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Korean Travel',
          note_type_id: 'preset:vocab-ko',
          language: 'ko',
        },
        t0,
      ),
      factoryA.create(
        'NoteUpserted',
        {
          note_id: 'note-1',
          deck_id: deckId,
          source_key: 'travel-001',
          fields: { word: '공항', meaning: 'airport' },
          tags: ['travel'],
        },
        t0,
      ),
    ]);

    const pkgV1 = exportFlashpkg(stateA, {
      packageId: 'pkg:korean-travel',
      name: 'Korean Travel Pack',
      version: '1.0.0',
    });

    // Import into Device B
    const factoryB = createEventFactory('dev-b', 0, createHlcState('dev-b', t0 + 1000));
    const stateB = replayAllEvents([]);
    const imp1 = importFlashpkg(pkgV1, stateB, factoryB, { nowMs: t0 + 1000 });
    applyEvents(stateB, imp1.events);

    expect(imp1.decksImported).toBe(1);
    expect(imp1.notesImported).toBe(1);
    expect(imp1.upgradedDecks).toBe(0);

    const importedNote = [...stateB.notes.values()][0];
    expect(importedNote).toBeDefined();
    if (!importedNote) throw new Error('Expected imported note');
    const cardId = deriveCardId(importedNote.id, 'layout:vocab-ko:recognition', 0);

    // Record a review on Device B
    applyEvents(stateB, [
      factoryB.create(
        'ReviewRecorded',
        {
          review_id: 'rev-keep',
          card_id: cardId,
          rating: 4,
          reviewed_at: t0 + 5000,
          tz_offset: 0,
          duration_ms: 900,
          answer_mode: 'flip',
          fsrs_params_version: 0,
          resulting_due_at: t0 + 5 * 86_400_000,
        },
        t0 + 5000,
      ),
    ]);
    const cardBeforeUpgrade = stateB.cards.get(cardId);
    if (!cardBeforeUpgrade) throw new Error('Expected card before upgrade');
    const scheduleBeforeUpgrade = structuredClone(cardBeforeUpgrade.schedule);
    expect(scheduleBeforeUpgrade.reps).toBe(1);

    // Author updates note text on Device A and exports v2.0.0 of same package_id
    applyEvents(stateA, [
      factoryA.create(
        'NoteUpserted',
        {
          note_id: 'note-1',
          deck_id: deckId,
          source_key: 'travel-001',
          fields: { word: '공항', meaning: 'airport (international)' },
          tags: ['travel', 'v2'],
        },
        t0 + 10_000,
      ),
    ]);
    const pkgV2 = exportFlashpkg(stateA, {
      packageId: 'pkg:korean-travel',
      name: 'Korean Travel Pack',
      version: '2.0.0',
    });

    // Re-import v2 onto Device B -> content updates, review history preserved!
    const imp2 = importFlashpkg(pkgV2, stateB, factoryB, { nowMs: t0 + 20_000 });
    applyEvents(stateB, imp2.events);

    expect(imp2.upgradedDecks).toBe(1);
    expect(stateB.notes.get(importedNote.id)?.fields['meaning']).toBe('airport (international)');
    expect(stateB.cards.get(cardId)?.schedule).toEqual(scheduleBeforeUpgrade);
  });

  it('rejects zip path-traversal attacks (§13)', () => {
    const evilZip = zipSync({
      '../escape.json': encodeUtf8('{}'),
      'manifest.json': encodeUtf8(
        JSON.stringify({
          package_id: 'evil',
          name: 'Evil',
          version: '1.0.0',
          format_version: 1,
          languages: [],
          decks: [],
        }),
      ),
    });

    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', 1000));
    expect(() => importFlashpkg(evilZip, replayAllEvents([]), factory)).toThrow(
      FlashpkgSecurityError,
    );
  });

  it('rejects zip bombs exceeding uncompressed byte limits even when zip headers spoof originalSize=0 (§13)', () => {
    // 200 KB of zeroes compresses to < 1 KB, tested against a tight 50 KB uncompressed cap
    const bigPayload = new Uint8Array(200_000);
    const bombZip = zipSync({
      'manifest.json': encodeUtf8('{}'),
      'decks/huge.jsonl': bigPayload,
    });

    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', 1000));
    expect(() =>
      importFlashpkg(bombZip, replayAllEvents([]), factory, {
        limits: { maxTotalUncompressedBytes: 50_000, maxSingleFileBytes: 50_000 },
      }),
    ).toThrow(FlashpkgSecurityError);

    // Now spoof uncompressed size fields in local & central directory headers to 0
    const spoofed = new Uint8Array(bombZip);
    const view = new DataView(spoofed.buffer);
    for (let i = 0; i <= spoofed.length - 4; i++) {
      const sig = view.getUint32(i, true);
      if (sig === 0x04034b50 && i + 26 <= spoofed.length) {
        // Local file header: uncompressed size at offset +22
        view.setUint32(i + 22, 0, true);
      } else if (sig === 0x02014b50 && i + 28 <= spoofed.length) {
        // Central directory header: uncompressed size at offset +24
        view.setUint32(i + 24, 0, true);
      }
    }

    expect(() =>
      importFlashpkg(spoofed, replayAllEvents([]), factory, {
        limits: { maxTotalUncompressedBytes: 50_000, maxSingleFileBytes: 50_000 },
      }),
    ).toThrow(FlashpkgSecurityError);
  });

  it('rejects invalid manifest.json with structured FlashpkgValidationError', () => {
    const badZip = zipSync({
      'manifest.json': encodeUtf8(JSON.stringify({ format_version: 999 })),
    });
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', 1000));
    expect(() => importFlashpkg(badZip, replayAllEvents([]), factory)).toThrow(
      FlashpkgValidationError,
    );
  });
});
