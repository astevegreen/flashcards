# Offline dictionary and stroke packs

`packs.json` lists the downloadable packs ([pack_catalog.schema.json](./schemas/pack_catalog.schema.json)).
`scripts/build-packs.mjs` builds them (`--starter` for the dev/CI fixtures, `--full` for the real
upstream data). Each pack `url` points to one gzipped JSON file:

```json
{
  "manifest": { "format_version": 1, "id": "dict-krdict", "kind": "dictionary", "…": "…" },
  "entries": [{ "headword": "먹다", "readings": ["먹따"], "meanings": ["eat"], "senses": [] }]
}
```

Stroke packs hold a `characters` map instead of `entries`. The catalog `sha256` is the SHA-256 of
the uncompressed JSON, so HTTP content-encoding can't break it. Every file must stay under 25 MiB
gzipped (the Cloudflare Pages per-file limit).

## Sharded dictionary packs (`format_version: 2`)

A dictionary pack over 25 MiB gzipped is split by the **first syllable** of its headwords.
`--full` does this on its own. `--shard <pack-id>` forces it. `--max-file-size` and `--shard-size`
(default 2 MiB per shard) lower the limits for tests. The pack becomes:

- **An index** at the same `url` (`dict-krdict.json.gz`). Its manifest has `format_version: 2`
  and a `sharding` object ([dictionary_pack_sharding.schema.json](./schemas/dictionary_pack_sharding.schema.json)).
  Its `entries` are **stubs**: every entry in pack order, keeping all the fields search, ranking
  and browse use (headword, Hanja, pronunciation, conjugations, glosses, each sense's English
  equivalents, POS, level, topics). Definitions, examples and related-word links are left out.
- **Shards** `dict-krdict.s01.json.gz` … next to the index. Each shard covers the headwords whose
  first syllable falls in `from`–`to` (inclusive). `s00`, with no range, holds headwords that
  don't start with a Hangul syllable. Ranges are cut at initial-consonant (초성) boundaries where a
  shard would otherwise be too big, and inside one initial only when it alone is too big:

  ```json
  {
    "shard": { "format_version": 2, "pack_id": "dict-krdict", "version": "…", "key": "s03" },
    "indices": [12, 40, 41],
    "entries": [{ "headword": "먹다", "…": "full entry" }]
  }
  ```

  `indices` gives each entry's position in the index, so a full row replaces its stub row (same
  id). The index manifest records each shard's size and SHA-256. The catalog `sha256` covers the
  index, so every shard is verified through it.

The catalog entry for a sharded pack adds `shards: { scheme, count, compressed_bytes }`. Older
apps ignore that field and refuse the `format_version: 2` index with a clear error, so they never
install half a pack. Unsharded packs keep `format_version: 1` and load exactly as before.

### How the app uses a sharded pack

Installing downloads only the index, so every query works right away:

| Lookup                                     | Served by                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| Korean (incl. inflected forms), 초성, jamo | The stubs. The results share the query's first syllable, so their one shard loads |
| Romanization                               | Stubs. Hangul candidates route to their shards like Korean                        |
| English → Korean                           | Stubs (they keep every English equivalent). Top results' shards load              |
| Hanja → words                              | Stubs (they keep the Hanja spelling). Top results' shards load                    |
| Browse lists and counts                    | Stubs. Each page completes its first rows' shards                                 |

After each search or browse page the app completes the top 12 results, downloading at most 3
shards for them (`WebDictionaryService`). Other rows stay stubs (headword, glosses, POS, level)
until they're opened in the detail pane or added to a deck. Loaded shards stay on the device.
Offline, a missing shard just leaves stubs. Settings > Packs has **Download all for offline**.

Trade-offs: the index repeats the search fields of every entry, so it is the biggest single
download. On the starter sample it is about 60% of the full pack. The real KRDict has more
examples per sense, so the share should be smaller, but that hasn't been measured. The build
fails if the index itself goes over the file limit. An English query whose top results span
several initial consonants downloads up to 3 shards (≤ 6 MiB) on first use. "Load every shard"
was rejected for English and browse, because that is the whole pack.
