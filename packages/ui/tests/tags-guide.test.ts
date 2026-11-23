import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readTagsGuideDismissed,
  storeTagsGuideDismissed,
  TAGS_GUIDE_DISMISSED_KEY,
} from '../src/browse/tagsGuide.ts';

function stubStorage(): Map<string, string> {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

afterEach(() => vi.unstubAllGlobals());

describe('tags guide dismissal (device-local)', () => {
  it('is not dismissed by default, and remembers a dismissal', () => {
    const data = stubStorage();
    expect(readTagsGuideDismissed()).toBe(false);
    storeTagsGuideDismissed(true);
    expect(data.get(TAGS_GUIDE_DISMISSED_KEY)).toBe('1');
    expect(readTagsGuideDismissed()).toBe(true);
    storeTagsGuideDismissed(false);
    expect(readTagsGuideDismissed()).toBe(false);
  });

  it('survives blocked storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readTagsGuideDismissed()).toBe(false);
    expect(() => storeTagsGuideDismissed(true)).not.toThrow();
  });
});
