import { describe, expect, it } from 'vitest';
import { choiceQuestionKey } from '../src/study/answerModes/ChoiceMode.tsx';
import { dueCountsText, studyAnnouncementText } from '../src/study/StudyAnnouncer.tsx';

describe('studyAnnouncementText (§10)', () => {
  it('names the next card, the revealed answer and its step, and the end of the queue', () => {
    expect(studyAnnouncementText({ caughtUp: false, revealStep: 0, totalRevealSteps: 2 })).toBe(
      'Next card.',
    );
    expect(studyAnnouncementText({ caughtUp: false, revealStep: 1, totalRevealSteps: 1 })).toBe(
      'Answer shown.',
    );
    expect(studyAnnouncementText({ caughtUp: false, revealStep: 2, totalRevealSteps: 3 })).toBe(
      'Answer shown, step 2 of 3.',
    );
    expect(studyAnnouncementText({ caughtUp: true, revealStep: 0, totalRevealSteps: 0 })).toBe(
      'No more cards to study right now.',
    );
  });
});

describe('dueCountsText (§10)', () => {
  it('reads the three chips as one labelled sentence', () => {
    expect(dueCountsText({ new: 3, learning: 0, due: 12 })).toBe(
      '3 new, 0 learning, 12 due for review',
    );
  });
});

describe('choiceQuestionKey (§11)', () => {
  const note = { fields: { word: '사과', meaning: 'apple' } };
  const layout = { answer_field: 'meaning', reveal_steps: [['meaning']] };

  it('stays the same when only other notes change, so a sync does not reshuffle options', () => {
    // The key only reads this card's note and layout: equal inputs, equal key.
    expect(choiceQuestionKey('c1', 10, { fields: { ...note.fields } }, { ...layout })).toBe(
      choiceQuestionKey('c1', 10, note, layout),
    );
  });

  it('changes with the card, the study day, an edit of its note, or its layout', () => {
    const base = choiceQuestionKey('c1', 10, note, layout);
    expect(choiceQuestionKey('c2', 10, note, layout)).not.toBe(base);
    expect(choiceQuestionKey('c1', 11, note, layout)).not.toBe(base);
    expect(
      choiceQuestionKey('c1', 10, { fields: { ...note.fields, meaning: 'an apple' } }, layout),
    ).not.toBe(base);
    expect(choiceQuestionKey('c1', 10, note, { ...layout, answer_field: 'word' })).not.toBe(base);
  });
});
