import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichText, RubyDisplayContext } from '../src/components/RichText.tsx';
import { visibleTextLength } from '../src/study/fitText.ts';

function html(text: string, lang = 'ja', display?: 'both' | 'readings' | 'bases'): string {
  const el = createElement(RichText, { text, lang });
  return renderToStaticMarkup(
    display ? createElement(RubyDisplayContext.Provider, { value: display }, el) : el,
  );
}

describe('RichText bold, italic and colour spans', () => {
  it('golden: text without markup renders exactly as before', () => {
    expect(html('日本語[にほんご]を話す')).toBe(
      '<span lang="ja"><ruby>日本語<rt>にほんご</rt></ruby><span>を話す</span></span>',
    );
    expect(html('word [formal] {x|y')).toBe(
      '<span lang="ja"><span>word [formal] {x|y</span></span>',
    );
  });

  it('golden: spans render as strong, em and palette classes', () => {
    expect(html('私は{b:学生}です', 'ja')).toBe(
      '<span lang="ja"><span>私は</span><strong><span>学生</span></strong><span>です</span></span>',
    );
    expect(html('{i:x}', 'en')).toBe('<span lang="en"><em><span>x</span></em></span>');
    expect(html('{red:{b:cat}}', 'en')).toBe(
      '<span lang="en"><span class="rich-red" data-rich-color="red"><strong><span>cat</span></strong></span></span>',
    );
  });

  it('ruby inside a span keeps its reading and follows the layout flag', () => {
    expect(html('{b:日本[にほん]}')).toBe(
      '<span lang="ja"><strong><ruby>日本<rt>にほん</rt></ruby></strong></span>',
    );
    expect(html('{b:日本[にほん]}', 'ja', 'readings')).toBe(
      '<span lang="ja"><strong><span>にほん</span></strong></span>',
    );
  });

  it('pinyin tone colours still apply inside a span', () => {
    expect(html('{b:nǐ}', 'zh-Latn-pinyin')).toContain('<strong><span class="pinyin-tone-3">');
  });

  it('never emits markup from field text as HTML', () => {
    const out = html('{b:<img src=x onerror=alert(1)>}', 'en');
    expect(out).toContain('&lt;img');
    expect(out).not.toContain('<img');
  });

  it('auto-fit counts the visible characters, not the markup', () => {
    expect(visibleTextLength('{b:{red:cat}}')).toBe(3);
  });
});
