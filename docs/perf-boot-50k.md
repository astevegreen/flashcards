# Cold boot at 50k reviews (review P5)

Measured on 26 Nov 2026 to settle P5 (`docs/code-review-2026-11-25.md`): every persist wrote the materialized card cache (`cards_cache`), and nothing read it.

## Method

`packages/platform-web/bench/boot.perf.ts`, run with `pnpm bench` (it is not part of `pnpm test`). It builds 55,005 events: 5 decks, 5,000 cards, and 50,000 reviews (10 per card, a day apart). It stores them in `DexieStorage` on fake-indexeddb and times the two boots `apps/web/src/main.tsx` does:

- **Snapshot boot** (every launch after the first): `getLocalSnapshot`, `deserializeCollectionState`, then `getEventsAfterLocalSeq` and `applyEventsWithDiff` for the 200 events saved after the snapshot.
- **Full boot** (first launch, or after the snapshot was dropped): `getAllEvents`, then `applyEvents` on an empty state.

Each figure is the median of 7 rounds after a warm-up. Seven runs on an i7-12700K, Node 26. Other agents' test runs shared the machine, so runs 4 to 7 (on the final code) are noisier:

| Run        | Snapshot + 200-event delta | Full: `applyEvents` | Full: `getAllEvents` (fake-indexeddb) | Full: both |
| ---------- | -------------------------- | ------------------- | ------------------------------------- | ---------- |
| 1          | 114 ms                     | 121 ms              | 233 ms                                | 409 ms     |
| 2          | 116 ms                     | 124 ms              | 236 ms                                | 458 ms     |
| 3          | 125 ms                     | 131 ms              | 240 ms                                | 624 ms     |
| 4          | 205 ms                     | 461 ms              | 656 ms                                | 664 ms     |
| 5          | 150 ms                     | 194 ms              | 268 ms                                | 504 ms     |
| 6          | 149 ms                     | 143 ms              | 292 ms                                | 486 ms     |
| 7          | 410 ms                     | 141 ms              | 261 ms                                | 928 ms     |
| **Median** | **149 ms**                 | **141 ms**          | **261 ms**                            | **504 ms** |

Before the cache was removed, the same bench timed the cache itself (runs 1 to 3): writing all 5,000 rows took 37 to 39 ms, and reading them took 10 ms. The full-boot total swings because of garbage collection after reading 55k rows.

## Threshold and result

The threshold was under about 300 ms on this desktop. Phones run about 3 to 5 times slower, so that is roughly 1.5 s or less on a mid-range phone.

- **The snapshot boot passes: 149 ms median here** (114 to 150 ms in 6 of 7 runs), roughly 0.45 to 0.75 s on a phone.
- **Replay alone passes: 141 ms median.**
- **The no-snapshot boot fails: 504 ms median**, over the 300 ms bar. That is the first launch, or the first after a rebuild drops the snapshot. Most of its extra time is the storage read (261 ms), and fake-indexeddb is only a stand-in for a browser's IndexedDB. This is accepted: the cache could not have shortened it (next point), and every later launch takes the 149 ms snapshot boot.
- **Reading the cache at boot would not help.** It holds only card schedules, so a boot still needs the snapshot or a replay to rebuild notes, decks, review history and stats. The local snapshot already is the materialized state that blueprint §191 describes.

**Decision: stop writing the cache.** Each local edit and each sync pull no longer upserts card rows. A full boot or a sync hydrate no longer rewrites all 5,000 rows. On Capacitor the cache took one bridge call per row.

## Upgrade

- **Web (Dexie):** schema v4 empties `cards_cache` and keeps the store declared. A PWA tab still on an older build opens the v4 database anyway (Dexie retries without a version on a `VersionError`) and still writes there, so dropping the store would break that tab's persists. A later version can drop it with `cards_cache: null`.
- **Capacitor/Tauri (SQLite):** the schema now runs `DROP TABLE IF EXISTS cards_cache`, which drops its index too. An installed app can't run an older build against the same file.

No events, snapshots or settings are touched. The cache rows were derived from events.

## Not measured

- A real browser's IndexedDB, or a phone. The phone figures above are scaled estimates.
- Collections well past 50k reviews. Replay is linear in events, so 200k reviews would take about 0.5 s of replay on this desktop for a full boot only.
