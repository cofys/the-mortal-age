# Shop payment capacity

The progress tracker leaves alternative-currency edge/persistence checks open. Initial tracing found that ShopManager.canReceivePayment accepts an existing currency ID or free slot, while the real Inventory.add clamps a matching stack at MAX_STACK_AMOUNT and merges only equal metadata. A sale can therefore remove its item before discovering that the actual payment cannot fit.

## Path and state owners

Native shop side-inventory operation -> NetworkBuilder.widget_action -> ShopManager.handleWidgetAction -> handleItemContainerAction -> sellItem -> actual Inventory deletion/add and shared currency handler -> shop stock/client refresh. ShopManager owns the active session and quantities; Inventory owns metadata-aware stack capacity and slot mutations; PlayerSave/Bank own durable item transfers. A currency ID existing somewhere is insufficient proof that the actual incoming default item can merge.

## Work

1. Reproduce through real cached shops, Player/Inventory/ClientConnection and native side widget301:0. Check underlying container capacity independently. Retain RED before changing source.
2. If confirmed, preview exactly the intended slot deletions on copied Items in a real Inventory and call its shared getAddableAmount for the full payment. Refuse before mutating inventory or stock if the complete payment cannot fit. Keep prices, policy hooks and currency ownership unchanged.
3. Test full/near-cap/exact-fit currencies, a last freed slot, a sale that leaves its source stack occupied, metadata-isolated payment stacks, real Bank transfers and saved fresh login. Preserve successful ordinary purchases/sales and both item and point currency handling.
4. Verify native client display/refusal and success on an isolated server. Independent Codex reviewer must choose an adversarial native/shared-system transition and inspect Inventory/Bank/save implementations. Build, targeted checks and full suite before a separate ready PR.
5. Stop own client/server/helpers and clear the assigned slot. Do not touch Claude's work or the live game.

## Evidence limits

The Wiki Tokkul page establishes selling runes/gems to Mor Ul Rek shops; Items documents the signed32-bit stack limit. Cache241 and the real shipped definitions establish item/shop/native input IDs. An official exact overflow-refusal message is not yet recorded; retain the existing inventory-space refusal and disclose that limit. This change is about transaction conservation, not shop-price parity or a new universal points cap.
