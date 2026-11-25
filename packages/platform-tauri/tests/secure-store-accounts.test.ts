import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function tsSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsSources(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : [],
  );
}

/**
 * N1: the Rust keychain commands refuse any account not in `ALLOWED_ACCOUNTS`, so a refresh-token
 * store the TS side wires up but Rust doesn't list fails right after the user approves sign-in.
 */
describe('secure-store account allowlist', () => {
  it('lists every keychain account the desktop boot code uses', () => {
    const rust = readFileSync(join(root, 'apps/desktop/src-tauri/src/secure_store.rs'), 'utf8');
    const list = /const ALLOWED_ACCOUNTS: &\[&str\] = &\[([^\]]*)\]/.exec(rust)?.[1];
    expect(list).toBeDefined();
    const allowed = new Set([...(list ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]));

    const used = new Set<string>();
    for (const file of tsSources(join(root, 'packages/platform-tauri/src'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/account: '([a-z-]+-refresh-token)'/g)) {
        used.add(m[1] as string);
      }
    }
    expect(used.size).toBeGreaterThanOrEqual(3);
    expect([...used].filter((a) => !allowed.has(a))).toEqual([]);
  });
});
