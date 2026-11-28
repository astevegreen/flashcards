// @vitest-environment happy-dom
// Panels cleared from REACT_COMPILER_BASELINE (follow-ups #108, second batch). Resets that an
// effect used to make after commit now happen during render, refs synced in render are synced in
// a layout effect, and clock reads moved out of component bodies. These pin what the
// rewrites must keep: nothing-to-load states show at once, a new card or platform resets, clearing
// the ink drops the candidates, and strokes accumulate.
import type {
  DictionaryService,
  HandwritingCandidate,
  HandwritingRecognizer,
  InkStroke,
  PlatformServices,
  StrokeDataProvider,
} from '@flash/platform';
import { act, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DictionaryPanel } from '../src/dictionary/DictionaryPanel.tsx';
import { DrawLookupPanel } from '../src/drawing/DrawLookupPanel.tsx';
import DrawQuizPanel from '../src/drawing/DrawQuizPanel.tsx';
import { PointerInkCanvas } from '../src/drawing/PointerInkCanvas.tsx';
import {
  createTestPlatform,
  flush,
  mountWithApp,
  must,
  type Mounted,
} from './helpers/app-harness.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const byTestId = <T extends Element = HTMLElement>(m: Mounted, id: string): T | null =>
  m.container.querySelector<T>(`[data-testid="${id}"]`);

