declare module 'node:fs' {
  export interface Dirent {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export interface Stats {
    size: number;
    mtimeMs: number;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: Uint8Array | string): void;
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function renameSync(oldPath: string, newPath: string): void;
  export function statSync(path: string): Stats;
  export function unlinkSync(path: string): void;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string, ext?: string): string;
  export function extname(p: string): string;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module 'node:process' {
  export const argv: string[];
  export const env: Record<string, string | undefined>;
  export const stdin: AsyncIterable<Uint8Array | string> & {
    setEncoding?(encoding: 'utf8'): void;
  };
  export const stdout: {
    write(chunk: string): boolean;
  };
  export const stderr: {
    write(chunk: string): boolean;
  };
  export function exit(code?: number): never;
  export function cwd(): string;
}

declare module 'node:readline' {
  export interface ReadlineInterface extends AsyncIterable<string> {
    close(): void;
  }
  export function createInterface(options: {
    input: unknown;
    crlfDelay?: number;
  }): ReadlineInterface;
}
