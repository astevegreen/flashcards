import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichText, RubyDisplayContext } from '../src/components/RichText.tsx';
import { cardTextFitTier, visibleTextLength } from '../src/study/fitText.ts';

function html(
  display: 'both' | 'readings' | 'bases' | undefined,
  hideRuby = false,
  text = '日本語[にほんご]を話す',
): string {
  const el = createElement(RichText, { text, lang: 'ja', hideRuby });
  return renderToStaticMarkup(
    display ? createElement(RubyDisplayContext.Provider, { value: display }, el) : el,
  );
}

describe('RichText with the layout ruby flag', () => {
  it('golden: default and both render <ruby> with <rt>', () => {
    const expected =
      '<span lang="ja"><ruby>日本語<rt>にほんご</rt></ruby><span>を話す</span></span>';
    expect(html(undefined)).toBe(expected);
    expect(html('both')).toBe(expected);
  });

  it('golden: readings shows the reading as plain text, bases the base', () => {
    expect(html('readings')).toBe('<span lang="ja"><span>にほんごを話す</span></span>');
    expect(html('bases')).toBe('<span lang="ja"><span>日本語を話す</span></span>');
  });

  it('hideRuby still hides <rt> under both and does not touch reduced text', () => {
    expect(html('both', true)).toBe(
      '<span lang="ja"><ruby>日本語</ruby><span>を話す</span></span>',
    );
    expect(html('readings', true)).toBe('<span lang="ja"><span>にほんごを話す</span></span>');
    expect(html('bases', true)).toBe('<span lang="ja"><span>日本語を話す</span></span>');
  });
});

describe('auto-fit follows the shown text', () => {
  it('counts readings on a readings layout', () => {
    expect(visibleTextLength('日本[にほん]')).toBe(2);
    expect(visibleTextLength('日本[にほん]', 'readings')).toBe(3);
    expect(cardTextFitTier('日本[にほん]', 'prompt', 'readings')).toBe('p2');
  });
});
