// @vitest-environment happy-dom
// A layout can name a field key such as `constructor` that the note does not have. The card must
// show nothing for it, never the inherited `function Object() { [native code] }`, and must not
// crash on it (S4: noteField). Every answer mode and the shared front/answer parts are covered.
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevealedAnswer } from '../src/study/answerModes/AnswerShell.tsx';
import { clozeAnswerMode } from '../src/study/answerModes/ClozeMode.tsx';
import { drawAnswerMode } from '../src/study/answerModes/DrawMode.tsx';
import { FrontFields } from '../src/study/answerModes/FrontFields.tsx';
import { flipAnswerMode } from '../src/study/answerModes/FlipMode.tsx';
import { listenAnswerMode } from '../src/study/answerModes/ListenMode.tsx';
import { typedAnswerMode } from '../src/study/answerModes/TypedMode.tsx';
import type { AnswerModePlugin, AnswerModeRenderProps } from '../src/study/answerModes/types.ts';
import { populatedRevealStepsFor } from '../src/screens/StudyScreen.tsx';
import { precacheUpcomingDrawCards } from '../src/study/strokePrecache.ts';
import { frontRubyHidden } from '../src/study/rubyToggle.ts';
import { useApp } from '../src/state/AppContext.tsx';
import { flush, mountWithApp, type Mounted } from './helpers/app-harness.tsx';
import {
  expectNoProtoLeak,
  PROTO_KEYS,
  protoLayout,
  protoEvents,
  protoNote,
  spyConsoleErrors,
} from './helpers/proto-keys.ts';

const typedPanelProps = vi.hoisted(() => [] as { expectedRaw: unknown }[]);
vi.mock('../src/study/answerModes/TypedAnswerPanel.tsx', () => ({
  default: (props: { expectedRaw: unknown }) => {
    typedPanelProps.push(props);
    return null;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

function ModeHarness(props: {
  plugin?: AnswerModePlugin;
  part?: 'front' | 'answer';
  over?: Partial<AnswerModeRenderProps>;
}) {
  const { state } = useApp();
  const layout = props.over?.layout ?? protoLayout();
  const all = {
    state,
    card: { id: 'card-proto', variant: 1 },
    note: protoNote,
    deck: { language: 'en', id: 'deck-proto-a' },
    layout,
    noteType: undefined,
    fieldMetaByKey: new Map(),
    populatedRevealSteps: layout.reveal_steps,
    revealStep: layout.reveal_steps.length,
    isRevealed: true,
    isFullyRevealed: true,
    hideFrontRuby: false,
    pinyinToneColors: false,
    studyDayIndex: 0,
    evaluation: null,
    onRevealNext: () => undefined,
    onEvaluateAndReveal: () => undefined,
    ...props.over,
  } as unknown as AnswerModeRenderProps;
  if (props.plugin) return props.plugin.render(all);
  if (props.part === 'front') return createElement(FrontFields, { ...all, fit: 'prompt' });
  return createElement(RevealedAnswer, all);
}

async function render(props: Parameters<typeof ModeHarness>[0]) {
  await mounted?.unmount();
  const errors = spyConsoleErrors();
  mounted = await mountWithApp(createElement(ModeHarness, props));
  await act(flush);
  expect(errors).not.toHaveBeenCalled();
  expectNoProtoLeak(mounted.container);
  return mounted.container;
}

describe('field keys that exist only on Object.prototype', () => {
  it('render empty on the shared study front', async () => {
    const container = await render({ part: 'front' });
    expect(container.textContent).toBe('hello');
  });

  it('render empty in the revealed answer, main steps and extras panel', async () => {
    const container = await render({ part: 'answer' });
    expect(container.innerHTML).toContain('back-field-word');
  });

  it('render empty on the Flip front', async () => {
    const container = await render({ plugin: flipAnswerMode });
    expect(container.innerHTML).toContain('front-field-word');
  });

  it('render empty on the Listen reveal', async () => {
    const container = await render({ plugin: listenAnswerMode });
    expect(container.innerHTML).toContain('back-front-field-word');
  });

  it('keep Typed from reading them as the expected answer', async () => {
    await render({
      plugin: typedAnswerMode,
      over: { layout: protoLayout({ answer_field: 'constructor' }) },
    });
    expect(typedPanelProps.map((p) => p.expectedRaw)).toEqual(['']);
  });

  it('keep Draw from reading them as the expected answer', async () => {
    await render({
      plugin: drawAnswerMode,
      over: { layout: protoLayout({ answer_field: 'constructor' }) },
    });
  });

  it('keep Cloze from reading them as a cloze field', async () => {
    const container = await render({ plugin: clozeAnswerMode });
    expect(container.innerHTML).toContain('front-field-word');
  });

  it('ruby toggle stays off when the layout names them', () => {
    const layout = protoLayout({ hide_furigana_on_front: true, front_fields: [...PROTO_KEYS] });
    expect(frontRubyHidden(layout, protoNote)).toBe(false);
  });

  it('are not populated reveal steps of the study screen', () => {
    const layout = protoLayout({ reveal_steps: [[...PROTO_KEYS], ['word']] });
    expect(populatedRevealStepsFor(layout, protoNote)).toEqual([['word']]);
  });

  it('add no characters to the stroke pre-cache', async () => {
    mounted = await mountWithApp(null, { initialEvents: protoEvents() });
    const { state } = mounted.app();
    const cards = [...state.cards.values()].filter((c) => c.deck_id === 'deck-proto-c');
    expect(cards.length).toBeGreaterThan(0);
    const provider = { precacheCharacters: vi.fn() };
    await precacheUpcomingDrawCards(state, cards, provider as never, () => false);
    expect(provider.precacheCharacters).not.toHaveBeenCalled();
  });
});
