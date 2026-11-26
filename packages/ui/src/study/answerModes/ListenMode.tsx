import { resolveCardAudioTarget } from '@flash/core';
import { useContext } from 'react';
import { RubyDisplayContext } from '../../components/RichText.tsx';
import { useApp } from '../../state/AppContext.tsx';
import { cardTextFitClass } from '../fitText.ts';
import { RevealedAnswer } from './AnswerShell.tsx';
import { CardFieldValue } from './CardFieldValue.tsx';
import type { AnswerModePlugin, AnswerModeRenderProps } from './types.ts';

function ListenModeView(props: AnswerModeRenderProps) {
  const { note, deck, layout, noteType, fieldMetaByKey, pinyinToneColors, onSpeak } = props;
  const rubyDisplay = useContext(RubyDisplayContext);
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

      <RevealedAnswer {...props}>
        {layout.front_fields.length > 0 && (
          <div className="flex w-full flex-col items-center gap-2">
            {layout.front_fields.map((fieldKey, idx) => {
              const value = note.fields[fieldKey];
              if (!value) return null;
              const meta = fieldMetaByKey.get(fieldKey);
              return (
                <div
                  key={`front-reveal-${fieldKey}`}
                  data-testid={`back-front-field-${fieldKey}`}
                  className={
                    idx === 0
                      ? `whitespace-pre-wrap font-semibold ${cardTextFitClass(value, 'answer', rubyDisplay)}`
                      : `whitespace-pre-wrap text-[var(--muted)] ${cardTextFitClass(value, 'detail', rubyDisplay)}`
                  }
                >
                  <CardFieldValue
                    fieldKey={fieldKey}
                    value={value}
                    meta={meta}
                    fallbackLang={deck.language}
                    hideRuby={false}
                    pinyinToneColors={pinyinToneColors}
                  />
                </div>
              );
            })}
          </div>
        )}
      </RevealedAnswer>
    </>
  );
}

export const listenAnswerMode: AnswerModePlugin = {
  mode: 'listen',
  capturesFrontInteraction: false,
  render: (props) => <ListenModeView {...props} />,
};
