import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THIRD_PARTY_NOTICES, formatThirdPartyNotice } from '../src/packs/third-party-notices.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8').replaceAll('\r\n', '\n');

describe('third-party notices', () => {
  it('ships every notice verbatim in apps/web/public/THIRD-PARTY-NOTICES.txt', () => {
    const shipped = read('apps/web/public/THIRD-PARTY-NOTICES.txt');
    for (const notice of THIRD_PARTY_NOTICES) {
      expect(shipped).toContain(formatThirdPartyNotice(notice));
    }
  });

  it('matches the fsrs-browser LICENSE and version that are installed', () => {
    const notice = THIRD_PARTY_NOTICES.find((n) => n.id === 'fsrs-browser');
    expect(notice).toBeDefined();
    const pkgDir = 'packages/platform-web/node_modules/fsrs-browser/';
    const pkg = JSON.parse(read(`${pkgDir}package.json`)) as { version: string; license: string };
    expect(notice?.version).toBe(pkg.version);
    expect(notice?.licenseName).toBe(pkg.license);
    const license = read(`${pkgDir}LICENSE`).trim();
    expect(license).toBe([notice?.copyright, ...(notice?.paragraphs ?? [])].join('\n\n'));
  });
});
