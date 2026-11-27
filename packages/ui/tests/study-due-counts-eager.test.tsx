// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush, mountWithApp, must, sampleEvents, type Mounted } from './helpers/app-harness.tsx';

// Holds the lazy announcer chunk until the test lets it load, like a slow network would.
const gate = vi.hoisted(() => {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open: () => open(), opened };
});

vi.mock('../src/study/StudyAnnouncer.tsx', async (importOriginal) => {
  await gate.opened;
  return importOriginal();
});

const { StudyScreen } = await import('../src/screens/StudyScreen.tsx');

/**
 * Flushes React until `read` returns something, or fails after `timeoutMs`. Under coverage and a
 * busy machine a lazy chunk can take longer than a fixed number of flushes to render.
 */
async function waitFor<T>(read: () => T | null | undefined, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await flush(1);
  }
}

let mounted: Mounted | undefined;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('study due-count sentence (§10)', () => {
  it('is there for screen readers before the lazy announcer chunk loads, and only once after', async () => {
    mounted = await mountWithApp(<StudyScreen onOpenLibrary={() => {}} />, {
      initialEvents: sampleEvents(),
    });
    const { container } = mounted;
    const counts = () => container.querySelectorAll('[data-testid="study-due-counts"]');
    const announcer = () => container.querySelector('[data-testid="study-announcer"]');

    // The gate holds the chunk, so whatever the sentence waits for, the announcer cannot be there.
    const sentence = await waitFor(() => {
      const text = counts()[0]?.textContent;
      return text && text !== '0 new, 0 learning, 0 due for review' ? text : undefined;
    }, 'a non-zero due-count sentence');
    expect(announcer()).toBeNull();
    expect(counts()).toHaveLength(1);
    expect(sentence).toMatch(/^\d+ new, \d+ learning, \d+ due for review$/);

    gate.open();
    const live = await waitFor(announcer, 'the lazy announcer to render');

    expect(live.textContent).toBe('Next card.');
    expect(counts()).toHaveLength(1);
    expect(must(counts()[0]).textContent).toBe(sentence);
  }, 30_000);
});
