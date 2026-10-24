# Goblin book

The item plugin handles the cache's `Goblin book` / `Read` action with the shared two-page book interface (392). The actual book is item 10999; 11000 is its banknote and 17850 its bank placeholder, whose cache actions contain no Read option. Reading keeps the book and grants no reward.

The six spreads in `server/plugins/items/data/goblin-book.js` reproduce the reporter-supplied transcript and six screenshots of pages 1–12, supplied on 23 October 2026. The original Jagex wording, paragraph spacing, line breaks and page boundaries are retained, including sentences that continue across pages. All three section headings use the existing dark-red text colour; the final heading spans two lines as shown in the supplied image. The shortened lore adaptation has been removed.

The supplied transcript is retained separately in `server/tests/fixtures/goblin-book-transcript.txt`. A regression compares the complete displayed text against it, normalizing only whitespace, colour tags and a word hyphenated across screenshot lines. The screenshot page boundaries are independently pinned in the reader tests. Jagex retains copyright in the game text; these files transcribe material supplied by the reporter, not original project-authored lore.

Behavior and lore source: [OSRS Wiki: Goblin book](https://oldschool.runescape.wiki/w/Goblin_book). Cache inspection establishes the item actions and note/placeholder relationships. No generated item or drop data is changed.

Verification: `cd server && node --test tests/goblin-book.test.cjs` after building. Tests read through all six spreads, check both page numbers and first/last navigation limits, move back, close and reopen, clear trailing text from shorter pages, preserve inventory, compare the complete transcript and screenshot page boundaries, and verify that notes/placeholders have no Read action. These checks verify content and emitted interface state; they do not constitute a fresh native-client screenshot comparison.
