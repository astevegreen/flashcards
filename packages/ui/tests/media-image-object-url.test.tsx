// @vitest-environment happy-dom
// MediaImage releases its object URL as soon as `src` stops being a media reference.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaImage } from '../src/components/MediaImage.tsx';
import {
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  must,
  type Mounted,
} from './helpers/app-harness.tsx';

const HASH = 'cd'.repeat(32);

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

describe('MediaImage object URLs', () => {
  it('revokes on a non-media src, reads again on return, and revokes on unmount', async () => {
    let n = 0;
    const create = vi.fn(() => `blob:test/${(n += 1)}`);
    const revoke = vi.fn();
    vi.spyOn(URL, 'createObjectURL').mockImplementation(create);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke);
    const storage = createMemoryStorage();
    storage.media.set(HASH, { hash: HASH, mime: 'image/png', bytes: new Uint8Array([1, 2]) });
    const q = (id: string) => must(mounted).container.querySelector(`[data-testid="${id}"]`);

    mounted = await mountWithApp(<MediaImage src={`media:${HASH}`} />, {
      platform: createTestPlatform(storage),
    });
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    expect(q('media-image')?.getAttribute('src')).toBe('blob:test/1');

    await must(mounted).rerender(<MediaImage src="javascript:alert(1)" />);
    await flush();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenLastCalledWith('blob:test/1');
    expect(q('media-image-blocked')).not.toBeNull();

    await must(mounted).rerender(<MediaImage src={`media:${HASH}`} />);
    await flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(q('media-image')?.getAttribute('src')).toBe('blob:test/2');

    await must(mounted).unmount();
    mounted = undefined;
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenLastCalledWith('blob:test/2');
  });
});
