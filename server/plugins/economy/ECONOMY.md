# THE ECONOMY — Design (v1)

The connective tissue of The Mortal Age. Per the world bible: *"Roles 'really
matter' because they're interdependent: kingdoms need supplies for wars,
armies need gear, gear gets destroyed, gatherers feed the machine. No role is
mandatory; every role moves the world."*

Most RSPS economies are dead on arrival: admin-spawned items, instant
endgame, nothing to spend gold on, no reason for a smith to exist. This
economy inverts that. It has three design goals:

1. **Gatherers and crafters are first-class players**, not servants of PKers.
   A fisherman's full game is fishing; a merchant's full game is trading.
2. **Scarcity is geographic.** No region is self-sufficient. The best gear
   needs materials from three regions, so trade routes exist.
3. **Sinks outpace faucets.** Crafters run out of customers when gear is
   eternal. Here, gear dies — in the Wilderness, in wars, to wear. Smiths are
   busy forever.

This doc is the design. The code under `server/plugins/economy/` is v1
**interfaces + one wired sink** (see "Implementation status" at the end).

## Files

`server/plugins/economy/` — additive only, no existing files touched.

| File | Role |
| --- | --- |
| `Economy.plugin.js` | Registration list (attach-only `register`) |
| `constants.js` | `economy:*` event names, attribute keys, tuning constants |
| `Events.Economy.js` | `economy:*` custom-event listeners (the cross-plugin API) |
| `Prices.Economy.js` | Reference-price service: GE baseline + demand pressure |
| `Demand.Economy.js` | Demand ledger: kingdom/buyer supply-need broadcasts, read helper |
| `Sinks.Economy.js` | **Real, wired:** Wilderness PvP death-destruction sink |
| `Commands.Economy.js` | `::economy` (OWNER, read-only) — inspect prices, demands, sink stats |
| `data/regional-resources.json` | Resource profiles per power + the contested Wilderness |
| `ECONOMY.md` | this file |

---

## 1. Regional resources — scarcity drives trade

Gielinor's geography is the nostalgia anchor; its *resource map* is our
economy. Each great power is rich in some things and starved of others.
Nothing below is canon law — it's the economic read of the same map.

| Power | Surplus (exports) | Deficit (imports) | Why |
| --- | --- | --- | --- |
| **Keldagrim** | coal, iron, mithril, adamantite, gems; master smithing labor | **food, timber** | An underground company town. The eight companies dig; they cannot farm. *A fledgling kingdom devours supplies* — Keldagrim is the hungry giant of the economy. |
| **Kandarin** | timber (oak → yew → magic), fish (Catherby, Fishing Guild), flax | metals, leather | Forested, coastal, agrarian. Seers' flax field and the eastern forests make it the woodshop of the world — and it has no serious mines. |
| **Asgarnia** | wheat/bread, barley, hops (brewing), limestone | high-tier timber, ore | The breadbasket. Falador's farms and the Mining Guild (skilling hub, not industry) — feeds armies, not forges. |
| **Misthalin** | leather/hides, wool, cloth; **trade itself** (Varrock is the commercial hub) | ore, fish | Lumbridge cattle and sheep, the Varrock tannery, the GE's home city. Misthalin doesn't produce much — it *moves* things and takes a cut. |
| **Morytania** | herbs, mort myre fungi, swamp paste (alchemicals) | **food, timber, ore** — nearly everything | The dark is poor soil and poorer luck. It exports potion ingredients the whole world wants and imports the calories to survive. Net importer = natural raider, natural trader. |
| **Wilderness (contested)** | **runite ore**, dragon bones, revenant drops | — | The high tier lives behind PvP. Runite — the metal the best smithing needs — only spawns where someone can kill you for it. This is deliberate: endgame materials are risk-gated, not grind-gated. |

Two rules fall out of this table:

- **No best-in-slot item is single-region.** A masterwork rune platebody
  needs Keldagrim runite *smelted by a Keldagrim-trained smith*, a Kandarin
  yew haft for its fittings, and Morytania swamp paste as a tempering agent
  (see §2). A solo player can make *good* gear alone; *great* gear is a trade
  network.
