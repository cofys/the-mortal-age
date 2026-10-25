# Leprechaun noting capacity

Produce is deleted before the note stack is added, so stack clamping can lose the excess. Preserve the existing all-produce exchange: refuse the exchange if all notes cannot fit.

Sources: [Tool Leprechaun](https://oldschool.runescape.wiki/w/Tool_Leprechaun) exchanges harvested produce into notes; [stack limit](https://oldschool.runescape.wiki/w/Stackable_items#Limit_of_a_stack) treats overflow as insufficient room.

1. Reproduce through the actual item-on-NPC handler and real inventory. Cover overflow, exact fit, full bags, incompatible metadata and ordinary herb/branch noting.
2. Follow the existing DeathsOffice capacity-preview pattern on copied items. Remove produce from the preview without refreshing, and check the complete note output with `getAddableAmount` before mutating the live inventory.
3. Build; run focused and complete server tests; request independent review; publish one PR from upstream main.

Only this chat's isolated branch `fix/farming-leprechaun-noting-capacity` is changed. No generated data, live saves, other chats' work or deployments. Tests exercise in-memory handlers and inventory, not live dialogue rendering or save/relog.
