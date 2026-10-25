# Leprechaun secateurs storage

The official 16 May 2019 Farming Improvements update allows up to 100 normal or magic secateurs, but explicitly forbids mixing the two kinds. The current storage helper only shares the numerical cap and accepts both kinds together.

1. Reproduce both mixed deposit directions, including noted normal secateurs and Deposit-all. Verify same-kind capacity, zero-count switching and unrelated tools.
2. Refuse a secateurs deposit when a different secateurs kind has a positive stored count, before consuming input. Preserve existing saved contents and withdrawal behavior.
3. Build, run focused/model tests and full suite, get independent review, then a separate PR from upstream main.

Sources: https://oldschool.runescape.wiki/w/Update:Farming_Improvements_and_Rebalancing_Existing_Content and https://oldschool.runescape.wiki/w/Tool_Leprechaun . No new schema or native storage interface.