- **Keldagrim's hunger is the economy's engine.** The richest mines in the
  world belong to people who can't feed themselves. Every food shipment north
  (down?) into the mines is trade with a story.

The machine-readable version lives in `data/regional-resources.json`
(surplus/deficit lists per power, contested flags). Future systems —
kingdom quartermasters, citizen merchant pricing, trade-route rumors — read
that file, not this doc.

## 2. Crafting tiers that matter — mastery is quality, not speed

The Albion lesson: a blacksmith's 100th sword should be *meaningfully
better* than their 1st, not just faster to make. In most RSPS, skilling only
changes speed and unlocks; the product is identical. Here, the maker is in
the item.

**Quality tiers** (applied at craft time, visible in the item name/examine):

| Tier | Maker requirement | What changes |
| --- | --- | --- |
| Crude | any | −1 stat, ugly. Tutorial output. Nobody buys it; it's the journey. |
| Standard | level to make the item | the item as OSRS knows it |
| Fine | high level + quality materials | +1–2 stats, or +10% charges |
| Masterwork | max-ish level + **multi-region materials** | +stat, a named-maker line in examine ("Forged by ___"), repairable, holds enchantments better |
| Legendary | masterwork + a rare drop component (revenant/Wilderness-gated) | unique effect or set interaction |

Design notes:

- **Mastery is legible.** A masterwork platebody is visibly, numerically
  better than a standard one. Players pay for the name in the examine text.
  Smiths build reputations — and reputations are the crafter's endgame.
- **Masterwork forces trade** (§1): the multi-region material rule means the
  best smith in Keldagrim still needs a Kandarin timber contact and a
  Morytania paste runner. The economy's connective tissue, made mechanical.
- **Journey over endgame** (pillar): tiers stretch the skilling journey
  *sideways* (decisions, variation, mastery) instead of just making it longer.
  Rushing past crafting means buying standard gear forever while masterwork
  sells at a premium — rushing feels like skipping the game, exactly as the
  bible wants.
- **Gatherers are not servants.** The fisher's tuna feeds the war effort
  (§5); the miner's adamantite is the bottleneck every masterwork needs.
  Their full game is supply — and supply has buyers because of §3.

What this needs later (not v1): a craft-quality roll at the smithing/
fletching/crafting action, item variants or meta for quality, and the
multi-region recipe definitions. The interfaces in v1 (`economy:item-sink`
for destroyed masterwork, `economy:price` reference feed) already carry
quality implicitly — a masterwork item is a different item id / noted meta,
so prices and sinks track it without special-casing.

## 3. Item sinks — the critical piece

Without sinks, every crafter's customer list empties in a month and the
economy flatlines. Sinks are scheduled, layered, and honest about which are
real today.

### Sink 1 — Wilderness PvP death destruction ✅ WIRED (v1)

Every PK death in the contested Wilderness destroys a share of what would
have dropped, instead of dropping it. Implementation: `Sinks.Economy.js`
listens to the existing `onPlayerDeathItemDrop` hook (per-item granularity,
fires for players *and* the wilderness PK bots), checks the death tile
against the contested-Wilderness rect and that the killer is a player, then:

