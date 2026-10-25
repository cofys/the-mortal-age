# Hespori reclaim currency

Arno's Collect callback resolves `Data.itemId("Coins")` to quest coins (617), so an inventory containing ordinary currency (995) cannot pay the documented 25,000-coin reclaim fee.

Source: [OSRS Wiki Arno](https://oldschool.runescape.wiki/w/Arno). Cache-backed `core.ItemIdentifiers.COINS` supplies the currency ID.

1. Reproduce through the real Hespori handler with in-memory Player/Inventory fixtures. Cover payment, insufficient funds, already-paid collection, repeated confirmation and distance validation.
2. Replace only the currency lookup in the payment check and deduction.
3. Build, run focused Farming tests and the server suite, request independent review, then publish this fix as its own PR.

Ownership: this chat's isolated checkout, branch `fix/farming-hespori-reclaim-currency`, based on upstream `106b6f141`. Other PR branches, live saves, generated data and other chats' work remain outside this change. Menu presentation and live persistence are not exercised by the fixtures.