async function click(el: Element | null): Promise<void> {
  await act(async () => {
    must(el, 'element to click').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Records the markup of `children` as first committed, before any passive effect runs: a state
 * reset that used to wait for an effect shows up here as the old intermediate screen.
 */
function FirstCommit({
  children,
  record,
}: {
  children: ReactNode;
  record: (html: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => record(ref.current?.innerHTML ?? ''), [record]);
  return <div ref={ref}>{children}</div>;
}

/** Mounts `ui` and returns its first committed markup. */
async function mountFirstCommit(
  ui: ReactNode,
  options: Parameters<typeof mountWithApp>[1] = {},
): Promise<string> {
  let first: string | undefined;
  const record = (html: string) => {
    first ??= html;
  };
  mounted = await mountWithApp(<FirstCommit record={record}>{ui}</FirstCommit>, options);
  return must(first, 'the first commit');
}

/** One pointer stroke on `canvas`: down, a move, up. */
async function drawStroke(canvas: Element | null, pointerId: number): Promise<void> {
  const target = must(canvas, 'the ink canvas');
  const fire = (type: string, x: number, y: number) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId,
        pointerType: 'pen',
        button: 0,
        clientX: x,
        clientY: y,
      }),
    );
  await act(async () => void fire('pointerdown', 10, 10));
  await act(async () => void fire('pointermove', 40, 40));
  await act(async () => void fire('pointerup', 40, 40));
}

describe('PointerInkCanvas', () => {
  it('appends each finished stroke to the strokes the parent last passed in', async () => {
    const seen: InkStroke[][] = [];
    function Host() {
      const [strokes, setStrokes] = useState<InkStroke[]>([]);
      return (
        <PointerInkCanvas
          strokes={strokes}
          onChangeStrokes={(next) => {
            seen.push(next);
            setStrokes(next);
          }}
        />
      );
    }
    mounted = await mountWithApp(<Host />);
    await drawStroke(byTestId(mounted, 'ink-canvas'), 1);
    await drawStroke(byTestId(mounted, 'ink-canvas'), 2);
    expect(seen.map((s) => s.length)).toEqual([1, 2]);
    expect(byTestId<HTMLButtonElement>(mounted, 'ink-canvas-undo')?.disabled).toBe(false);
  });
});

const candidate = (character: string): HandwritingCandidate => ({
  character,
  score: 0.9,
  strokeCount: 1,
});

function recognizerPlatform(results: HandwritingCandidate[]): PlatformServices {
  const recognizer: HandwritingRecognizer = {
    id: 'test',
    isNative: false,
    isReady: async () => true,
    recognize: async () => results,
  };
  return createTestPlatform(undefined, { getHandwritingRecognizer: async () => recognizer });
}

describe('DrawLookupPanel', () => {
  it('shows the stroke-pack notice in its first commit on a platform without a recognizer', async () => {
    const first = await mountFirstCommit(<DrawLookupPanel />);
    expect(first).toContain('data-testid="draw-lookup-no-index"');
    expect(byTestId(must(mounted), 'draw-lookup-no-index')).not.toBeNull();
  });

  it('drops the candidates in the same update that clears the last stroke', async () => {
    const onCandidatesChange = vi.fn();
    mounted = await mountWithApp(<DrawLookupPanel onCandidatesChange={onCandidatesChange} />, {
      platform: recognizerPlatform([candidate('人')]),
    });
    expect(byTestId(mounted, 'draw-lookup-no-index')).toBeNull();
    // Mounting with no ink reports no candidates, as before.
    expect(onCandidatesChange).toHaveBeenLastCalledWith([]);

    await drawStroke(byTestId(mounted, 'draw-lookup-canvas'), 1);
    const m = mounted;
    await vi.waitFor(async () => {
      await flush(1);
      expect(byTestId(m, 'draw-lookup-candidate-人')).not.toBeNull();
    });
    expect(onCandidatesChange).toHaveBeenLastCalledWith([candidate('人')]);

    await click(byTestId(mounted, 'draw-lookup-canvas-clear'));
    expect(byTestId(mounted, 'draw-lookup-candidate-人')).toBeNull();
    expect(byTestId(mounted, 'draw-lookup-candidates')?.textContent).toContain(
      'Draw a character above',
    );
    expect(onCandidatesChange).toHaveBeenLastCalledWith([]);
  });
});

describe('DrawQuizPanel', () => {
  const quiz = (cardId: string, characters: readonly string[]) => (
    <DrawQuizPanel
      cardId={cardId}
      characters={characters}
      script="zh-Hans"
      isRevealed={false}
      onEvaluateAndReveal={() => undefined}
    />
  );

  it('shows the freehand fallback in its first commit when there is no stroke provider', async () => {
    const first = await mountFirstCommit(quiz('c1', ['人']));
    expect(first).not.toContain('data-testid="draw-quiz-loading"');
    expect(first).toContain('data-testid="draw-quiz-fallback"');
    expect(byTestId(must(mounted), 'draw-quiz-fallback')).not.toBeNull();
  });

  it('loads, falls back when the data is missing, and a new card clears the freehand ink', async () => {
    const getCharacterData = vi.fn(async () => null);
    const provider = { getCharacterData } as unknown as StrokeDataProvider;
    mounted = await mountWithApp(quiz('c1', ['人']), {
      platform: createTestPlatform(undefined, { getStrokeDataProvider: async () => provider }),
    });
    const m = mounted;
    await vi.waitFor(async () => {
      await flush(1);
      expect(byTestId(m, 'draw-quiz-fallback')).not.toBeNull();
    });
    expect(getCharacterData).toHaveBeenCalledWith('zh-Hans', '人', { allowNetwork: true });

    await drawStroke(byTestId(mounted, 'draw-fallback-canvas'), 1);
    expect(byTestId<HTMLButtonElement>(mounted, 'draw-fallback-canvas-undo')?.disabled).toBe(false);

    // The next card shows Loading in the same render, then its own fallback with no ink.
    await mounted.rerender(quiz('c2', ['大']));
    await vi.waitFor(async () => {
      await flush(1);
      expect(getCharacterData).toHaveBeenLastCalledWith('zh-Hans', '大', { allowNetwork: true });
      expect(byTestId(m, 'draw-quiz-fallback')).not.toBeNull();
    });
    expect(byTestId<HTMLButtonElement>(mounted, 'draw-fallback-canvas-undo')?.disabled).toBe(true);
  });
});

describe('DictionaryPanel', () => {
  it('shows the no-dictionaries view in its first commit when there is no service', async () => {
    const first = await mountFirstCommit(<DictionaryPanel />);
    expect(first).toContain('data-testid="dict-empty-packs"');
    expect(byTestId(must(mounted), 'dict-empty-packs')).not.toBeNull();
  });

  it('shows the browse home once the installed packs load', async () => {
    const service = {
      listInstalledDictionaryPacks: async () => [
        {
          id: 'dict-krdict',
          kind: 'dictionary',
          name: 'KRDict',
          version: '1',
          language: 'ko',
          entryCount: 1,
          byteSize: 1,
          installedAt: 0,
          licenseName: 'test',
          licenseUrl: 'https://example.test/license',
          attribution: 'test',
          sourceUrl: 'https://example.test',
        },
      ],
      getBrowseSummary: async () => ({
        packId: 'dict-krdict',
        total: 3,
        initials: [{ key: 'ㄱ', count: 3 }],
        levels: [],
        pos: [],
        topics: [],
        grades: [],
      }),
      search: async () => [],
      lookupCharacter: async () => [],
      browse: async () => ({ entries: [] }),
    } as unknown as DictionaryService;
    const withService = createTestPlatform(undefined, {
      getDictionaryService: async () => service,
    });
    mounted = await mountWithApp(<DictionaryPanel />, { platform: withService });
    const m = mounted;
    await vi.waitFor(async () => {
      await flush(1);
      expect(byTestId(m, 'dict-empty-packs')).toBeNull();
      expect(m.container.textContent).toContain('ㄱ');
    });
  });
});
