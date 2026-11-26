import { FrontFields, RevealedAnswer } from './AnswerShell.tsx';
import type { AnswerModePlugin, AnswerModeRenderProps } from './types.ts';

function FlipModeView(props: AnswerModeRenderProps) {
  const { populatedRevealSteps, isRevealed, isFullyRevealed } = props;
  const isExtrasOpen = isRevealed && populatedRevealSteps.length > 1 && isFullyRevealed;

  return (
    <>
      <FrontFields
        {...props}
        fit="prompt"
        className={`flex w-full max-w-2xl flex-col items-center gap-3 transition-[padding] duration-200 ${
          isExtrasOpen ? 'pt-1' : 'pt-4'
        }`}
      />
      <RevealedAnswer {...props} />
    </>
  );
}

export const flipAnswerMode: AnswerModePlugin = {
  mode: 'flip',
  capturesFrontInteraction: false,
  render: (props) => <FlipModeView {...props} />,
};
