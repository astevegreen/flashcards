import type { AnkiCollectionPlan, AnkiSqlCell } from '@flash/core/anki-export';

/**
 * Writes `collection.anki2` for an `.apkg` export with `sql.js` (SQLite compiled to WASM, the
 * engine the Anki importer already uses). Core plans the schema and rows; this only runs them
 * in a fresh in-memory database and returns its bytes. The SQLite work runs in a short-lived Web
 * Worker (`apkg-writer.worker.ts`), so sql.js never reaches the main bundle and a large deck
 * doesn't block the UI. `writeAnkiCollection` takes the database as a parameter, so Node tests
 * drive the same code.
 */

interface SqlStatementLike {
  run(values?: AnkiSqlCell[]): void;
  free(): unknown;
}

export interface SqlWritableDatabaseLike {
  run(sql: string): unknown;
  prepare(sql: string): SqlStatementLike;
  export(): Uint8Array;
  close(): void;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Runs the plan's DDL, inserts every row in one transaction, and returns the database file. */
export function writeAnkiCollection(
  db: SqlWritableDatabaseLike,
  plan: AnkiCollectionPlan,
): Uint8Array {
  try {
    for (const statement of plan.schema) db.run(statement);
    db.run('BEGIN');
    for (const table of plan.tables) {
      if (table.rows.length === 0) continue;
      const columns = table.columns.map(quoteIdent).join(', ');
      const params = table.columns.map(() => '?').join(', ');
      const insert = db.prepare(
        `INSERT INTO ${quoteIdent(table.name)} (${columns}) VALUES (${params})`,
      );
      try {
        for (const row of table.rows) insert.run(row);
      } finally {
        insert.free();
      }
    }
    db.run('COMMIT');
    return db.export();
  } finally {
    db.close();
  }
}

/** Messages between `WebAnkiCollectionWriter` and `apkg-writer.worker.ts`. */
interface AnkiWriteRequest {
  type: 'write';
  plan: AnkiCollectionPlan;
}

export type AnkiWriteResponse =
  { type: 'done'; bytes: Uint8Array } | { type: 'error'; message: string };

/** Handles one write request; always posts exactly one `done` or `error`. */
export async function handleAnkiWriteRequest(
  data: unknown,
  openDatabase: () => Promise<SqlWritableDatabaseLike>,
  post: (msg: AnkiWriteResponse) => void,
): Promise<void> {
  const req = data as Partial<AnkiWriteRequest> | null;
  if (!req || req.type !== 'write' || !req.plan) {
    post({ type: 'error', message: 'Malformed Anki export request' });
    return;
  }
  try {
    post({ type: 'done', bytes: writeAnkiCollection(await openDatabase(), req.plan) });
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    post({ type: 'error', message: `Could not write the Anki package (${message}).` });
  }
}

/** Minimal Worker surface used here, so tests can pass a fake. */
export interface AnkiWriterWorkerLike {
  onmessage: ((ev: MessageEvent<AnkiWriteResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
  postMessage(message: AnkiWriteRequest): void;
  terminate(): void;
}

function createDefaultWorker(): AnkiWriterWorkerLike {
  return new Worker(new URL('./apkg-writer.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as AnkiWriterWorkerLike;
}

/** A write that hasn't answered after this long is given up (the worker is terminated). */
const ANKI_WRITE_TIMEOUT_MS = 5 * 60_000;

export interface WebAnkiCollectionWriterOptions {
  createWorker?: () => AnkiWriterWorkerLike;
  timeoutMs?: number;
}

/**
 * Writes each collection in its own Worker. The promise always settles: with the bytes, with the
 * worker's error, when the worker fails to load or its answer can't be read, or after
 * `timeoutMs`. The worker is terminated in every case.
 */
export class WebAnkiCollectionWriter {
  private readonly createWorker: () => AnkiWriterWorkerLike;
  private readonly timeoutMs: number;

  constructor(options: WebAnkiCollectionWriterOptions = {}) {
    this.createWorker = options.createWorker ?? createDefaultWorker;
    this.timeoutMs = options.timeoutMs ?? ANKI_WRITE_TIMEOUT_MS;
  }

  write(plan: AnkiCollectionPlan): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      let worker: AnkiWriterWorkerLike;
      try {
        worker = this.createWorker();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => reject(new Error('Writing the Anki package took too long and was stopped.')));
      }, this.timeoutMs);
      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === 'done') settle(() => resolve(msg.bytes));
        else settle(() => reject(new Error(msg.message)));
      };
      worker.onerror = (ev) => {
        settle(() => reject(new Error(ev.message || 'The Anki export worker failed to load')));
      };
      worker.onmessageerror = () => {
        settle(() => reject(new Error('The Anki export worker sent an unreadable answer.')));
      };
      try {
        worker.postMessage({ type: 'write', plan });
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  }
}
