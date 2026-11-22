# `sync/v1` store format

Devices sync by exchanging append-only event segments through storage the user owns: a Google Drive
`appDataFolder`, a Dropbox App Folder, a local or desktop-synced folder, or iCloud Drive. No server
is involved. Every transport exposes the same three operations (`list`, `read`, and a `write` that
can be create-only), so the layout below is identical everywhere.

## Layout

```
sync/v1/manifest.json
sync/v1/devices/<device-id>/head.json
sync/v1/devices/<device-id>/seg-000001.jsonl.gz
sync/v1/devices/<device-id>/seg-000002.jsonl.gz
sync/v1/snapshots/<device-id>-<seq>.json.gz
media/<aa>/<sha256>.<ext>
```

- **There are no write conflicts.** A device only ever writes inside its own `devices/<device-id>/`
  folder, and segments are write-once. A `device-id` matches `[A-Za-z0-9._-]{1,128}`.
- `<aa>` is the first two hex characters of the media hash.

## `manifest.json`

```json
{
  "collection_id": "…",
  "format_version": 1,
  "min_app_version": "0.2.0",
  "created_at": 1767225600000,
  "updated_at": 1767225600000
}
```

The first device to sync creates the manifest. `collection_id` binds a device to one collection.

**Compatibility gate:** a build must refuse to write when `format_version` is greater than the
highest version it supports, or when `min_app_version` is newer than the build itself. It can
still read, and it tells the user to update. Unknown event types and fields are kept and passed
through untouched.

## Segments (`seg-NNNNNN.jsonl.gz`)

A segment is gzip-compressed UTF-8 JSONL with one [event](./events.md) per line. Segment numbers
start at 1 and are zero-padded to six digits. A segment holds a contiguous range of that device's
`seq` numbers and is never modified after it's written.

## `head.json`

```json
{
  "device_id": "web-0193…",
  "last_segment": 12,
  "last_seq": 4810,
  "updated_at": 1767225600000,
  "segments": [{ "seg": 12, "from_seq": 4701, "to_seq": 4810, "count": 110 }]
}
```

Only the owning device writes its `head.json`.

## Push and pull

1. **Push:** write each new segment with create-only semantics (`write(path, bytes, { ifAbsent: true })`),
   and only then rewrite `head.json`. Segments are never overwritten. If a crash leaves a segment
   that `head.json` doesn't list, the next push either adopts it (when it holds exactly the same
   events) or moves on to the next segment number. Readers only trust segments listed in
   `head.json`.
2. **Pull:** list `devices/`, read each other device's `head.json`, and download only segments past
   the local watermark for that device. Events then replay deterministically (see
   [events.md](./events.md)), so every device converges to the same state whatever order segments
   arrive in.

## Snapshots

After 500 or more new events, a device may write
`snapshots/<device-id>-<seq>.json.gz`: gzip JSON holding `format_version`, `snapshot_version`
(currently 1), `collection_id`, `created_by`, `created_at`, `total_events`, `watermarks` (the last
seq included for each device) and the serialized `state`. A new device loads the newest compatible
snapshot, then replays only segments past its watermarks.

## Limits

Readers reject compressed objects over 10 MiB, decompressed objects over 25 MiB, and media blobs
over 10 MiB. Media extensions are restricted to `png jpg jpeg webp gif mp3 ogg wav m4a`, and every
blob is checked against its SHA-256 name after download.

## Size

A review event is about 100 bytes, which works out to roughly 2 MB gzipped per 100,000 reviews.
Reviews are never deleted.
