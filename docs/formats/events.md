# Event schema

Every change is an immutable event, and app state (card schedules, decks, statistics) is derived by
replaying them. Events are what [`sync/v1`](./sync-v1.md) segments carry. Types are defined in
`packages/core/src/events/types.ts`.

## Envelope

```json
{ "id": "0193…", "device": "web-0193…", "seq": 4810, "hlc": "0193a1b2c3d4-0000-web-0193…",
  "type": "ReviewRecorded", "v": 1, "payload": { … } }
```

| Field    | Meaning                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`     | UUIDv7                                                                                                                 |
| `device` | ID of the device that wrote the event                                                                                  |
| `seq`    | Per-device counter: gapless and strictly increasing                                                                    |
| `hlc`    | Hybrid logical clock: 12 hex digits of wall-clock ms, `-`, 4 hex counter digits, `-`, device ID. Compared as a string. |
| `type`   | Event type (below). Unknown types must be preserved, not dropped.                                                      |
| `v`      | Payload schema version                                                                                                 |

## Replay rules

- **Reviews:** a card's active reviews are the `ReviewRecorded` events not cancelled by a
  `ReviewUndone`, sorted by `(reviewed_at, hlc, review_id)`. Wall-clock time is never used on its
  own. Each review is applied with the FSRS parameters that were active at its time, unless a later
  `DeckFSRSParamsChanged` with `reschedule_existing: true` re-weights it.
- **Everything else** (note fields, tags, deck settings, layouts, note types, pages, courses,
  preferences): per-field last-write-wins, decided by `hlc`.
- **Derived IDs:** `note_id = uuidv5(deck_id, source_key)` and
  `card_id = uuidv5(note_id, "<layout_id>:<variant>")`, where `variant` is the cloze number or 0.
  Cards themselves are never stored as events.

## Types

| Type                            | Payload (abridged)                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReviewRecorded`                | `review_id, card_id, rating (1 Again · 2 Hard · 3 Good · 4 Easy), reviewed_at, tz_offset, duration_ms, answer_mode, typed_answer?, fsrs_params_version, resulting_due_at`                                             |
| `ReviewUndone`                  | `review_id`                                                                                                                                                                                                           |
| `DeckCreated`                   | `deck_id, name, note_type_id, language, settings?, source?, created_at?`                                                                                                                                              |
| `DeckSettingsChanged`           | `deck_id, name?, language?, archived?, settings?` (`new_cards_per_day`, `max_reviews_per_day`, `target_retention`, `new_card_order`, `enabled_layout_ids`, `day_start_hour`; `-1` means "use the collection default") |
| `DeckFSRSParamsChanged`         | `deck_id, params_version, effective_from, params, reschedule_existing?`                                                                                                                                               |
| `NoteUpserted`                  | `note_id, deck_id, source_key, fields, tags?, provenance?, created_order?`                                                                                                                                            |
| `NoteArchived` / `NoteRestored` | `note_id` (review history is kept)                                                                                                                                                                                    |
| `NoteTypeChanged`               | `note_type`                                                                                                                                                                                                           |
| `LayoutChanged`                 | `layout`                                                                                                                                                                                                              |
| `PageUpserted`                  | `page_id, slug, title, markdown, lang?, tags?, source?`                                                                                                                                                               |
| `PageRead`                      | `page_id, read_at`                                                                                                                                                                                                    |
| `CourseChanged`                 | `course` (`archived: true` deletes it from the course list)                                                                                                                                                           |
| `MediaAdded`                    | `media: { hash, ext, mime, size, tts_key?, tts_lang_key? }`                                                                                                                                                           |
| `SourceLinked`                  | `target_kind ('deck' \| 'page'), target_id, source`                                                                                                                                                                   |
| `PreferencesChanged`            | `preferences` (partial)                                                                                                                                                                                               |

Times are Unix milliseconds. `tz_offset` is minutes east of UTC (+540 for Korea).
