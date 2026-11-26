import { describe, expect, it, vi } from 'vitest';
import { createBackButtonHandler, type BackButtonDeps } from '../src/layout/backButton.ts';

function deps(over: Partial<BackButtonDeps> = {}) {
  const d = {
    topDialog: vi.fn<BackButtonDeps['topDialog']>(() => undefined),
    ariaModal: vi.fn<BackButtonDeps['ariaModal']>(() => undefined),
    sendEscape: vi.fn<BackButtonDeps['sendEscape']>(),
    onStudyTab: vi.fn(() => true),
    goToStudy: vi.fn(),
    ...over,
  };
  return d;
}

describe('Android Back (C12)', () => {
  it('asks the top dialog to close through requestClose when it can, so it can confirm', () => {
    const dialog = { close: vi.fn(), requestClose: vi.fn() };
    const back = createBackButtonHandler(deps({ topDialog: () => dialog }));
    expect(back()).toBe(true);
    expect(dialog.requestClose).toHaveBeenCalledOnce();
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it('moves on when an ARIA modal ignores Escape, instead of swallowing Back for good', () => {
    const modal = {};
    const d = deps({ ariaModal: () => modal, onStudyTab: () => false });
    const back = createBackButtonHandler(d);
    expect(back()).toBe(true);
    expect(d.sendEscape).toHaveBeenCalledWith(modal);
    // Still open: the second press goes to Study, and a third would minimize from there.
    expect(back()).toBe(true);
    expect(d.goToStudy).toHaveBeenCalledOnce();
    expect(d.sendEscape).toHaveBeenCalledOnce();
  });

  it('returns false on Study with nothing open, so the shell minimizes the app', () => {
    expect(createBackButtonHandler(deps())()).toBe(false);
  });

  it('sends Escape again to a new modal', () => {
    let modal: object = {};
    const d = deps({ ariaModal: () => modal });
    const back = createBackButtonHandler(d);
    back();
    modal = {};
    back();
    expect(d.sendEscape).toHaveBeenCalledTimes(2);
  });
});
