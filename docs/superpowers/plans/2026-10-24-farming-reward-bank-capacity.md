# Farming reward bank capacity

Herb-box Bank-all checks only free slots or an existing item ID, so a full stack or metadata-incompatible stack can refuse/clamp the addition after the reward is removed. A partial transfer also returns before changing the box to its opened variant.

Sources: [Herb box](https://oldschool.runescape.wiki/w/Herb_box) rolls seven herbs and supports Bank-all; [stack limit](https://oldschool.runescape.wiki/w/Stackable_items#Limit_of_a_stack) treats excess as insufficient space.

1. Reproduce with the actual reward handler and real inventory/bank using valid seven-roll box contents. Cover stack caps, partial/resumed transfer, metadata-incompatible full banks, successful exhaustion and partial inventory Take-all.
2. Require full capacity for each reward entry before adding it to the existing destination bank. Stop without removing an uncredited entry. Finalize the box's opened/exhausted state after partial transfers; keep untouched boxes closed.
3. Build, run focused/full tests, obtain independent review and publish separately from the container-bank Empty PR.

Scope: this chat's isolated `fix/farming-reward-bank-capacity` branch directly from upstream main. Existing reward generation, bank destination and action availability remain unchanged. No generated data, live saves, deployment or other chats' work. Fixtures do not verify live rendering or disk persistence.
