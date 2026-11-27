import type { Page } from '@flash/core';
import { sanitizePageMarkdown } from '@flash/core/sources';
import { useMemo, useState, type FormEvent } from 'react';
import { PageViewer } from './PageViewer.tsx';

interface PageEditorProps {
  initialPage?: Page | null;
  onSave: (input: {
    pageId?: string;
    slug: string;
    title: string;
    markdown: string;
    lang?: string;
    tags: string[];
  }) => void;
  onCancel: () => void;
}

/**
 * Strictly lazy-loaded Markdown Lesson Page editor with live sanitized preview (§2.3, §13).
 */
function PageEditor({ initialPage, onSave, onCancel }: PageEditorProps) {
  const [title, setTitle] = useState(initialPage?.title ?? '');
  const [slug, setSlug] = useState(initialPage?.slug ?? '');
  const [lang, setLang] = useState(initialPage?.lang ?? 'ja');
  const [tagsText, setTagsText] = useState(initialPage?.tags.join(', ') ?? '');
  const [markdown, setMarkdown] = useState(
    initialPage?.markdown ??
      '# New Lesson\n\nWrite lesson notes with ruby 漢字[かんじ], ::say[こんにちは]{lang=ja}, and :::note blocks.\n',
  );
  const [activePane, setActivePane] = useState<'edit' | 'preview'>('edit');

  const sanitizedPreview = useMemo(() => sanitizePageMarkdown(markdown), [markdown]);

  const previewPage: Page = useMemo(
    () => ({
      id: initialPage?.id ?? 'preview',
      slug: slug || 'preview',
      title: title || 'Preview',
      markdown: sanitizedPreview.markdown,
      lang,
      tags: tagsText
        .split(/[;,]/)
        .map((t) => t.trim())
        .filter(Boolean),
    }),
    [initialPage?.id, lang, sanitizedPreview.markdown, slug, tagsText, title],
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const cleaned = sanitizePageMarkdown(markdown);
    const derivedSlug =
      slug.trim() ||
      title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, '-')
        .replace(/^-+|-+$/g, '') ||
      'lesson';
    const tags = tagsText
      .split(/[;,]/)
      .map((t) => t.trim())
      .filter(Boolean);
    onSave({
      ...(initialPage?.id !== undefined ? { pageId: initialPage.id } : {}),
      slug: derivedSlug,
      title: title.trim() || derivedSlug,
      markdown: cleaned.markdown,
      ...(lang ? { lang } : {}),
      tags,
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="page-editor"
      className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          {initialPage ? `Edit Page: ${initialPage.title}` : 'New Lesson Page'}
        </h2>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActivePane('edit')}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
              activePane === 'edit'
                ? 'bg-[var(--accent)] text-white'
                : 'border border-[var(--border)] text-[var(--muted)]'
            }`}
          >
            Write
          </button>
          <button
            type="button"
            data-testid="page-editor-preview-tab"
            onClick={() => setActivePane('preview')}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
              activePane === 'preview'
                ? 'bg-[var(--accent)] text-white'
                : 'border border-[var(--border)] text-[var(--muted)]'
            }`}
          >
            Preview
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[var(--muted)]">Title</span>
          <input
            type="text"
            data-testid="page-editor-title"
            required
            placeholder="Japanese Particles Guide"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[var(--muted)]">Slug</span>
          <input
            type="text"
            data-testid="page-editor-slug"
            placeholder="ja-particles"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[var(--muted)]">Language</span>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm"
          >
            <option value="ja">Japanese (ja)</option>
            <option value="ko">Korean (ko)</option>
            <option value="zh-Hans">Mandarin (zh-Hans)</option>
            <option value="en">English (en)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[var(--muted)]">Tags</span>
          <input
            type="text"
            placeholder="grammar, jlpt-n5"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm"
          />
        </label>
      </div>

      {sanitizedPreview.warnings.length > 0 && (
        <div
          role="status"
          data-testid="page-editor-warnings"
          className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
        >
          {sanitizedPreview.warnings.map((w) => w.message).join(' ')}
        </div>
      )}

      {activePane === 'edit' ? (
        <textarea
          rows={12}
          data-testid="page-editor-markdown"
          aria-label="Lesson Markdown"
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs leading-relaxed text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none"
        />
      ) : (
        <PageViewer page={previewPage} previewMode />
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-semibold hover:bg-[var(--surface-2)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          data-testid="page-editor-save"
          className="rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
        >
          Save Page
        </button>
      </div>
    </form>
  );
}

export default PageEditor;