- rolls destruction per dropped item, **scaled by value**: junk dies, treasure
  survives. Roughly: <100k → ~35% destroyed; 100k–5m → ~10%; >5m → survives
  (the killer's loot, the stakes — untouched). Coins are never destroyed.
- destroyed items set `suppressDefaultDrop` (no floor spawn) and emit
  `economy:item-sink { itemId, amount, sink: "wilderness-pvp-death", ... }`.

Why value-scaled, not flat: a flat 30%-of-everything would feel like theft
and punish risk-takers carrying real stakes. The design intent is to drain
the *flood* — arrows, food, rune sets, cheap gear — the thousands of items
PK bots and PKers cycle daily — while leaving the jackpot loot that makes
the Wilderness worth entering. This is a deliberate divergence from OSRS
death behavior, and it's the point: the Wilderness is the server's furnace.

**Hook point (documented):** `api.onPlayerDeathItemDrop(event)` —
`event.location` (tile with `getX()/getY()/getZ()`), `event.killer`
(`.isPlayer()`), per-item `event.item`, `event.dropEligible`,
`event.suppressDefaultDrop`. Contested-zone test is the pure-coordinate
`WILDERNESS_SURFACE` rect in `constants.js` (z 0, y ≥ 3520) so the economy
plugin never reaches into core TS or the Wilderness plugin — a future
`area:contested` event from the Areas could replace the rect without
touching sink logic.

### Sink 2 — Gear wear and repair (design; Barrows pattern exists)

Charged/degrading gear already exists in-engine (Barrows equipment degrades
in `items/BarrowsEquipment.plugin.js`). The economy extends the *concept*:
masterwork+ gear has a wear pool; at zero it becomes "worn" (stats drop a
tier) until a smith repairs it — repair costs materials + a smith's time,
priced by the repairer. Effect: a permanent maintenance economy. The best
gear is never "done"; it rents its power from smiths forever.

Repairs are the crafter-retention mechanic: even when every soldier owns a
masterwork set, the sets keep coming back to the forge.

### Sink 3 — Kingdom war consumption (design; waits on war sim)

When the kingdoms plugin simulates wars (currently recorded, not simulated),
each war tick burns supplies: arrows by the thousand, food for the troops,
replacement gear for the fallen. Kingdoms buy through `economy:demand`
broadcasts (§6); quartermasters pay from treasuries. A kingdom at war is the
single largest buyer in the economy — *"a fledgling kingdom devours
supplies"* made literal. This is also the gold faucet's counterweight: war
spending moves treasury gold into crafters' pockets, then out through
repair/tax sinks.

### Sink 4 — Upkeep and building (design)

Forts, kingdom halls, player-founded holdings: construction costs materials
once, upkeep costs materials forever. Upkeep lapses → decay → the building
stops working (never deleted — decay, not destruction; players hate losing
the thing, they tolerate maintaining it).

### Sink 5 — Consumables (already real)

Food, potions, runes, ammo: consumed on use. The economy's background
radiation — always on, needs no new code, just needs the other sinks to not
let *durable* goods pile up while consumables drain.

**Sink priority order for future work:** war consumption (§5 scenario) >
wear/repair > upkeep. Death-destruction is live and already covers the
Wilderness loop.

## 4. Money supply — where gold comes from and where it goes

Simple and sane, not a simulation. Gold is a *lubricant*; items are the
economy.

**Faucets (gold in):**

| Source | Notes |
| --- | --- |
| Monster drops | exists today; the baseline faucet. Tuned per content, not here. |
| City mints | **design:** each capital buys bars/ores at fixed mint rates — a price floor under gatherers ("the mint always buys iron at X"). Also the lore anchor: the crown's face on the coin. |
| Kingdom disbursements | soldier pay, bounties, war-board buy orders — treasury gold → players. Waits on war/economy wiring. |
| Citizen merchant sales | merchants sell to players for coins (already real inventory ops in `citizens/brain/actions/Merchant.js`); restock spending recycles it. |
| GE trades | player-to-player; moves gold, doesn't create it. (GE exists: `interface/GrandExchange.plugin.js`.) |

**Drains (gold out):**

| Drain | Notes |
| --- | --- |
| NPC shop purchases | exists (shops.json); the classic drain. |
| Repair costs (§3 sink 2) | gold + materials to smiths; the maintenance-economy drain. |
| Kingdom taxes | **stubbed in kingdoms** (`kingdom:tax-collected` has no emitters yet): market tolls, shop taxes, war levies. The design intent: small, visible, earmarked ("2% market toll → the war chest"). |
| GE tax | check whether `GrandExchange.plugin.js` takes a cut; if not, a 1% listing/completion fee is the obvious v2 drain. |
| Item sinks (§3) | destroy *value*, which is deflationary pressure on goods — the counterpart to gold drains. |

**The sanity rule:** faucets are tuned so a new player's first 100k is
achievable in a session (the journey must *start*), drains scale with wealth
(repairs, taxes, upkeep bite harder the richer you are). We do not simulate
velocity; we watch two numbers — median player gold and the reference price
of a basket of staples (§6) — and tune by hand.

## 5. The interdependence loop — one concrete scenario

**"Asgarnia goes to war with the Kinshra."**

Sir Amik Varze's regency finally moves against the Black Knights massing in
the Wilderness. The kingdoms plugin records `kingdom:war-declared
{ attackerId: "asgarnia", defenderId: "kinshra" }`. Here's what the economy
does with it, role by role — every life a full game, every life moving the
world:

1. **Quartermaster's board.** Asgarnia's war council emits `economy:demand`
   broadcasts: 10,000 cooked lobsters (rations), 50,000 mithril arrows,
   200 steel platebodies, 500 prayer potions — priced from the `economy:price`
   reference feed, paid from the treasury. The demand appears on the war board
   in Falador and as rumors from citizen commoners.
2. **Fishermen.** Kandarin's dock crews (citizen fishers *and* players) see
   lobster prices spike on the reference feed. A player fisher's full game
   this week is running lobsters to the Asgarnian war board — better money
   than the GE, and the work *matters*: the counter on the board ticks down
   toward the army's ration target.
3. **Miners → smiths.** Keldagrim's consortium smells a seller's market and
   raises coal/iron output. Mithril flows south; Asgarnian and Misthalin
   smiths take war contracts. A master smith lands the platebody order —
   but masterwork needs Kandarin yew (fittings) and Morytania swamp paste
   (tempering), so she posts her own `economy:demand`: the crafter becomes a
   buyer, the loop widens.
4. **Merchants.** Varrock traders (players and citizen merchants reading
   `economy:price`) arbitrage: buy low in surplus regions, haul to the war
   zone, sell into the demand spike. The merchant's full game is the spread.
   The GE handles the patient; the stalls and war board handle the urgent.
5. **Soldiers.** Asgarnian men-at-arms (players in the hierarchy) draw
   rations and gear from the quartermaster, march north, and fight Kinshra
   patrols in the Wilderness — where §3's sink is waiting.
6. **The furnace.** Every Wilderness death destroys a share of the gear.
   Arrows are gone (fired or shattered). Platebodies crack (wear → repair
   orders flow back to the smiths). The army's quartermaster re-issues
   `economy:demand`: the loop *restarts*. This is the perpetual-motion part:
   war consumes, consumption employs, employment funds the next war.
7. **The ledger.** Treasuries drain (kingdom store), crafters' coin purses
   fill, repair bills and market tolls pull gold back out (§4). Nobody
   admin-spawned anything; every sword had a miner, a smith, a death, and a
   repair in its history.

Kill any one role and the loop visibly strains: no fishermen → ration prices
spike → soldiers fight hungry (a real debuff, future content) → the war
stalls. That's the connective tissue made legible: *you* mattered.

## 6. Player-driven markets — the minimal market

**We do not rebuild the GE.** `interface/GrandExchange.plugin.js` is a
working exchange with offer slots, price data (`data/definitions/item-prices.json`),
and collection boxes. v1 market work is three small things around it:

1. **`economy:price` — the reference feed.** `Prices.Economy.js` serves a
   reference price per item: baseline from `item-prices.json`, adjusted by
   live demand pressure (recorded from `economy:demand` broadcasts and
   `economy:item-sink` volume). When a reference moves >10%, it emits
   `economy:price { itemId, price, previous, reason }`. Consumers:
   - **citizen merchants** reprice their stalls (their `sellTick` reads the
     feed instead of a hardcoded 12 coins for bread);
   - **war boards / quartermasters** price buy orders sanely;
   - **players** get a `::economy price <item>` read (via `::economy`).
   Reads are also available as a plain module require
   (`Prices.getReferencePrice(itemId)`) — the kingdoms-plugin pattern for
   read-only cross-plugin access.
2. **`economy:demand` — the demand board.** Any buyer (kingdom quartermaster,
   master smith needing yew, player stocking a shop) broadcasts
   `economy:demand { source, items: [{ itemId, amount, priceEach? }],
   reason?, expiresAt? }`. `Demand.Economy.js` keeps the open-orders ledger
   (in-memory, expiring) with a read helper for boards and rumors. This is
   the "want to buy" side the GE's offer slots don't serve well — bulk,
   urgent, story-driven demand.
3. **Merchant stalls plug in, not out.** The citizens plugin's `Merchant`
   action already does real inventory ops (wares out, coins in). The economy
   doesn't replace it; it gives it *prices* (feed) and *customers with
   intent* (demand board). A player merchant works the same stall framework:
   same feed, same board. No separate player-shop system in v1 — the GE
   covers standing offers, stalls cover presence-and-haggle.

## 7. What NOT to build (non-goals)

- **No auction-house rebuild.** The GE exists. We extend around it (feed,
  demand board), never duplicate it.
- **No dynamic taxation sim.** `kingdom:tax-collected` has its door;
  nobody walks through it yet. Flat tolls first, simulation never (or
  much later).
- **No supply/demand price simulation.** The reference feed reacts to
  recorded events; it does not model equilibrium. Hand-tuned constants,
  watched medians (§4).
- **No player shops / stall ownership v1.** Citizen merchants prove the
  stall framework; player stalls come after.
- **No cross-region trade automation.** Caravans, shipping contracts, and
  trade-route content are phase-2 stories. v1 moves goods via players and
  citizens carrying them.
- **No new currency.** Gold only. (Bonds exist as an item; they are not
  money here.)

## Implementation status

| Piece | Status |
| --- | --- |
| `economy:item-sink` event | ✅ defined + emitted (constants, Events, Sinks) |
| `economy:demand` event + ledger | ✅ defined, recorded, readable (`Demand.Economy.js`) |
| `economy:price` feed + reference service | ✅ defined, served (`Prices.Economy.js`) |
| Wilderness PvP death-destruction sink | ✅ **wired and live** (`Sinks.Economy.js`) |
| Crafting quality tiers | 📝 design only (§2) — needs smithing-action hooks + item variants |
| Gear wear/repair economy | 📝 design only (§3 sink 2) — Barrows pattern to generalize |
| War consumption | 📝 design only — waits on the kingdoms war sim |
| Upkeep/building costs | 📝 design only |
| Mint price floors | 📝 design only (§4) |
| Tax emitters | 📝 stubbed upstream (`kingdom:tax-collected` has no emitters) |
| Citizen merchant price integration | 📝 interface defined; citizens plugin not yet reading the feed |

## Open questions for Jon

1. **Sink aggression.** v1 destroys ~35% of sub-100k drops on Wilderness PvP
   death. Too hot? The furnace only works if it's felt — but the first time a
   player watches their rune scimitar vanish instead of dropping, that's a
   story we want told *right*. Numbers are constants in `constants.js`.
2. **Mint floors yes/no?** A crown mint that always buys iron at a fixed
   price guarantees gatherers a living — and caps how far prices can crash.
   It's also a gold faucet that needs watching. Worth v2, or let the market
   find the floor?
3. **Who posts war demands?** When wars go live, is the quartermaster an AI
   citizen with a treasury budget (my vote — it's a *character*), a
   background tick, or a player-held office? This decides a lot of
   `economy:demand` traffic shape.
4. **GE tax.** 1% on completion as the quiet gold drain — acceptable
   divergence from OSRS, or hands off the GE?
5. **Regional starting gear.** Should a new character's origin city
   (Mount & Blade style) come with that region's surplus in their starter
   kit — Kandarin kid gets a yew shortbow, Keldagrim kid gets a steel
   pickaxe? Cheap, flavorful, teaches the resource map on day one.
