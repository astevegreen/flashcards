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

    expect(container.querySelector('[data-testid="study-announcer"]')).toBeNull();
    expect(counts()).toHaveLength(1);
    const sentence = must(counts()[0]).textContent;
    expect(sentence).toMatch(/^\d+ new, \d+ learning, \d+ due for review$/);
    expect(sentence).not.toBe('0 new, 0 learning, 0 due for review');

    gate.open();
    await flush(5);

    expect(container.querySelector('[data-testid="study-announcer"]')?.textContent).toBe(
      'Next card.',
    );
    expect(counts()).toHaveLength(1);
    expect(must(counts()[0]).textContent).toBe(sentence);
  });
});
