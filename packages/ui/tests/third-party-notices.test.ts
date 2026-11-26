import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THIRD_PARTY_NOTICES, type ThirdPartyNotice } from '../src/packs/third-party-notices.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8').replaceAll('\r\n', '\n');

/** Plain-text rendering, as it appears in THIRD-PARTY-NOTICES.txt. */
function formatThirdPartyNotice(notice: ThirdPartyNotice): string {
  return [
    `${notice.name} ${notice.version}: ${notice.licenseName}`,
    `Source: ${notice.sourceUrl}`,
    '',
    notice.copyright,
    '',
    notice.paragraphs.join('\n\n'),
  ].join('\n');
}

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
  it.each([
    ['sql.js', 'packages/platform-web'],
    ['fzstd', 'packages/platform-web'],
    ['uqr', 'packages/ui'],
  ])('matches the %s MIT LICENSE and version that are installed', (id, workspace) => {
    const notice = THIRD_PARTY_NOTICES.find((n) => n.id === id);
    expect(notice).toBeDefined();
    const pkgDir = `${workspace}/node_modules/${id}/`;
    const pkg = JSON.parse(read(`${pkgDir}package.json`)) as { version: string; license: string };
    expect(notice?.version).toBe(pkg.version);
    expect(notice?.licenseName).toBe(pkg.license);
    // Upstream wraps lines and uses straight quotes; compare the words.
    const words = (text: string) => text.replaceAll(/["“”]/g, '"').split(/\s+/).filter(Boolean);
    const license = words(read(`${pkgDir}LICENSE`)).join(' ');
    expect(license).toContain(words(notice?.copyright ?? '').join(' '));
    for (const paragraph of notice?.paragraphs ?? []) {
      expect(license).toContain(words(paragraph).join(' '));
    }
  });
});
