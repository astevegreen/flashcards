import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_CSP, PRODUCTION_HEADER_CSP } from '../csp.ts';

/**
 * Guards the committed Cloudflare Pages `_headers` file (docs/setup-gcp-cloudflare.md §6): its CSP
 * must be exactly `PRODUCTION_HEADER_CSP` (`PRODUCTION_CSP` plus `frame-ancestors 'none'`), `.wasm` must be served as
 * `application/wasm`, and the file must match the documented block and reach `dist/`.
 */

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), 'utf8').replaceAll('\r\n', '\n');

const HEADERS_FILE = read('../public/_headers');

/** Parses Cloudflare Pages `_headers`: unindented URL patterns, each followed by indented `Name: value` lines. */
function parseHeaders(text: string): Map<string, Map<string, string[]>> {
  const rules = new Map<string, Map<string, string[]>>();
  let current: Map<string, string[]> | undefined;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = new Map();
      rules.set(line.trim(), current);
      continue;
    }
    const colon = line.indexOf(':');
    if (current === undefined || colon < 0) throw new Error(`Unexpected _headers line: ${line}`);
    const name = line.slice(0, colon).trim().toLowerCase();
    current.set(name, [...(current.get(name) ?? []), line.slice(colon + 1).trim()]);
  }
  return rules;
}

describe('Cloudflare Pages _headers', () => {
  const rules = parseHeaders(HEADERS_FILE);

  it('sends exactly PRODUCTION_HEADER_CSP, once, on every response, with nosniff', () => {
    const all = rules.get('/*');
    expect(all?.get('content-security-policy')).toEqual([PRODUCTION_HEADER_CSP]);
    expect(all?.get('x-content-type-options')).toEqual(['nosniff']);
  });

  it('forbids framing (S3)', () => {
    const all = rules.get('/*');
    expect(PRODUCTION_HEADER_CSP).toBe(`${PRODUCTION_CSP} frame-ancestors 'none';`);
    expect(all?.get('x-frame-options')).toEqual(['DENY']);
  });

  it('serves WebAssembly as application/wasm', () => {
    expect(rules.get('/assets/*.wasm')?.get('content-type')).toEqual(['application/wasm']);
  });

  it('sends no other CSP and no cross-origin isolation headers', () => {
    expect([...rules.keys()]).toEqual(['/*', '/assets/*.wasm']);
    for (const headers of rules.values()) {
      expect(headers.has('cross-origin-embedder-policy')).toBe(false);
      expect(headers.has('cross-origin-opener-policy')).toBe(false);
    }
    expect(rules.get('/assets/*.wasm')?.has('content-security-policy')).toBe(false);
  });

  it('matches the block documented in docs/setup-gcp-cloudflare.md §6', () => {
    const guide = read('../../../docs/setup-gcp-cloudflare.md');
    const start = guide.indexOf('On **Cloudflare Pages**');
    expect(start).toBeGreaterThan(-1);
    const fence = guide.indexOf('```text\n', start) + '```text\n'.length;
    const block = guide.slice(fence, guide.indexOf('```', fence));
    expect(HEADERS_FILE).toBe(
      block.replace(
        "<the policy above, on one line> frame-ancestors 'none';",
        PRODUCTION_HEADER_CSP,
      ),
    );
  });

  it('is copied to dist/ by the build', () => {
    const viteConfig = read('../vite.config.ts');
    expect(viteConfig).not.toMatch(/publicDir:\s*false|copyPublicDir:\s*false/);
    const dist = new URL('../dist/_headers', import.meta.url);
    const distIndex = new URL('../dist/index.html', import.meta.url);
    // `pnpm build` output: absent on a clean checkout (CI runs unit tests before building). A local
    // `dist/` built before `_headers` last changed is stale, so it proves nothing either way.
    const source = new URL('../public/_headers', import.meta.url);
    if (existsSync(distIndex) && statSync(distIndex).mtimeMs >= statSync(source).mtimeMs) {
      expect(readFileSync(dist, 'utf8').replaceAll('\r\n', '\n')).toBe(HEADERS_FILE);
    }
  });
});
