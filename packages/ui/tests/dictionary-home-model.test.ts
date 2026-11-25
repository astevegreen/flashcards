import { describe, expect, it } from 'vitest';
import {
  createLatestSearch,
  directionTargetName,
  MAX_RECENT_LOOKUPS,
  partOfSpeechLabel,
  pushRecentLookup,
  topicLabel,
} from '../src/dictionary/dictionary-home-model.ts';

describe('dictionary home model', () => {
  it('keeps recent lookups newest first, deduplicated and capped', () => {
    expect(pushRecentLookup(['학교', '먹다'], '먹다')).toEqual(['먹다', '학교']);
    expect(pushRecentLookup(['학교'], '  ')).toEqual(['학교']);
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).reduce<string[]>(
      (acc, w) => pushRecentLookup(acc, w),
      [],
    );
    expect(many).toHaveLength(MAX_RECENT_LOOKUPS);
    expect(many[0]).toBe('w19');
  });

  it('labels topics in English where known, and Korean otherwise', () => {
    expect(topicLabel('음식 주문하기')).toBe('Ordering food · 음식 주문하기');
    expect(topicLabel('식생활')).toBe('Food and eating · 식생활');
    expect(topicLabel('알 수 없는 주제')).toBe('알 수 없는 주제');
    expect(partOfSpeechLabel('verb')).toBe('Verbs');
    expect(partOfSpeechLabel('mystery')).toBe('mystery');
  });

  it('names the target language on the direction toggle, Korean first', () => {
    expect(directionTargetName(['ja', 'ko'])).toBe('한국어');
    expect(directionTargetName(['zh-Hans'])).toBe('中文');
    expect(directionTargetName([])).toBe('Target');
  });

  it('applies only the newest search, whatever order they finish in (C15)', async () => {
    const applied: string[][] = [];
    const busy: boolean[] = [];
    const run = createLatestSearch<string>(
      (r) => applied.push(r),
      (b) => busy.push(b),
    );
    let finishSlow: (r: string[]) => void = () => {};
    const slow = run(() => new Promise<string[]>((resolve) => (finishSlow = resolve)));
    const fast = run(async () => ['학교']);
    await fast;
    finishSlow(['stale']);
    await slow;
    expect(applied).toEqual([['학교']]);
    expect(busy.at(-1)).toBe(false);

    // A failed search shows nothing instead of rejecting; clearing the query ends Searching….
    await run(async () => {
      throw new Error('pack read failed');
    });
    expect(applied.at(-1)).toEqual([]);
    let finishPending: (r: string[]) => void = () => {};
    const pending = run(() => new Promise<string[]>((resolve) => (finishPending = resolve)));
    await run(null);
    finishPending(['late']);
    await pending;
    expect(applied.at(-1)).toEqual([]);
    expect(busy.at(-1)).toBe(false);
  });
});
