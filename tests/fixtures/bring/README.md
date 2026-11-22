# Bring my cards fixtures

Inputs for `tests/e2e/phase14-bring-my-cards.spec.ts` (Phase 14 guided import):

- `flashcards-deluxe.txt`: a tab-separated Flashcards Deluxe export with `Text 1..3` and
  `Category 1` columns, saved with a `.txt` extension the way Flashcards Deluxe names them.

The Anki packages live in `../anki/` (built by `scripts/build-anki-fixtures.mjs`); the spec builds
its `.flashpkg` in memory with `exportFlashpkg`.
