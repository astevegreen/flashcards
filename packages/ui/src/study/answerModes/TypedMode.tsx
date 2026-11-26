import { Suspense } from 'react';
import { lazyWithRetry } from '../../lazy/lazyWithRetry.tsx';
import { FrontFields, RevealedAnswer } from './AnswerShell.tsx';
import type { AnswerModePlugin, AnswerModeRenderProps } from './types.ts';

const LazyTypedAnswerPanel = lazyWithRetry(() => import('./TypedAnswerPanel.tsx'));

function TypedModeView(props: AnswerModeRenderProps) {
  const { card, note, deck, layout, noteType, fieldMetaByKey, isRevealed, onEvaluateAndReveal } =
    props;
  const step0 = layout.reveal_steps[0] ?? [];
  const nonMediaStep0 = step0.filter((k) => {
    const f = noteType?.fields.find((nf) => nf.key === k);
    return f?.kind !== 'image' && f?.kind !== 'audio';
  });
  const populatedStep0 = nonMediaStep0.filter((k) => Boolean(note.fields[k]?.trim()));
  const answerFieldKey =
    layout.answer_field ??
    populatedStep0.find(
      (k) => k === 'meaning' || k === 'translation' || k === 'explanation' || k === 'word',
    ) ??
    populatedStep0[0] ??
    nonMediaStep0[0] ??
    step0[0] ??
    'meaning';

  const expectedRaw = note.fields[answerFieldKey] ?? '';
  const answerMeta = fieldMetaByKey.get(answerFieldKey);
  const answerLang = answerMeta?.lang ?? deck.language;

  return (
    <>
      <FrontFields {...props} fit="answer" />

      <Suspense
        fallback={<div className="text-xs text-[var(--muted)]">Loading typed matcher…</div>}
      >
        <LazyTypedAnswerPanel
          cardId={card.id}
          expectedRaw={expectedRaw}
          {...(layout.ruby_display ? { rubyDisplay: layout.ruby_display } : {})}
          lang={answerLang}
          isRevealed={isRevealed}
          placeholder={`Type ${answerMeta?.label ?? answerFieldKey}…`}
          onEvaluateAndReveal={onEvaluateAndReveal}
        />
      </Suspense>

      <RevealedAnswer {...props} />
    </>
  );
}

export const typedAnswerMode: AnswerModePlugin = {
  mode: 'typed',
  capturesFrontInteraction: true,
  render: (props) => <TypedModeView {...props} />,
};
