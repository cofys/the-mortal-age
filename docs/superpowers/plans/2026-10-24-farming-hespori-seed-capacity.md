# Hespori seed reward capacity

The Wiki Hespori seed page says players receive no seed when inventory cannot hold one. The current reward helper instead registers a ground item, and announces success even when its inventory grant fails at a capped stack.

1. Reproduce full-inventory ground fallback and capped/failed-grant success messages. Verify existing-stack delivery, normal success, losing rolls, Arno's opt-out and the independent pet event.
2. Require actual addable inventory capacity and a successful grant before announcing the seed. Remove the Farming ground fallback without editing ground-item lifecycle code or seed probabilities.
3. Build, run focused/model tests and full suite, independent review, then a separate PR from upstream main.

Source: https://oldschool.runescape.wiki/w/Hespori_seed . Tangleroot chances and seed drop rates remain unchanged.
