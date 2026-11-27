// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { StudyAnnouncer } from '../src/study/StudyAnnouncer.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Built from its code point so no editor or formatter can turn it into a plain space.
const NBSP = String.fromCodePoint(0xa0);

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('StudyAnnouncer (§10)', () => {
  it('flips a trailing no-break space on each new card, so "Next card." is spoken again', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const mountedRoot = createRoot(container);
    root = mountedRoot;
    const text = () => container?.querySelector('[data-testid="study-announcer"]')?.textContent;
    const show = (cardId: string) =>
      act(() => {
        mountedRoot.render(
          <StudyAnnouncer cardId={cardId} caughtUp={false} revealStep={0} totalRevealSteps={1} />,
        );
      });

    show('c1');
    expect(text()).toBe('Next card.');
    show('c2');
    expect(text()).toBe(`Next card.${NBSP}`);
    show('c2');
    expect(text()).toBe(`Next card.${NBSP}`);
    show('c3');
    expect(text()).toBe('Next card.');
  });
});
