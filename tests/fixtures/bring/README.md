# Bring my cards fixtures

Inputs for `tests/e2e/phase14-bring-my-cards.spec.ts` (Phase 14 guided import):

- `flashcards-deluxe.txt`: a tab-separated Flashcards Deluxe export with `Text 1..3` and
  `Category 1` columns, saved with a `.txt` extension the way Flashcards Deluxe names them.
- `korean-words.xlsx`: a minimal Excel workbook (one sheet, inline strings) with the Korean
  headers `단어, 뜻, 예문, 주제` and two rows (사과 / apple, 물 / water), for the column-mapping
  step. Built with `fflate` from the five OOXML parts `read-excel-file` needs; it is 1.6 KB.

The Anki packages live in `../anki/` (built by `scripts/build-anki-fixtures.mjs`); the spec builds
its `.flashpkg` in memory with `exportFlashpkg`.
