# Native Tithe Farm rewards

Gricoller's Rewards opens the cache Omnishop main and inventory side panel. This branch is stacked on #1301 for native Farming option dialogues.

## Evidence

- Cache 241: shop row tithe_shop_data 4981, stock rows 4983–4998, currency row 4982 and native groups 819/806. Prices, body variants, restrictions, noted compost and transaction multipliers come from those rows.
- Shared Omnishop protocol is also seen in Mixology captures 238/04210, 238/04234 and 238/04235, plus Leagues recording 237/01107; these are not recordings of a Tithe purchase. Indexed Gricoller captures 229/00648 and 231/03028 do not show a reward transaction.
- Wiki Tithe Farm/Rewards, Gricoller's can and Auto-weed supply the purchase requirements, twenty blessings per point, 80% outfit refunds, free refill and one-time Auto-weed unlock.

## Behaviour

The shared shop owns display and native purchase quantities. Farming supplies canonical saved Tithe points, permissions, descriptions and grants. The generated Gricoller shop binding runs before generic NPC hooks; a Farming onCanShop handler redirects that canonical shop to Omnishop, following the Soul Wars pattern. It refuses the legacy shop even when no accessible nearby Gricoller can be found. Generated shop data and core dispatch remain unchanged.

Rewards use exact cache prices and body-type variants. Herb sack checks base 58 Herblore and existing storage items; seed packs retain generated tier-three metadata. Compost is noted, blessings grant 20 per point after Bologa, the can has 1000 water doses, and free refill preserves its other metadata. Auto-weed costs 50 once and toggles freely afterward, with no dummy inventory or collection-log reward. Returning any of the eight outfit variants through item-on-NPC gives 80% of its cache price, with exact-item and metadata guards.

Every purchase checks the live session, original Farming state, NPC distance, status, hitpoints, placement, teleport/force movement, inventory capacity and stack cap before payment. Points and unlocks are saved and native point/weed bits are resent at login.

## Verification

Real Player, Inventory, NPC, PacketSender, ClientConnection and all plugins. Native dialogue/widget paths exercise purchase quantities, base levels, full inventories, caps, duplicate storage items, generated pack metadata, refill metadata, virtual unlocks, refunds, stale clicks and collection logging. Historical reward/Herb sack tests are updated to this native fixture rather than calling the removed menu.

Independent Codex review found missing alternate-body refunds and dropped assertions in the test migration; both were corrected and re-reviewed. Native MCP found the generated-shop interception; the shared guard repair was tested and independently reviewed. Actual Gricoller Rewards opens 819+806, points 0 are displayed and a real buy click says You don't have enough Tithe points. Client cache sweeps report no VM errors, zero item ids or null text. Final full-suite counts are in the PR.

Final full suite: 8,218/8,218 passed, no failures or skips.
