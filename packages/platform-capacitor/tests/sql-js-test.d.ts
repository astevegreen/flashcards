/**
 * The extra sql.js calls `sqlite-backups.test.ts` makes, merged into the production slice in
 * `platform-web/src/anki/sqljs-assets.d.ts` (sql.js ships no types).
 */
declare module 'sql.js' {
  type SqlJsValue = string | number | Uint8Array | null;
  interface SqlJsDatabase {
    run(sql: string, params?: SqlJsValue[]): SqlJsDatabase;
  }
  interface SqlJsStatement {
    bind(values?: SqlJsValue[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlJsValue>;
  }
}
