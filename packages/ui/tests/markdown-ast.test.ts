import { describe, expect, it } from 'vitest';
import { parsePageMarkdownToAst, type AstNode } from '../src/pages/markdownAst.ts';

function collectNodes(node: AstNode, out: AstNode[] = []): AstNode[] {
  out.push(node);
  for (const child of node.children ?? []) {
    collectNodes(child, out);
  }
  return out;
}

describe('Markdown Page AST parser & directive preprocessing (§2.3, §13)', () => {
  it('parses column-0 inline ::say followed by trailing text as a textDirective', () => {
    const ast = parsePageMarkdownToAst('::say[食[た]べます]{lang=ja} means "to eat".');
    const nodes = collectNodes(ast);
    const sayNode = nodes.find(
      (n) => (n.type === 'textDirective' || n.type === 'leafDirective') && n.name === 'say',
    );
    expect(sayNode).toBeDefined();
    expect(sayNode?.attributes?.['lang']).toBe('ja');
    expect(sayNode?.children?.[0]?.value).toBe('食[た]べます');

    const paragraph = ast.children?.[0];
    expect(paragraph?.type).toBe('paragraph');
    expect(paragraph?.children?.some((c) => c.type === 'text' && c.value?.includes('means'))).toBe(
      true,
    );
  });

  it('keeps standalone ::deck-link and ::image lines as leafDirectives and protects inline code', () => {
    const md = [
      '::deck-link{deck="Particles"}',
      '',
      '::image[diagram]{src="media:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
      '',
      'Literal code: `::say[not-a-button]{lang=ja}` and real ::say[はい]{lang=ja}.',
    ].join('\n');

    const ast = parsePageMarkdownToAst(md);
    const nodes = collectNodes(ast);

    const deckLink = nodes.find((n) => n.type === 'leafDirective' && n.name === 'deck-link');
    expect(deckLink?.attributes?.['deck']).toBe('Particles');

    const img = nodes.find((n) => n.type === 'leafDirective' && n.name === 'image');
    expect(img?.attributes?.['src']).toBe(
      'media:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );

    const inlineCode = nodes.find((n) => n.type === 'inlineCode');
    expect(inlineCode?.value).toBe('::say[not-a-button]{lang=ja}');

    const sayNodes = nodes.filter((n) => n.name === 'say');
    expect(sayNodes).toHaveLength(1);
    expect(sayNodes[0]?.children?.[0]?.value).toBe('はい');
  });

  it('splits :::example translation separator --- into a thematicBreak even without blank lines', () => {
    const md = ':::example\n日本語の文\n---\nEnglish translation\n:::';
    const ast = parsePageMarkdownToAst(md);
    const ex = ast.children?.find((n) => n.type === 'containerDirective' && n.name === 'example');
    expect(ex).toBeDefined();
    expect(ex?.children?.some((c) => c.type === 'thematicBreak')).toBe(true);
  });
});
