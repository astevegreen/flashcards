import type { AnkiCollectionPlan, AnkiSqlCell } from '@flash/core/anki-export';

/**
 * Writes `collection.anki2` for an `.apkg` export with `sql.js` (SQLite compiled to WASM, the
 * engine the Anki importer already uses). Core plans the schema and rows; this only runs them
 * in a fresh in-memory database and returns its bytes. The SQLite work runs in a short-lived Web
 * Worker (`apkg-writer.worker.ts`), so sql.js never reaches the main bundle and a large deck
 * doesn't block the UI. `writeAnkiCollection` takes the database as a parameter, so Node tests
 * drive the same code.
 */

export interface SqlStatementLike {
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
export interface AnkiWriteRequest {
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
  postMessage(message: AnkiWriteRequest): void;
  terminate(): void;
}

function createDefaultWorker(): AnkiWriterWorkerLike {
  return new Worker(new URL('./apkg-writer.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as AnkiWriterWorkerLike;
}

/** Writes each collection in its own Worker, terminated once the write settles. */
export class WebAnkiCollectionWriter {
  private readonly createWorker: () => AnkiWriterWorkerLike;

  constructor(createWorker: () => AnkiWriterWorkerLike = createDefaultWorker) {
    this.createWorker = createWorker;
  }

  write(plan: AnkiCollectionPlan): Promise<Uint8Array> {
    const worker = this.createWorker();
    const finish = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    return new Promise<Uint8Array>((resolve, reject) => {
      worker.onmessage = (ev) => {
        finish();
        if (ev.data.type === 'done') resolve(ev.data.bytes);
        else reject(new Error(ev.data.message));
      };
      worker.onerror = (ev) => {
        finish();
        reject(new Error(ev.message || 'The Anki export worker failed to load'));
      };
      worker.postMessage({ type: 'write', plan });
    });
  }
}
