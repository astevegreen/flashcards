// @vitest-environment happy-dom
// Effect and timer wiring of #82 (P9) that the plain-function tests can't reach: the ReminderRuntime
// badge and native reschedule timers, the MediaImage missing-file retry, and Browse's deferred filter.
import type { StudyReminderScheduler } from '@flash/platform';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaImage, MISSING_MEDIA_RETRY_MS } from '../src/components/MediaImage.tsx';
import { BADGE_CHANGE_DEBOUNCE_MS, ReminderRuntime } from '../src/reminders/ReminderRuntime.tsx';
import { BrowseScreen } from '../src/screens/BrowseScreen.tsx';
import {
  advance,
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  must,
  newCard,
  sampleEvents,
  typeInto,
  type Mounted,
} from './helpers/app-harness.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const remindersOn = { enabled: true, hour: 0, minute: 0 };

/** Bumps `stateVersion` with a real local change (one rating). */
async function rateOne(m: Mounted): Promise<void> {
  await act(async () => m.app().rateCard(newCard(m), 3, 1000));
}

describe('ReminderRuntime timer wiring', () => {
  it('web: shows the badge at once, then rebuilds it once, 2 s after the last rating', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const storage = createMemoryStorage();
    storage.kv.set('study_reminders', remindersOn);
    const onBadgeChange = vi.fn();
    mounted = await mountWithApp(<ReminderRuntime onBadgeChange={onBadgeChange} />, {
      platform: createTestPlatform(storage),
      initialEvents: sampleEvents(),
    });
    await flush();
    const first = onBadgeChange.mock.lastCall?.[0] as number;
    expect(first).toBeGreaterThan(0);
    onBadgeChange.mockClear();

    await rateOne(mounted);
    await advance(BADGE_CHANGE_DEBOUNCE_MS / 2);
    await rateOne(mounted);
    await advance(BADGE_CHANGE_DEBOUNCE_MS - 1);
    expect(onBadgeChange).not.toHaveBeenCalled();
    await advance(1);
    expect(onBadgeChange).toHaveBeenCalledTimes(1);
    expect(onBadgeChange).toHaveBeenLastCalledWith(first - 2);
  });

  it('web: reminders off keep the badge at 0', async () => {
    const onBadgeChange = vi.fn();
    mounted = await mountWithApp(<ReminderRuntime onBadgeChange={onBadgeChange} />, {
      initialEvents: sampleEvents(),
    });
    await flush();
    expect(onBadgeChange).toHaveBeenCalledWith(0);
    expect(onBadgeChange.mock.calls.every(([n]) => n === 0)).toBe(true);
  });

  it('native: schedules at launch, again 10 s after a change, and when the app is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const storage = createMemoryStorage();
    storage.kv.set('study_reminders', remindersOn);
    const scheduler: StudyReminderScheduler = {
      checkPermission: vi.fn(async () => 'granted' as const),
      requestPermission: vi.fn(async () => 'granted' as const),
      replaceAll: vi.fn(async () => {}),
      cancelAll: vi.fn(async () => {}),
    };
    const platform = createTestPlatform(storage, {
      getStudyReminderScheduler: async () => scheduler,
    });
    const onBadgeChange = vi.fn();
    mounted = await mountWithApp(<ReminderRuntime onBadgeChange={onBadgeChange} />, {
      platform,
      initialEvents: sampleEvents(),
    });
    await flush();
    expect(scheduler.replaceAll).toHaveBeenCalledTimes(1);
    // Native shells never show the in-app badge.
    expect(onBadgeChange.mock.calls.every(([n]) => n === 0)).toBe(true);

    await rateOne(mounted);
    await advance(9_999);
    expect(scheduler.replaceAll).toHaveBeenCalledTimes(1);
    await advance(1);
    await flush();
    expect(scheduler.replaceAll).toHaveBeenCalledTimes(2);

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    expect(scheduler.replaceAll).toHaveBeenCalledTimes(3);
    visibility.mockRestore();
  });
});

const HASH = 'ab'.repeat(32);

describe('MediaImage effect wiring', () => {
  it('a missing file is looked for again at most every 5 s, without flickering to Loading', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const storage = createMemoryStorage();
    const getMedia = vi.spyOn(storage, 'getMedia');
    mounted = await mountWithApp(<MediaImage src={`media:${HASH}`} alt="pic" />, {
      platform: createTestPlatform(storage),
      initialEvents: sampleEvents(),
    });
    await flush();
    const reads = () => getMedia.mock.calls.filter(([h]) => h === HASH).length;
    expect(reads()).toBe(1);
    const q = (id: string) => must(mounted).container.querySelector(`[data-testid="${id}"]`);
    expect(q('media-image-missing')).not.toBeNull();

    // A collection change soon after: no new read, and still "pending sync", not "Loading".
    await rateOne(mounted);
    await flush();
    expect(reads()).toBe(1);
    expect(q('media-image-loading')).toBeNull();
    expect(q('media-image-missing')).not.toBeNull();

    // A sync brings the file; the timer finds it once the interval has passed.
    storage.media.set(HASH, { hash: HASH, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
    await advance(MISSING_MEDIA_RETRY_MS);
    await flush();
    expect(reads()).toBe(2);
    expect(q('media-image')?.getAttribute('data-media-hash')).toBe(HASH);
  });

  it('a loaded image is not read again on an unrelated collection change', async () => {
    const storage = createMemoryStorage();
    storage.media.set(HASH, { hash: HASH, mime: 'image/png', bytes: new Uint8Array([1]) });
    const getMedia = vi.spyOn(storage, 'getMedia');
    mounted = await mountWithApp(<MediaImage src={`media:${HASH}`} />, {
      platform: createTestPlatform(storage),
      initialEvents: sampleEvents(),
    });
    await flush();
    expect(mounted.container.querySelector('[data-testid="media-image"]')).not.toBeNull();
    await rateOne(mounted);
    await flush();
    expect(getMedia).toHaveBeenCalledTimes(1);
  });

  it('blocks an unsafe scheme without reading storage', async () => {
    const storage = createMemoryStorage();
    const getMedia = vi.spyOn(storage, 'getMedia');
    mounted = await mountWithApp(<MediaImage src="javascript:alert(1)" />, {
      platform: createTestPlatform(storage),
    });
    await flush();
    expect(mounted.container.querySelector('[data-testid="media-image-blocked"]')).not.toBeNull();
    expect(getMedia).not.toHaveBeenCalled();
  });
});

describe('Browse deferred search filter', () => {
  it('the list count follows the typed query', async () => {
    mounted = await mountWithApp(<BrowseScreen />, { initialEvents: sampleEvents() });
    await flush();
    const selectAllLabel = () =>
      must(mounted).container.querySelector('[data-testid="browse-select-all"]')?.parentElement
        ?.textContent ?? '';
    const count = () => Number(/\((\d+)\)/.exec(selectAllLabel())?.[1]);
    const total = count();
    expect(total).toBeGreaterThan(1);

    const input = must(
      mounted.container.querySelector<HTMLInputElement>('input[type="search"]'),
      'the search box',
    );
    // A query no note matches.
    await typeInto(input, 'zzzz-no-such-note');
    await flush();
    expect(input.value).toBe('zzzz-no-such-note');
    expect(count()).toBe(0);
    expect(mounted.container.textContent).toContain('No matching notes found.');

    await typeInto(input, '');
    await flush();
    expect(count()).toBe(total);
  });
});
