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

  it('reads only the card, the day, the note fields and the layout parts that shape the options', () => {
    const base = choiceQuestionKey('c1', 10, note, layout);
    // Everything else on the note and layout (id, tags, timestamps, later reveal steps, labels)
    // is outside the key, so an edit there can never reshuffle the open question.
    const richNote = {
      ...note,
      id: 'n1',
      tags: ['a', 'b'],
      updated_at: 99,
      speech_override: 'x',
    };
    const richLayout = {
      ...layout,
      id: 'l1',
      label: 'Quiz',
      reveal_steps: [...layout.reveal_steps, ['word']],
    };
    expect(choiceQuestionKey('c1', 10, richNote, richLayout)).toBe(base);
    // Other notes' content is not an input at all (the key takes no collection state); the
    // render test in choice-question-stable.test.tsx proves it through the real component.
    expect(choiceQuestionKey.length).toBe(4);
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
