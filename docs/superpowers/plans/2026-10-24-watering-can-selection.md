# Watering can selection

Manual watering passes only the can ID into a first-match inventory search. With two identical charged cans, using the second waters the target but spends the first can's dose.

Source: [Watering can](https://oldschool.runescape.wiki/w/Watering_can) holds eight doses used on patches and seedlings; [Tithe Farm](https://oldschool.runescape.wiki/w/Tithe_Farm) explicitly supports carrying multiple watering cans. IDs and charge variants come from the cache.

1. Reproduce with real inventories through registered seedling/patch handlers and a Tithe plot. Cover both item-use orientations, the final dose and a missing/mismatched selected slot.
2. Thread the selected inventory slot through manual watering callers. Validate that slot and ID without falling back to a different can. Preserve the no-slot search used by automatic Water actions.
3. Build, run focused/full tests, obtain independent review and publish a separate upstream PR.

Scope: isolated branch `fix/farming-watering-can-selection` directly from upstream main. No probabilities, generated data, live saves, deployment or other-chat work. Fixtures stub scenery packet/registration effects; live rendering and disk save/relog are not exercised.
