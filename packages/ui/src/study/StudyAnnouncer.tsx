import { useState } from 'react';

export interface StudyAnnouncementState {
  caughtUp: boolean;
  revealStep: number;
  totalRevealSteps: number;
}

/** What the screen reader hears as the study flow moves on (§10). */
export function studyAnnouncementText({
  caughtUp,
  revealStep,
  totalRevealSteps,
}: StudyAnnouncementState): string {
  if (caughtUp) return 'No more cards to study right now.';
  if (revealStep <= 0) return 'Next card.';
  if (totalRevealSteps > 1) return `Answer shown, step ${revealStep} of ${totalRevealSteps}.`;
  return 'Answer shown.';
}

export interface StudyAnnouncerProps extends StudyAnnouncementState {
  cardId: string | undefined;
}

/**
 * A polite live region that announces revealing a card and moving to the next one. Two cards in a
 * row read the same "Next card.", so each new card flips a trailing no-break space: the text
 * changes and the screen reader speaks it again.
 */
export function StudyAnnouncer({ cardId, ...state }: StudyAnnouncerProps) {
  const [seen, setSeen] = useState({ cardId, serial: 0 });
  if (seen.cardId !== cardId) setSeen({ cardId, serial: seen.serial + 1 });
  const text = studyAnnouncementText(state) + (seen.serial % 2 === 1 ? ' ' : '');
  return (
    <p data-testid="study-announcer" role="status" aria-live="polite" className="sr-only">
      {text}
    </p>
  );
}
