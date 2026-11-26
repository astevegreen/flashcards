import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const filePaths = readFileSync(
  fileURLToPath(
    new URL('../../../apps/mobile/android/app/src/main/res/xml/file_paths.xml', import.meta.url),
  ),
  'utf8',
);

describe('Android FileProvider paths (S13)', () => {
  it('shares only the app cache (export files), never the external-storage root', () => {
    expect(filePaths).toMatch(/<cache-path\b/);
    for (const tag of ['external-path', 'external-files-path', 'root-path', 'files-path']) {
      expect(filePaths, tag).not.toContain(`<${tag}`);
    }
  });
});
