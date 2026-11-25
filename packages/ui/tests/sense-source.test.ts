import { describe, expect, it } from 'vitest';
import type { DictionarySenseSource } from '../../core/src/dictionary/types.ts';
import {
  SENSE_SOURCE_ATTRIBUTION,
  SENSE_SOURCE_CLASS,
  SENSE_SOURCE_LABEL,
} from '../src/dictionary/sense-source.ts';

const SOURCES: readonly DictionarySenseSource[] = ['krdict', 'urimalsam', 'kaikki', 'app'];

describe('per-sense source badges', () => {
  it('labels, attributes and colours every sense source', () => {
    expect(Object.keys(SENSE_SOURCE_LABEL).toSorted()).toEqual([...SOURCES].toSorted());
    for (const source of SOURCES) {
      expect(SENSE_SOURCE_LABEL[source]).not.toBe('');
      expect(SENSE_SOURCE_ATTRIBUTION[source]).not.toBe('');
      expect(SENSE_SOURCE_CLASS[source]).not.toBe('');
    }
  });

  it('gives the app’s own wording a badge and attribution distinct from dictionary sources', () => {
    expect(SENSE_SOURCE_LABEL.krdict).toBe('KRDict');
    expect(SENSE_SOURCE_LABEL.urimalsam).toBe('우리말샘');
    expect(SENSE_SOURCE_LABEL.kaikki).toBe('Wiktionary');
    expect(SENSE_SOURCE_LABEL.app).toBe('App');
    expect(SENSE_SOURCE_CLASS.app).not.toBe(SENSE_SOURCE_CLASS.krdict);
    expect(SENSE_SOURCE_ATTRIBUTION.krdict).toContain('CC BY-SA 2.0 KR');
    expect(SENSE_SOURCE_ATTRIBUTION.urimalsam).toContain('CC BY-SA 2.0 KR');
    expect(SENSE_SOURCE_ATTRIBUTION.kaikki).toContain('CC BY-SA 4.0');
    expect(SENSE_SOURCE_ATTRIBUTION.app).toMatch(/^Written for this app/);
    expect(SENSE_SOURCE_ATTRIBUTION.app).not.toContain('CC BY-SA');
  });
});
