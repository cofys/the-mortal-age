# Farming container bank Empty

**Goal:** Restore native bank-side Empty for herb sacks and seed boxes using the existing bank item-operation event.

**Architecture:** Farming owns its existing item-metadata contents. Attach a named handler to `Bank.INVENTORY_OP_EVENT`, following the bank-side op9/param595 convention already documented and used by StorageItems. Validate bank state and the selected item, move only what each target bank stack accepts, then refresh the bank and inventory.

Sources: [Herb sack](https://oldschool.runescape.wiki/w/Herb_sack) empties into the bank while banking; [Seed box](https://oldschool.runescape.wiki/w/Seed_box) supports direct bank emptying. Cache operation mapping is established in `items/storage/Events.StorageItems.js` and `Bank.handleWidgetAction`.

1. Reproduce with the real bank widget dispatcher, registered Farming events, Player, Inventory and Bank. Cover both open/closed variants, stack limits, tabs/placeholders, full banks and invalid actions.
2. Add a Guild.Farming named handler and attach it through Patches.Farming. Keep exact unbanked remainders in metadata and leave the container in inventory.
3. Build, run focused/full tests, obtain independent review and publish a separate upstream PR.

Scope: this chat's isolated `fix/farming-container-bank-empty` branch from upstream main. No core/client or generated data edits, no storage schema migration, no live saves or deployment, and no other chats' work. This covers the bank-side operation, not deposit boxes or the missing dedicated container UI. Fixtures do not verify live rendering or disk persistence.
