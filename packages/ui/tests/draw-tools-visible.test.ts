import { describe, expect, it } from 'vitest';
import { drawToolsVisible } from '../src/drawing/useDrawScripts.ts';

describe('drawToolsVisible', () => {
  it('follows the active languages by default', () => {
    expect(drawToolsVisible(true, false)).toBe(true);
    expect(drawToolsVisible(false, false)).toBe(false);
  });

  it('honours an explicit request to open the draw pad with no CJK language active', () => {
    expect(drawToolsVisible(false, true)).toBe(true);
  });
});
