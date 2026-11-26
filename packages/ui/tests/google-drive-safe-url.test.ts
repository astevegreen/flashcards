import { describe, expect, it } from 'vitest';
import { isSafeDriveUrl } from '../src/sources/GoogleDriveFileRows.tsx';

describe('isSafeDriveUrl (§11)', () => {
  it('accepts https Drive and Docs links', () => {
    expect(isSafeDriveUrl('https://drive.google.com/file/d/abc/view')).toBe(true);
    expect(isSafeDriveUrl('https://docs.google.com/spreadsheets/d/abc/edit')).toBe(true);
  });

  it('refuses everything else', () => {
    for (const uri of [
      undefined,
      '',
      'not a url',
      'http://drive.google.com/file/d/abc',
      'https://drive.google.com.evil.example/x',
      'https://evil.example/?u=https://drive.google.com/',
      'https://user@drive.google.com/x',
      'https://drive.google.com:8443/x',
      'javascript:alert(1)//https://docs.google.com/',
    ]) {
      expect(isSafeDriveUrl(uri)).toBe(false);
    }
  });
});
