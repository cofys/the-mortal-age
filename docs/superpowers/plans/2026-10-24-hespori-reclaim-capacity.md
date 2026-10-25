# Hespori reclaim capacity

The Collect loop shifts a saved entry before `Inventory.addItem`, which can accept only part of it. A nearly capped stack or a multi-item unstackable entry therefore loses its remainder. Checking free slots also blocks a matching stack in a full inventory.

Sources: [Arno](https://oldschool.runescape.wiki/w/Arno) returns stored Hespori items; [stack limit](https://oldschool.runescape.wiki/w/Stackable_items#Limit_of_a_stack) treats excess beyond 2,147,483,647 as insufficient room.

1. Reproduce through the real Collect handler using paid storage and real Player/Inventory fixtures: partial/full stacks, full inventory, unstackable batches and metadata isolation.
2. Use the existing generic `getAddableAmount` API. Add only the amount that fits; remove only that amount from storage. Continue past blocked entries so later matching stacks remain collectable.
3. Build and run focused/full tests; obtain independent review and publish a separate PR based directly on upstream main.

Scope: plugin reclaim capacity only. No currency change (a separate PR), core edits, live saves, generated data, other chats' branches or services. This preserves partial retrieval through the existing menu and does not implement the OSRS retrieval interface. Fixtures exercise handlers and real inventory, not live rendering or a save/relog roundtrip.
