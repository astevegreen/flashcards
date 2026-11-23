# `.flashpkg` package format (format_version 1)

A `.flashpkg` is a standard zip archive. It carries decks, lesson pages, courses and media between
devices, people and tools. The same format is used for sharing a single deck, sharing a single page
or course, AI-generated content and full-collection backups.

## Layout

```
manifest.json            required  package identity and deck list
note_types.json          required  note types used by the decks (may be [])
layouts.json             required  card layouts for those note types (may be [])
decks/<name>.jsonl       per deck  one note per line
pages/<slug>.md          optional  lesson pages (Markdown with front matter)
courses.json             optional  ordered page/deck courses
media/<sha256>.<ext>     optional  images and audio, named by content hash
```

## Files

### `manifest.json` ([schema](./schemas/manifest.schema.json))

```json
{
  "package_id": "pkg:sample-ko-vocab",
  "name": "Korean Core + Hanja",
  "version": "1.0.0",
  "format_version": 1,
  "author": "optional",
  "license": "optional",
  "languages": ["ko"],
  "decks": [
    {
      "id": "…",
      "name": "Korean Core + Hanja",
      "file": "decks/korean-core-hanja-1.jsonl",
      "note_type_id": "nt:vocab-ko",
      "language": "ko"
    }
  ]
}
```

- `package_id` identifies the package across versions. Re-importing a newer `version` of the same
  `package_id` updates the existing decks in place.
- `format_version` must be `1`. Importers reject unknown versions.
- `subset` (optional, `true`) marks a package that holds only part of its decks' notes, such as
  one exported category. Its decks keep their real ids so re-importing updates the same notes,
  but importers never archive a deck's other notes for it (not even for watched folders or
  package URLs) and never relink the existing deck's source or rename it.
- `decks[].description` (optional) is the deck's plain-text description. Import fills it only for
  a deck that never had a description event.
- `presets` and `folders` (optional) hold the shared option presets
  (`{ id, name, settings: { new_cards_per_day, max_reviews_per_day, target_retention }, w? }`)
  and deck folders (`{ id, name }`) the exported decks use; `decks[].preset_id` and
  `decks[].folder_id` point at them. Import never overwrites what the user has: it uses a live
  preset or folder with the same id, else one with the same name, else none when that id was
  deleted in this collection, else creates one with the package's id and values. New decks join
  it; existing decks join only when they never had a preset (or folder) assignment. Older
  packages without these fields stay valid, and older builds ignore them.

### `decks/<name>.jsonl` ([schema](./schemas/note_record.schema.json))

UTF-8, one JSON object per line:

```json
{
  "id": "ko-1",
  "fields": { "word": "학교 (學校[학교])", "meaning": "school" },
  "tags": ["topik-1"],
  "provenance": { "source": "user", "reviewed": true }
}
```

- `id` is the note's stable package ID, which is the same as a Sheet's `Card ID`. On import the
  note ID is `uuidv5(deck_id, id)`, so upgrades match notes by `id` and keep their review history.
  Notes that disappear from a newer version are archived, not deleted.
- `fields` keys are the note type's field `key`s. Field values may use the ruby syntax
  (`漢字[かんじ]`, `{base|reading}`), cloze (`{{c1::…}}`) and `media:<sha256>` references.
- `provenance.source` is `user`, `import` or `ai`. AI notes with `reviewed: false` show a
  "Needs review" badge.

### `note_types.json` and `layouts.json`

These are arrays of note types ([schema](./schemas/note_type.schema.json)) and layouts
([schema](./schemas/layout.schema.json)). A layout picks the front fields, the reveal steps, the
answer mode (`flip`, `typed`, `choice`, `cloze`, `listen`, `draw`), what to speak and whether
furigana is hidden on the front.

### `pages/<slug>.md` ([front-matter schema](./schemas/page_frontmatter.schema.json))

```markdown
---
id: '…'
slug: 'ja-particles-wa-ga'
title: 'Japanese Particles: は vs が'
lang: 'ja'
tags: ['grammar']
---

CommonMark + GFM tables + directives (::say, :::example, :::note, ::image, ::cards, ::deck-link).
```

Raw HTML is never rendered. Pages are treated as untrusted input.

### `courses.json` ([schema](./schemas/course.schema.json))

This is an array of courses. Each one is an ordered list of
`{ kind: "page" | "deck", ref_id, unlocks_after_page_id? }` items. On import, references are
remapped to the IDs the importer assigned.

### `media/<sha256>.<ext>`

The file name is the lowercase hex SHA-256 of the bytes. Allowed extensions are `png`, `jpg`,
`jpeg`, `webp`, `gif`, `mp3`, `ogg`, `wav` and `m4a`.

## Export scopes

| Export     | Contains                                                                |
| ---------- | ----------------------------------------------------------------------- |
| Deck       | That deck, its note type and layouts, and the media its notes reference |
| Page       | That page and the media it references (no decks)                        |
| Course     | The course, every deck and page it lists, and their media               |
| Collection | Everything that isn't archived                                          |

## Import safety limits

Importers must enforce these limits while extracting, not just from the zip headers:

- No absolute paths, `..` segments, backslashes or NUL in entry names
- At most 10,000 files and 100 MB uncompressed in total. Per-file caps are enforced while
  inflating, so spoofed size headers can't zip-bomb the importer.
- JSON files must pass their schema. Failures report `{ path, code, message }` for each issue.

## Catalogs

Static catalogs let a site list packages for one-tap install:

- `index.json` (Family Library / Starter Decks): [family_catalog.schema.json](./schemas/family_catalog.schema.json)
- `packs.json` (offline dictionary and stroke packs): [pack_catalog.schema.json](./schemas/pack_catalog.schema.json), described in [packs.md](./packs.md)

Host catalogs with CORS enabled. Cloudflare Pages or GitHub Pages plus an `_headers` file both
work.
