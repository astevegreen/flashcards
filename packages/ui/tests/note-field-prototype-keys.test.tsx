// @vitest-environment happy-dom
// A layout can name a field key such as `constructor` that the note does not have. The card must
// show nothing for it, never the inherited `function Object() { [native code] }` (S4: noteField).
import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { FrontFields, type FrontFieldsProps } from '../src/study/answerModes/FrontFields.tsx';
import { RevealedAnswer, type RevealedAnswerProps } from '../src/study/answerModes/AnswerShell.tsx';
import { flush, mountWithApp, type Mounted } from './helpers/app-harness.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const note = { fields: { word: 'hello' }, tags: [] } as unknown as FrontFieldsProps['note'];
const deck = { language: 'en' } as unknown as FrontFieldsProps['deck'];
const KEYS = ['constructor', 'toString', 'word'];

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('field keys that exist only on Object.prototype', () => {
  it('render empty on the study front', async () => {
    const props = {
      note,
      deck,
      layout: { front_fields: KEYS, ruby_display: 'ruby' },
      fieldMetaByKey: new Map(),
      hideFrontRuby: false,
      pinyinToneColors: false,
      fit: 'prompt',
    } as unknown as FrontFieldsProps;
    mounted = await mountWithApp(createElement(FrontFields, props));
    await act(flush);
    const html = mounted.container.innerHTML;
    expect(html).not.toContain('native code');
    expect(html).not.toContain('front-field-constructor');
    expect(html).not.toContain('front-field-toString');
    expect(mounted.container.textContent).toBe('hello');
  });

  it('render empty in the revealed answer, main steps and extras panel', async () => {
    const props = {
      note,
      deck,
      fieldMetaByKey: new Map(),
      pinyinToneColors: false,
      populatedRevealSteps: [['constructor', 'word'], ['toString']],
      revealStep: 2,
      isRevealed: true,
      isFullyRevealed: true,
    } as unknown as RevealedAnswerProps;
    mounted = await mountWithApp(createElement(RevealedAnswer, props));
    await act(flush);
    const html = mounted.container.innerHTML;
    expect(html).not.toContain('native code');
    expect(html).not.toContain('back-field-constructor');
    expect(html).not.toContain('back-field-toString');
    expect(html).toContain('back-field-word');
  });
});
