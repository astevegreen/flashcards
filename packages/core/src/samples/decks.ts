import type { EventFactory } from '../events/replay.ts';
import type { KnownEvent } from '../events/types.ts';
import { deriveNoteId, FLASH_NAMESPACE_UUID, uuidv5 } from '../ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../model/presets.ts';

interface SampleDeckSeed {
  slug: string;
  name: string;
  noteTypeId: string;
  language: string;
  notes: Array<{
    key: string;
    fields: Record<string, string>;
    tags: string[];
  }>;
}

const SAMPLE_DECK_SEEDS: readonly SampleDeckSeed[] = [
  {
    slug: 'sample-ko-vocab',
    name: 'Korean Core + Hanja',
    noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
    language: 'ko',
    notes: [
      {
        key: 'ko-1',
        fields: {
          word: '학교 (學校[학교])',
          hanja: '學[학] 배울 학 · 校[교] 학교 교',
          meaning: 'school',
          example: '매일 아침 학교에 가요.',
          notes: 'Common Hanja compound word.',
        },
        tags: ['topik-1', 'hanja', 'daily'],
      },
      {
        key: 'ko-2',
        fields: {
          word: '도서관 (圖書館[도서관])',
          hanja: '圖[도] · 書[서] · 館[관]',
          meaning: 'library',
          example: '도서관에서 한국어를 공부해요.',
          notes: '',
        },
        tags: ['topik-1', 'hanja', 'places'],
      },
      {
        key: 'ko-3',
        fields: {
          word: '약속 (約束[약속])',
          hanja: '約[약] 맺을 약 · 束[속] 묶을 속',
          meaning: 'promise; appointment',
          example: '친구와 저녁 약속이 있어요.',
          notes: '',
        },
        tags: ['topik-1', 'daily'],
      },
      {
        key: 'ko-4',
        fields: {
          word: '경험 (經驗[경험])',
          hanja: '經[경] 지날 경 · 驗[험] 시험 험',
          meaning: 'experience',
          example: '좋은 경험이었어요.',
          notes: '',
        },
        tags: ['topik-2', 'hanja'],
      },
    ],
  },
  {
    slug: 'sample-ja-vocab',
    name: 'Japanese Essentials (JA)',
    noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_JA,
    language: 'ja',
    notes: [
      {
        key: 'ja-1',
        fields: {
          word: '日本[にほん]',
          reading: 'にほん',
          meaning: 'Japan',
          example: '私[わたし]の日本[にほん]の友達[ともだち]です。',
          notes: 'Also read にっぽん (Nippon).',
        },
        tags: ['jlpt-n5', 'geography'],
      },
      {
        key: 'ja-2',
        fields: {
          word: '勉強[べんきょう]',
          reading: 'べんきょう',
          meaning: 'study',
          example: '毎日[まいにち]日本語[にほんご]を勉強[べんきょう]します。',
          notes: 'Suru verb (勉強する).',
        },
        tags: ['jlpt-n5', 'verbs'],
      },
      {
        key: 'ja-3',
        fields: {
          word: '{今日|きょう}',
          reading: 'きょう',
          meaning: 'today',
          example: '{今日|きょう}は天気[てんき]がいいですね。',
          notes: 'Jukujikun reading using explicit {base|reading} syntax.',
        },
        tags: ['jlpt-n5', 'time'],
      },
    ],
  },
  {
    slug: 'sample-zh-vocab',
    name: 'Mandarin Basics (ZH)',
    noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_ZH,
    language: 'zh-Hans',
    notes: [
      {
        key: 'zh-1',
        fields: {
          word: '学习',
          reading: 'xue2 xi2',
          meaning: 'to study; to learn',
          example: '我每天学习中文。',
          notes: 'Tone numbers auto-format to tone marks.',
        },
        tags: ['hsk-1', 'verbs'],
      },
      {
        key: 'zh-2',
        fields: {
          word: '旅行',
          reading: 'lv3 xing2',
          meaning: 'to travel; trip',
          example: '我喜欢去日本旅行。',
          notes: 'Tests `lv3` -> `lǚ` umlaut conversion.',
        },
        tags: ['hsk-2', 'travel'],
      },
      {
        key: 'zh-3',
        fields: {
          word: '朋友',
          reading: 'peng2 you5',
          meaning: 'friend',
          example: '他是我的好朋友。',
          notes: 'Neutral tone `you5`.',
        },
        tags: ['hsk-1', 'people'],
      },
    ],
  },
  {
    slug: 'sample-en-vocab',
    name: 'English Idioms (EN)',
    noteTypeId: BUILTIN_NOTE_TYPE_IDS.SENTENCE,
    language: 'en',
    notes: [
      {
        key: 'en-1',
        fields: {
          sentence: 'A penny for your thoughts [informal]',
          reading: 'idiom',
          translation: 'Used to ask someone what they are thinking about.',
          notes: 'Demonstrates that `word [informal]` is never parsed as ruby.',
        },
        tags: ['idioms', 'en'],
      },
      {
        key: 'en-2',
        fields: {
          sentence: 'Bite the bullet',
          reading: 'idiom',
          translation: 'Face a difficult or unpleasant situation with courage.',
          notes: '',
        },
        tags: ['idioms', 'en'],
      },
    ],
  },
];

/**
 * Fixed baseline epoch for dev-mode sample deck seeding so auto-seeds across
 * multiple simulated devices (`?device=a` / `?device=b`) never overwrite real
 * user edits via LWW regardless of tab boot order.
 */
export const SAMPLE_SEED_EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

/**
 * Generates deterministic seed events for the built-in sample decks (`ko`, `ja`, `zh-Hans`, `en`).
 */
export function buildSampleDeckEvents(
  eventFactory: EventFactory,
  nowMs: number = SAMPLE_SEED_EPOCH_MS,
): KnownEvent[] {
  const events: KnownEvent[] = [];

  for (const seed of SAMPLE_DECK_SEEDS) {
    const deckId = uuidv5(FLASH_NAMESPACE_UUID, seed.slug);
    events.push(
      eventFactory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: seed.name,
          note_type_id: seed.noteTypeId,
          language: seed.language,
          source: { kind: 'native' },
          created_at: nowMs,
        },
        nowMs,
      ),
    );

    for (let i = 0; i < seed.notes.length; i++) {
      const note = seed.notes[i];
      if (!note) continue;
      const noteId = deriveNoteId(deckId, note.key);
      events.push(
        eventFactory.create(
          'NoteUpserted',
          {
            note_id: noteId,
            deck_id: deckId,
            source_key: note.key,
            fields: note.fields,
            tags: note.tags,
            provenance: { source: 'user', reviewed: true },
            created_order: i,
          },
          nowMs,
        ),
      );
    }
  }

  return events;
}
