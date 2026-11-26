import { resolveCardAudioTarget } from '@flash/core';
import { useApp } from '../../state/AppContext.tsx';
import { RevealedAnswer } from './AnswerShell.tsx';
import type { AnswerModePlugin, AnswerModeRenderProps } from './types.ts';

function ListenModeView(props: AnswerModeRenderProps) {
  const { note, deck, layout, noteType, onSpeak } = props;
  const { audio } = useApp();
  const target = resolveCardAudioTarget(note, layout, noteType, deck);
  const audioAvailable = audio.canPlayAnyAudio(target);

  // Note: StudyScreen owns front auto-play for listen mode so playback is never double-triggered.

  return (
    <>
      <div
        data-testid="listen-prompt"
        className="flex w-full max-w-md flex-col items-center gap-4 pt-6"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--accent-soft)] text-3xl text-[var(--accent)]">
          🔊
        </div>
        <div className="text-sm font-medium text-[var(--muted)]">Listen and recall the meaning</div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            data-testid="listen-play-btn"
            onClick={() => onSpeak?.(1.0)}
            className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            Play Audio <span className="ml-1 text-xs opacity-80">(R)</span>
          </button>
          <button
            type="button"
            data-testid="listen-slow-btn"
            onClick={() => onSpeak?.(0.75)}
            className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-4 py-2 text-sm font-medium hover:bg-[var(--surface-2)]"
          >
            Slow 0.75× <span className="ml-1 text-xs opacity-70">(S)</span>
          </button>
        </div>
        {!audioAvailable && (
          <p className="text-xs text-[var(--muted)]">
            No audio source or speech synthesis is available on this device. Tap Show Answer to view
            text.
          </p>
        )}
      </div>

      <RevealedAnswer {...props} showFrontFields />
    </>
  );
}

export const listenAnswerMode: AnswerModePlugin = {
  mode: 'listen',
  capturesFrontInteraction: false,
  render: (props) => <ListenModeView {...props} />,
};
