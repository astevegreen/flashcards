import { describe, expect, it } from 'vitest';
import { planAnkiApkgExport } from '../src/export/anki/index.ts';
import { createEventFactory, replayAllEvents } from '../src/events/replay.ts';
import type { EventPayloadMap, KnownEvent, KnownEventType } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';

const T0 = Date.UTC(2026, 10, 27, 9, 0, 0);

interface AnkiModelJson {
  id: number;
  name: string;
  tmpls: Array<{ qfmt: string; afmt: string }>;
}

/** Sentence decks in the given languages, one note each (the built-in Sentence note type). */
function sentenceDecks(languages: readonly string[]) {
  const f = createEventFactory('dev-tts', 0, createHlcState('dev-tts', T0));
  const ev: KnownEvent[] = [];
  let t = T0;
  const push = <K extends KnownEventType>(type: K, payload: EventPayloadMap[K]) => {
    t += 1000;
    ev.push(f.create(type, payload, t));
  };
  languages.forEach((language, i) => {
    push('DeckCreated', {
      deck_id: `deck-${language}`,
      name: `Sentences ${language}`,
      note_type_id: BUILTIN_NOTE_TYPE_IDS.SENTENCE,
      language,
    });
    push('NoteUpserted', {
      note_id: `note-${language}`,
      deck_id: `deck-${language}`,
      source_key: `s${i}`,
      created_order: i,
      fields: { sentence: `sentence ${language}`, translation: 'translation' },
    });
  });
  return replayAllEvents(ev);
}

function plan(languages: readonly string[], exportDecks = languages) {
  const p = planAnkiApkgExport(sentenceDecks(languages), {
    nowMs: T0 + 60_000,
    deckIds: exportDecks.map((l) => `deck-${l}`),
  });
  const table = (name: string) => p.collection.tables.find((x) => x.name === name);
  const col = table('col')?.rows[0] ?? [];
  const models = Object.values(JSON.parse(String(col[9]))) as AnkiModelJson[];
  const decks = JSON.parse(String(col[10])) as Record<string, { name: string }>;
  const notes = table('notes')?.rows ?? [];
  const cards = table('cards')?.rows ?? [];
  /** The model of the note in `language`'s deck, and the deck name of its cards. */
  const forDeck = (language: string) => {
    const note = notes.find((n) => String(n[6]).startsWith(`sentence ${language}`));
    const model = models.find((m) => m.id === note?.[2]);
    const deckNames = cards.filter((c) => c[1] === note?.[0]).map((c) => decks[String(c[2])]?.name);
    return { model, deckNames };
  };
  return { p, models, forDeck };
}

const ttsLangs = (model: AnkiModelJson | undefined) =>
  [...JSON.stringify(model?.tmpls ?? []).matchAll(/\{\{tts ([a-zA-Z_]+):/g)].map((m) => m[1]);

describe('.apkg export: {{tts}} language of a shared built-in note type (C8)', () => {
  it('gives each language its own Anki note type, so every deck speaks its own language', () => {
    const { models, forDeck } = plan(['ko', 'ja']);
    expect(models).toHaveLength(2);
    const ko = forDeck('ko');
    const ja = forDeck('ja');
    expect(ko.model?.name).toBe('Sentence (ko)');
    expect(ja.model?.name).toBe('Sentence (ja)');
    expect(ko.model?.id).not.toBe(ja.model?.id);
    expect(ttsLangs(ko.model).length).toBeGreaterThan(0);
    expect(new Set(ttsLangs(ko.model))).toEqual(new Set(['ko_KR']));
    expect(new Set(ttsLangs(ja.model))).toEqual(new Set(['ja_JP']));
    expect(new Set(ko.deckNames)).toEqual(new Set(['Sentences ko']));
    expect(new Set(ja.deckNames)).toEqual(new Set(['Sentences ja']));
  });

  it('is the same whichever deck comes first', () => {
    // Deck order follows names; ids depend only on note type and language.
    const a = plan(['ko', 'ja']);
    const b = plan(['ja', 'ko']);
    expect(a.forDeck('ko').model?.id).toBe(b.forDeck('ko').model?.id);
    expect(new Set(ttsLangs(b.forDeck('ja').model))).toEqual(new Set(['ja_JP']));
  });

  it('warns once about a cloze layout mixed with others, however many languages share it', () => {
    const f = createEventFactory('dev-cloze', 0, createHlcState('dev-cloze', T0));
    const ev: KnownEvent[] = [];
    let t = T0;
    const push = <K extends KnownEventType>(type: K, payload: EventPayloadMap[K]) => {
      t += 1000;
      ev.push(f.create(type, payload, t));
    };
    // A flip layout next to the built-in cloze one, so each Anki variant drops it and warns.
    push('LayoutChanged', {
      layout: {
        id: 'layout-cloze-flip',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.CLOZE,
        name: 'Flip',
        front_fields: ['text'],
        reveal_steps: [['meaning']],
        answer_mode: 'flip',
        hide_furigana_on_front: false,
        enabled: true,
      },
    });
    for (const language of ['ko', 'ja']) {
      push('DeckCreated', {
        deck_id: `cloze-${language}`,
        name: `Cloze ${language}`,
        note_type_id: BUILTIN_NOTE_TYPE_IDS.CLOZE,
        language,
      });
    }
    const p = planAnkiApkgExport(replayAllEvents(ev), {
      nowMs: T0 + 60_000,
      deckIds: ['cloze-ko', 'cloze-ja'],
    });
    const col = p.collection.tables.find((x) => x.name === 'col')?.rows[0] ?? [];
    expect(Object.keys(JSON.parse(String(col[9])))).toHaveLength(2);
    expect(p.warnings.filter((w) => w.includes('has a cloze layout, so'))).toHaveLength(1);
  });

  it('keeps one note type, with its own id and name, for one language', () => {
    const one = plan(['ko', 'ja'], ['ko']);
    expect(one.models).toHaveLength(1);
    expect(one.models[0]?.name).toBe('Sentence');
    expect(new Set(ttsLangs(one.models[0]))).toEqual(new Set(['ko_KR']));
    // A collection with only the Korean deck gets the same id, as before this change.
    const same = planAnkiApkgExport(sentenceDecks(['ko']), { nowMs: T0 + 60_000 });
    const col = same.collection.tables.find((x) => x.name === 'col')?.rows[0] ?? [];
    const ids = Object.keys(JSON.parse(String(col[9])));
    expect(ids).toEqual([String(one.models[0]?.id)]);
  });
});
