# Shop payments must fit before a sale commits

## Evidence and failure

The progress tracker's Alternative currencies item leaves transaction-edge and persistence checks open. Real native301:0 Sell1 input reproduced loss for both coins and registered Tokkul: at2,147,483,647 currency, the sale removed its item and increased shop stock, while Inventory.add clamped the payment away. The same setup's ordinary sale and Bank/save round trip already succeeded. The retained initial regression result was2 failures/1 pass.

The OSRS Wiki [Items](https://oldschool.runescape.wiki/w/Items) documents the signed32-bit per-container item limit. [Tokkul](https://oldschool.runescape.wiki/w/Tokkul) documents selling ores/gems and runes to Mor Ul Rek shops. Cache241 and shipped definitions identify6529/Tokkul,1623/uncut sapphire, NPC2184 and shop1468. The local RSProx index has9 merchant Trade attempts in6 recordings, revisions227/237, all special worlds: they show shopmain/shopside and the native selling operations, not normal-world prices or an overflow outcome.

## Transaction path and fix

Native side-inventory widget301:0 -> NetworkBuilder widget dispatcher -> ShopManager.handleWidgetAction -> handleItemContainerAction -> sellItem -> receipt preflight -> actual Inventory slot deletion/currency add -> stock/client refresh.

ShopManager owns session, sale quantity and stock. Inventory owns metadata-compatible stack selection, capacity, deletion and bounded addition. Bank and PlayerSave own real transfers and durability. A currency ID being present does not establish that a new default-metadata currency Item can merge with it, or that the matching stack has room.

The preflight constructs a real Inventory backed by getCopiedItems(), previews exactly the same ordered slot deletions as the intended sale, and asks the shared getAddableAmount() whether the complete payment fits afterward. Refusal occurs before any live item or stock mutation. The copied Items clone nested metadata through their constructor; their deletion cannot alter live references or metadata. Inventory construction has no player side effects, and the preview never refreshes or emits an item-container packet.

This handles built-in coin/blood-money receipt and registered item currencies generically. Point currencies keep their existing balance-owner path. Receipt validation uses the actual destination inventory, so a full stack in the bank does not block a payable inventory sale.

## Checks

- Build: `node node_modules/typescript/bin/tsc --build`, success.
- Seven new real-cache/all-plugin tests use real Player, ClientConnection, Inventory, Bank, PlayerSave, shipped ShopDefinitionLoader and native side-widget actions. They cover coin/Tokkul cap refusal and repeat input, exact fit, one over capacity, the last slot freed by a sale, a partial noted-stack sale that cannot free a slot, and Bank-returned metadata currency that cannot merge with incoming default currency. Selling the entire noted stack then legitimately frees a slot and succeeds while preserving the tagged currency.
- Focused shop/currency suites:25/25; full server suite:9,481/9,481, zero failures/skips.
- Independent Codex reviewer traced actual Item cloning, deletion/add rules, shop session ownership, Bank and save code. Their chosen multi-slot native sale preserves all live identities/nested metadata on refusal, then actual Bank deposit500/withdraw100 creates headroom; native retry sells three axes for exactly the quoted payment, stale repeat input cannot duplicate, and fresh PlayerSave retains wallet/bank. Their extra scenario passes1/1 and shop/currency/bank-space foundations35/35, with no findings in inspected paths.
- Frozen source SHA631fd1144653c98e36d5702b16d879532c74f712e08d497b8c0a65bc5209d0a3; new test a7fc94e9143169cafd9c5a0b6c792cd141481a3f3e90ca3bda38316c5fee731f; base3db6065a5a4fa668be09e2eb887a2a901f87ba7d.

## Native rendering walkthrough

On isolated slot7, disposable shopcapqa was seeded with max Tokkul and one sapphire beside the existing spawned merchant. Merchant Trade was opened through agent MCP; Sell1 was selected with the rendering client's native right-click menu. The inventory-space refusal rendered and observation retained both the sapphire and2,147,483,647 Tokkul.

The real bank was opened through the QA command; native Deposit-All moved the entire currency stack into it, leaving the sapphire. Native Close was used, the merchant reopened through agent MCP, and the same native Sell1 action succeeded: sapphire removed,21 Tokkul paid at the current configured price. Images and state are retained locally as task `.runtime/shop-capacity-*` artifacts. This distinguishes seeded items/API-opened interfaces from actual native sale/deposit/close input.

The test server saved/shut down through gameUpdate. Its client tree was stopped only after verifying port/command ancestry; tab and MCP helper closed. Ports3107/43707/49807 were confirmed closed and this worktree's slot7 reservation cleared. No live game, Claude files or other services were changed.

## Limits

The existing inventory-space refusal is retained. An official exact overflow message or partial-sale-at-cap policy was not found in the recordings; refusing the complete requested sale follows the existing transaction-space refusal and preserves items. This change does not establish shop-price parity, invent a universal point-currency cap or change the balance owner for any minigame.
