import type {
  AnswerMode,
  Card,
  CollectionState,
  Deck,
  Layout,
  Note,
  NoteType,
  ReviewRating,
} from '@flash/core';
import type { ReactNode } from 'react';

export interface FieldMeta {
  label: string;
  lang: string;
  kind: string;
}

export interface AnswerEvaluation {
  correct: boolean;
  suggestedRating: ReviewRating;
  typedAnswer?: string;
}

export interface AnswerModeRenderProps {
  state: CollectionState;
  card: Card;
  note: Note;
  deck: Deck;
  layout: Layout;
  noteType: NoteType | undefined;
  fieldMetaByKey: ReadonlyMap<string, FieldMeta>;
  populatedRevealSteps: readonly (readonly string[])[];
  revealStep: number;
  isRevealed: boolean;
  isFullyRevealed: boolean;
  hideFrontRuby: boolean;
  pinyinToneColors: boolean;
  studyDayIndex: number;
  evaluation: AnswerEvaluation | null;
  onRevealNext: () => void;
  onEvaluateAndReveal: (evaluation: AnswerEvaluation) => void;
  onSpeak?: (rate?: number) => void;
}

export interface AnswerModePlugin {
  readonly mode: AnswerMode;
  /** When true, StudyScreen suppresses tap-on-card-to-flip and card swipe before reveal so inputs/buttons work cleanly. */
  readonly capturesFrontInteraction: boolean;
  render(props: AnswerModeRenderProps): ReactNode;
}
