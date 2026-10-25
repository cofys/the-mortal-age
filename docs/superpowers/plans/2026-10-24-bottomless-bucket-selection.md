# Bottomless compost bucket selection

Filling searches for the first bucket by name, while fertilising searches for the first matching item ID. With multiple buckets, both can mutate or use a different bucket from the one selected in the packet.

Source: [bottomless compost bucket](https://oldschool.runescape.wiki/w/Bottomless_compost_bucket) holds a single compost type and grants two charges per bucket of compost. Its contents belong to the selected item, not an earlier inventory item.

1. Reproduce through the attached item-on-item and item-on-object handlers, real inventories and real patch fertilising. Cover both item-use orientations, same-ID buckets with different contents, bin collection and stale slots.
2. Carry the validated inventory slot through the existing bottomless-bucket paths. Charge and consume only the selected item; reject a missing or mismatched item without falling back to another bucket.
3. Build, run focused and full server tests, obtain independent review, and open a separate upstream PR.

Only this chat's isolated branch `fix/farming-bottomless-bucket-selection` is changed. No core/client/generated data, live saves, deployment or other chats' work. Fixtures capture plugin registration and use in-memory handlers; live rendering and save/relog are not tested. Existing one-at-a-time filling, capacity and compost rules are preserved.
