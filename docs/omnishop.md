# Omnishop

Jagex's shared reward shop interface: `omnishop_main` (819) with `omnishop_side` (806). The cache describes every omnishop in DB tables:

- `omnishop_shop_data` (39): name, stock rows, currencies, info title
- `omnishop_stock_data` (40): obj, cost pairs, restricted, sellable, sold noted, transaction multiplier
- `omnishop_currency_data` (41): obj or none, names, graphic

The interface draws itself from those tables. `server/plugins/interface/Omnishop.plugin.js` opens a shop, keeps the selection varps and balances right, and does the buying and selling. Mixology Rewards is the first shop on it. Other omnishops in the cache (Tithe Farm, Castle Wars, Bounty Hunter, Trouble Brewing, Forestry, abyssal pearls) can move onto it the same way.

## Plugging a shop in

| Event | Payload | Who answers |
| --- | --- | --- |
| `omnishop:open` | `{ player, shop }`, where `shop` is the DB row's gameval name | anyone opening it |
| `omnishop:currency` | `{ player, shop, currency, balance, set }` | the owner, for currencies with no obj: set `balance` and a `set(value)` |
| `omnishop:describe` | `{ player, shop, stock, description }` | the owner: the info text, which the cache doesn't carry |
| `omnishop:can-buy` | `{ player, shop, stock, itemId, cancel, unlock }` | before payment: `cancel` refuses (the owner sends the message); `unlock` needs no inventory space |
| `omnishop:purchase` | `{ player, shop, stock, itemId, handled }` | after payment: `handled` means nothing is handed over |

A currency with an obj is that item in the inventory, and the plugin handles it itself.

## Protocol

From rsprox captures of Mixology Rewards (recordings 1107, 4182, 4210, 4234, 4235) and other omnishops (4288):

- **Open:** varps `omnishop_lastshop` (3874) = shop row and `omnishop_selected_id` (3869) = -1, then:
  - script `toplevel_mainmodal_background` [-1, -3]
  - both modals
  - `omnishop_main_init` [shop, -1] and `omnishop_side_init` [shop]
  - events on `omnishop_main:list` (OP1-6, OP10), `omnishop_side:items` (OP1-6, OP10, DEPTH1, DRAGTARGET) and `omnishop_side:info_layer` (OP1)
- **List:** each entry is 12 components.
  - Op1 selects: varp 3869 = entry, then `omnishop_main_info_setup` [shop, -1, entry, restricted ? 1 : -1, 0, first cost, stock row, description, true].
  - Ops 2-5 buy 1/5/10/50; op10 examines. `button_1`-`button_4` buy for the selected entry.
- **Buying:** each unit takes each currency (one varp change per currency) and runs `omnishop_main_currency_redraw` [shop]. Refusals:
  - "You don't have enough Lye resin." (the currency's singular name)
  - "You cannot buy any more of that item." (a restricted item already owned)
  - "You don't have enough inventory space."
- **Selling (side panel):** op1 selects an inventory slot (varp 3870, `omnishop_side_info_setup` [slot, shop, 1, 0, sellable ? 1 : -1, entry or -1, description]). Ops 2-5 and the side buttons sell for 40% of each cost, then `omnishop_side_info_close`. Close Info sets 3870 back to -1.

Component ids move between revisions (`omnishop_main:list` was 819:34 in rev 238 and is 819:38 in 241), so the plugin looks them up by gameval name.

Not captured: the messages for an Ultimate Ironman buying a `restricted_uim` item and for selling an item the shop doesn't take.
