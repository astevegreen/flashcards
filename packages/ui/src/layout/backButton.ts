/**
 * The Android hardware/gesture Back button (phones only, loaded lazily). Closes the topmost modal
 * dialog, else asks the topmost ARIA modal to close with Escape, else returns to Study, else
 * returns false so the native shell minimizes the app.
 */

export interface BackDialog {
  close(): void;
  /** Fires `cancel` first, so a dialog can ask before it drops unsaved edits (C11). */
  requestClose?: () => void;
}

export interface BackButtonDeps {
  topDialog: () => BackDialog | undefined;
  /** The topmost open ARIA modal (not a native `<dialog>`). */
  ariaModal: () => object | undefined;
  /** Sends Escape to that modal. */
  sendEscape: (modal: object) => void;
  onStudyTab: () => boolean;
  goToStudy: () => void;
}

export function createBackButtonHandler(deps: BackButtonDeps): () => boolean {
  // The ARIA modal Back last sent Escape to. If it is still open on the next press, it ignores
  // Escape, so Back moves on instead of being swallowed for good (C12).
  let escapedModal: object | undefined;
  return () => {
    const dialog = deps.topDialog();
    if (dialog) {
      if (dialog.requestClose) dialog.requestClose();
      else dialog.close();
      return true;
    }
    const modal = deps.ariaModal();
    if (modal && modal !== escapedModal) {
      escapedModal = modal;
      deps.sendEscape(modal);
      return true;
    }
    escapedModal = undefined;
    if (!deps.onStudyTab()) {
      deps.goToStudy();
      return true;
    }
    return false;
  };
}

/** The browser-side lookups for `createBackButtonHandler`. */
export function domBackButtonDeps(
  onStudyTab: () => boolean,
  goToStudy: () => void,
): BackButtonDeps {
  return {
    topDialog: () => {
      const open = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
      return open[open.length - 1];
    },
    ariaModal: () => {
      const modals = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
      return modals[modals.length - 1];
    },
    sendEscape: (modal) => {
      (modal as Element).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    },
    onStudyTab,
    goToStudy,
  };
}
