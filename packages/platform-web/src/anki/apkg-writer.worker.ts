import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import {
  handleAnkiWriteRequest,
  type AnkiWriteResponse,
  type SqlWritableDatabaseLike,
} from './apkg-writer.ts';

/**
 * `.apkg` export Web Worker: writes `collection.anki2` with sql.js. Only this worker imports
 * sql.js for writing, so it never reaches the initial bundle; the `.wasm` is the same bundled
 * same-origin asset the import worker uses (never a CDN).
 */

interface WorkerScopeLike {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  postMessage(message: AnkiWriteResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScopeLike;

let sqlite: ReturnType<typeof initSqlJs> | null = null;

async function openDatabase(): Promise<SqlWritableDatabaseLike> {
  sqlite ??= initSqlJs({ locateFile: () => sqlWasmUrl });
  const SQL = await sqlite;
  return new SQL.Database();
}

scope.onmessage = (ev) => {
  void handleAnkiWriteRequest(ev.data, openDatabase, (msg) =>
    scope.postMessage(msg, msg.type === 'done' ? [msg.bytes.buffer as ArrayBuffer] : []),
  );
};
