# Death storage reclaim capacity

Fix the confirmed overflow loss without changing death rules or fee pricing. Read-only reproduction with a new in-memory Player: inventory 2,147,483,640 Coins plus Office 100 Coins; taking 100 reports 100 taken, deletes the Office stack and leaves only 2,147,483,647 in inventory (93 lost).

Source: [OSRS Wiki stack limit](https://oldschool.runescape.wiki/w/Stackable_items#Limit_of_a_stack) states that exceeding 2,147,483,647 acts as insufficient inventory space. The progress tracker requests safe reclaim transactions and inventory validation. ItemContainer.add clamps overflowing stacks; the death-storage callers incorrectly treat an existing item ID as unlimited room, including metadata-incompatible stacks.

1. Add real Player/Inventory regressions for partial stack space, full stacks, metadata isolation, UI-selected reclaim fees and Take-All planning. Confirm intended failures before source changes.
2. Add a generic read-only ItemContainer.getAddableAmount foundation matching add's stack/metadata/slot rules. Use it for authoritative Office transfer and UI fee/Take-All capacity calculations. Plan Take-All against a copied inventory so prior planned moves reserve capacity.
3. Use the same capacity check for the equivalent grave fits check, preserving the grave's existing whole-entry retrieval behavior. Never delete a storage entry that cannot be added.
4. Build and run focused reclaim, existing gravestone, kept-on-death and container regressions. Request independent review, address findings, then commit/push one focused ready PR.

Ownership: Codex in tsps-pr856-merge, branch fix/death-office-stack-capacity, starting from upstream e7ff37b6129abd2c205c44f069ce631e771ea6ec. No generated data, saves, main deployment or Claude-owned clue/NPC Indicator work changes.
