/** Vite `?url` import of the bundled sql.js WASM binary (served from 'self', never a CDN). */
declare module 'sql.js/dist/sql-wasm-browser.wasm?url' {
  const url: string;
  export default url;
}

/** The slice of the sql.js API the Anki reader uses (read-only queries on an in-memory copy). */
declare module 'sql.js' {
  export interface SqlJsQueryResult {
    columns: string[];
    values: Array<Array<string | number | Uint8Array | null>>;
  }
  export interface SqlJsDatabase {
    exec(sql: string): SqlJsQueryResult[];
    close(): void;
  }
  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => SqlJsDatabase;
  }
  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string;
  }): Promise<SqlJsStatic>;
}
