/** Vite `?url` import of the bundled sql.js WASM binary (served from 'self', never a CDN). */
declare module 'sql.js/dist/sql-wasm-browser.wasm?url' {
  const url: string;
  export default url;
}

/**
 * The slice of the sql.js API the Anki reader (read-only queries on an in-memory copy) and the
 * `.apkg` writer (DDL, prepared inserts, `export`) use.
 */
declare module 'sql.js' {
  export interface SqlJsQueryResult {
    columns: string[];
    values: Array<Array<string | number | Uint8Array | null>>;
  }
  export interface SqlJsStatement {
    run(values?: Array<string | number | Uint8Array | null>): void;
    free(): boolean;
  }
  export interface SqlJsDatabase {
    exec(sql: string): SqlJsQueryResult[];
    run(sql: string): SqlJsDatabase;
    prepare(sql: string): SqlJsStatement;
    export(): Uint8Array;
    close(): void;
  }
  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => SqlJsDatabase;
  }
  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string;
  }): Promise<SqlJsStatic>;
}
