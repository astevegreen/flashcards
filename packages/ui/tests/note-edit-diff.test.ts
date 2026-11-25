import { describe, expect, it } from 'vitest';
import { noteEditChanges, parseTagsText } from '../src/components/noteEditDiff.ts';

describe('noteEditChanges (D7)', () => {
  const opening = {
    fields: { word: '사과', meaning: 'apple', example: '사과를 먹어요' },
    tagsText: 'fruit, leech',
  };

  it('sends only the fields that differ from the opening snapshot', () => {
    const changes = noteEditChanges(
      opening,
      { word: '사과', meaning: 'an apple', example: '사과를 먹어요' },
      opening.tagsText,
    );
    expect(changes.fields).toEqual({ meaning: 'an apple' });
    expect(changes.tags).toBeUndefined();
  });

  it('sends nothing when nothing was edited', () => {
    expect(noteEditChanges(opening, { ...opening.fields }, opening.tagsText)).toEqual({
      fields: {},
      tags: undefined,
    });
  });

  it('sends a cleared field and a field that was absent when opened', () => {
    const changes = noteEditChanges(
      opening,
      { ...opening.fields, example: '', speech_override: 'sa-gwa' },
      opening.tagsText,
    );
    expect(changes.fields).toEqual({ example: '', speech_override: 'sa-gwa' });
  });

  it('does not count an empty draft for a field the note never had', () => {
    expect(
      noteEditChanges(opening, { ...opening.fields, hint: '' }, opening.tagsText).fields,
    ).toEqual({});
  });

  it('sends the parsed tags only when the tag text changed', () => {
    expect(noteEditChanges(opening, opening.fields, 'fruit;  red ,').tags).toEqual([
      'fruit',
      'red',
    ]);
    expect(noteEditChanges(opening, opening.fields, '').tags).toEqual([]);
  });

  it('parses comma and semicolon separated tags', () => {
    expect(parseTagsText(' a, b;c ,, ')).toEqual(['a', 'b', 'c']);
  });
});
