import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCsp, PRODUCTION_CSP, TAURI_CSP } from '../csp.ts';

const tauriConf = JSON.parse(
  readFileSync(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
) as { app: { security: { csp: string } } };

/** The sources that govern `directive`, falling back like browsers do. */
function effective(policy: Map<string, string[]>, directive: string): string[] {
  const fallbacks: Record<string, string[]> = {
    'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
    'frame-src': ['frame-src', 'child-src', 'default-src'],
  };
  for (const name of fallbacks[directive] ?? [directive, 'default-src']) {
    const sources = policy.get(name);
    if (sources) return sources;
  }
  return [];
}

describe.each([
  ['PWA meta tag / hosting header', PRODUCTION_CSP],
  ['Tauri shell', TAURI_CSP],
])('CSP for %s', (_name, csp) => {
  const policy = parseCsp(csp);

  it('lets Workers load from same-origin files and compile WASM', () => {
    expect(effective(policy, 'worker-src')).toEqual(["'self'"]);
    expect(policy.get('script-src')).toContain("'wasm-unsafe-eval'");
    // The optimizer Worker fetches its `.wasm` from the app's own origin.
    expect(effective(policy, 'connect-src')).toContain("'self'");
  });

  it('keeps the strict posture: no eval, no inline scripts, no script wildcards', () => {
    const script = policy.get('script-src') ?? [];
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script.filter((s) => s.includes('*') || s === 'https:' || s === 'data:')).toEqual([]);
    expect(effective(policy, 'worker-src')).not.toContain('blob:');
    expect(policy.get('object-src')).toEqual(["'none'"]);
  });

  it('pins the Google Picker frames without wildcards, and posts forms only to itself', () => {
    const frames = effective(policy, 'frame-src');
    expect(frames).toEqual(["'self'", 'https://docs.google.com', 'https://accounts.google.com']);
    expect(policy.get('form-action')).toEqual(["'self'"]);
  });
});

describe('CSP sources of truth', () => {
  it('tauri.conf.json carries the shared Tauri policy', () => {
    expect(tauriConf.app.security.csp).toBe(TAURI_CSP);
  });

  it('the hosting guide documents the exact production policy', () => {
    const guide = readFileSync(
      new URL('../../../docs/setup-gcp-cloudflare.md', import.meta.url),
      'utf8',
    );
    expect(guide).toContain(PRODUCTION_CSP);
  });
});
