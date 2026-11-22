import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { handleAnkiReadRequest, type AnkiReadResponse } from './anki-reader-protocol.ts';
import { readApkg, type SqlDatabaseLike } from './apkg-reader.ts';
import { zstdDecompressCapped } from './zstd.ts';

/**
 * Phase 12 Anki import Web Worker: unzip (with caps), zstd (anki21b) and SQLite all run here,
 * off the main thread. `sql.js` (MIT, SQLite compiled to WASM) and `fzstd` are only imported by
 * this worker, so neither reaches the initial bundle; the `.wasm` is a bundled same-origin asset
 * (never a CDN) and is precached for offline use.
 */

interface WorkerScopeLike {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  postMessage(message: AnkiReadResponse): void;
}

const scope = self as unknown as WorkerScopeLike;

let sqlite: ReturnType<typeof initSqlJs> | null = null;

async function openDatabase(bytes: Uint8Array): Promise<SqlDatabaseLike> {
  sqlite ??= initSqlJs({ locateFile: () => sqlWasmUrl });
  const SQL = await sqlite;
  return new SQL.Database(bytes);
}

scope.onmessage = (ev) => {
  void handleAnkiReadRequest(
    ev.data,
    (bytes, options) =>
      readApkg(bytes, { openDatabase, zstdDecompress: zstdDecompressCapped }, options),
    (msg) => scope.postMessage(msg),
  );
};
