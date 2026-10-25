# Farming plugin

The loader entry is `Farming.plugin.js`; the parts are in `farming/`, one file each:
`Patches` (every hook, patch actions), `Data` (crop and patch tables), `Model` (growth),
`Services`, `Spells`, `Tithe`, `Guild` and `Hespori`, all `*.Farming.js`. They read
`api.core` through `Core.Farming.js`, which the plugin fills before loading them.

Implemented: player-owned patches, saved offline growth, raking, planting,
watering, disease and cures, harvesting, regrowth, compost bins and bottomless
buckets, saplings, gardener payments, leprechaun storage/noting, seed vault,
seed boxes/herb sacks, contracts and rewards, anima plants, farming spells,
amulets, barbarian Farming, Tithe Farm, and a private Hespori encounter/retrieval
service. The generated cache data identifies 110 grouped patches and 40 Tithe
plots; gameplay tables contain 82 crops. XP follows the server's configured rate.

## Comparison with TSPS PR #141

Compared against [PR #141](https://github.com/RSPSApp/tsps/pull/141) at
`718cb8b24202f221a335dd89148e11c245a4fda7`:

- Its 58 crops are already covered. Its 48 patch locations are now covered too:
  the exporter previously missed Port Phasmatys's flower patch and compost bin
  because their regional models use different object IDs.
- Patch changes now send private object removal/re-add packets after the varbit,
  rebuilding the client's geometry for every map tile of the patch. Unchanged
  patches stay quiet; first visits and reused transmit varbits also refresh.
- Transformed click IDs already resolve through `MapObjects.getPrivateArea`,
  shared by object clicks, item use, and spells. No duplicate tile-only router
  was added.
- Cure/prune now follows the local cache's action and respects the supplied
  item. Wrong tools do not consume a carried cure. Lunar Cure Plant still
  bypasses physical tools.
- Watering cans support water pumps and house pumps/gold sinks, reject damaged
  Trouble Brewing pumps, and report empty cans when watering patches/seedlings.
  Herb picking and plant-pot filling use the corresponding farming animations.
- Existing ultracompost, gardener payments, leprechauns, sacks/baskets,
  flower/scarecrow protection, amulets, newer crops, Tithe, and Hespori remain
  available. The reference's simplified seed counts, harvest lives, compost-bin
  mixing, and growth rules were not substituted for our existing mechanics.

## Fidelity limits

This is **not a verified 1:1 implementation**. In particular:

- Unpublished disease/watering probabilities, some yield endpoints, Kronos
  skip probability, barbarian training failure probability, and Hespori's
  special/poison scheduling use estimates marked `ponytail:` in the code.
- Tree chopping uses the existing Woodcutting plugin's axe and success-rate model.
  Player-grown redwoods have four private chopping spots: each depletes with a
  1/11 roll per successful log and regrows independently after 200 game ticks
  (120 seconds), including time offline. Woodcutting Guild redwoods retain
  Forestry's 440-tick depletion timer and 199-tick respawn.
- Geomancy, storage, contracts, and Tithe rewards use existing dialogue menus;
  the original dedicated interfaces and Tithe overlay are not reproduced.
- Spirit-tree travel currently links player-grown trees. The ordinary network,
  quest-specific crops/access restrictions, achievement completion, and the
  wider quest/diary progression systems are not implemented by this plugin.
- Bologa's unlock checks equipped items using the cache's Zamorak/Saradomin/Guthix
  affiliation flags. Bandos/Armadyl/Zaros gear uses explicit Wiki-listed families
  and their documented cosmetic/locked/charge forms, including Sanguine Torva
  and quartz-upgraded ancient sceptres. New unlisted families require source
  verification; god allegiance is not inferred from deity-name fragments or
  Prayer bonuses. Mixed affiliations (including Staff of Light/Balance) are refused.
- Belladonna hand protection uses the Wiki's published protective families, resolved to
  unnoted hands-slot cache variants (including recolours). Unlisted new families require
  source verification; protection is not inferred from item names or combat stats.
- Region 25287 could not be decoded by the cache export. Its contents are not
  included in the patch coverage claim. No in-game or smoke tests were run.

## Verification

Coral yields use the post-19-August-2026 six harvest lives and the published
low/high calculator endpoints: Elkhorn 85/182, Pillar 25/180 and Umbral -50/178.
Sources: [Elkhorn frag](https://oldschool.runescape.wiki/w/Elkhorn_frag),
[Pillar frag](https://oldschool.runescape.wiki/w/Pillar_frag),
[Umbral frag](https://oldschool.runescape.wiki/w/Umbral_frag).
Existing mature saved patches retain their remaining lives; this does not refill
partly harvested patches. The coral regression file covers species-specific
chances, modifiers, final collection, offline/online equivalence and JSON state.

From `server/`:

```powershell
npx.cmd tsc --noEmit
node --test tests/farming-model.test.cjs
node --test tests/farming-redwood.test.cjs tests/woodcutting-guild.test.cjs
node --test tests/bologa-blessing.test.cjs tests/belladonna-harvest.test.cjs
node --test tests/farming-coral-yields.test.cjs
node --test tests/farming-herb-sack-withdraw-order.test.cjs tests/herblore.test.cjs
node --test tests/farming-falador-diary-xp.test.cjs
node --test tests/farming-hespori-recoil.test.cjs tests/ring-of-recoil.test.cjs tests/ring-of-suffering.test.cjs
```

Herb-sack Empty uses the canonical Herblore cleaning levels through `herblore:clean`,
so limited inventory space is filled from the lowest-level herb first (including
Huasca before Snapdragon). Regression checks cover both sack variants, partial/repeated
withdrawals and full inventories. Source: [Herb sack](https://oldschool.runescape.wiki/w/Herb_sack).

The four South Falador allotment/flower/herb patches award 10% extra Farming XP
after the Medium Falador Diary, queried through canonical diary progress. The
bonus follows the acted-on patch; it does not apply to Falador Park trees,
other planes/patches or unrelated Farming awards. Tests cover composting,
planting, harvesting, deferred herb planting XP and incomplete/easy-only diaries.
Source: [South Falador Farm](https://oldschool.runescape.wiki/w/South_Falador_Farm).

The grown Farming Hespori is immune to ordinary-ring and Ring of Suffering recoil.
Its content sets the generic `combat:recoil-immune` policy used by both recoil paths;
Vengeance/Retribution retain their existing reflected-damage behavior. Tests verify
the actual boss wake-up, unchanged flowers, charge conservation and normal recoil.
Source: [Hespori](https://oldschool.runescape.wiki/w/Hespori).

The second command checks the state machine and mocked hooks without server startup
or sockets. It covers offline/save equivalence,
disease/death, mature immunity, private stump regrowth, herb formulas, critical
cache states, Tithe growth/scoring, null bank tabs, growth cadence, seedling deadlines
and nearby patch selection across region boundaries. Cache-only audits also checked crop item
resolution and growing, diseased, dead, and mature visual values.

Redwood regressions cover independent spots/players, exact tick deadlines between
minute sweeps, saved offline deadlines, old whole-tree stump saves, all sixteen
private branch combinations, upper-floor geometry and a complete Woodcutting
request/log/depletion cycle. Cache revision 241 region 4922 contains four Cut
multilocs named `farming_redwood_tree_patch_1_{2,4,6,8}`, controlled by varbit
7907: healthy value 18 and depleted-spot masks 41–55. Ground and first-floor locs
are refreshed privately when that value changes. The timer uses the ordinary
600 ms server tick; raw packet-capture verification remains outstanding.

An old redwood whole-tree stump save has no branch identity. Its remaining
deadline is preserved for all four spots once, after which they regrow independently.
New planting/clearing starts without old branch deadlines.

To regenerate `plugins/skills/data/farming-data.json` (one crop, patch type, patch or loc per line):

```powershell
node -r ts-node/register/transpile-only scripts/generate-farming-data.ts ../..\runelite
```

Sources: [Farming](https://oldschool.runescape.wiki/w/Farming),
[Disease](https://oldschool.runescape.wiki/w/Disease_(Farming)),
[herb calculator](https://oldschool.runescape.wiki/w/Calculator:Farming/Herbs),
[Tithe Farm](https://oldschool.runescape.wiki/w/Tithe_Farm),
[Hespori](https://oldschool.runescape.wiki/w/Hespori), and the linked crop/tool
pages (OSRS Index's attributed wiki copies were used where direct access failed).
RuneLite supplies timing/varbit interpretation; the local cache supplies object
transforms and map locations. The BSD-2-Clause attribution for the RuneLite-derived
data is kept in the JSON's `source` field.

## Bologa unlock verification

The unlock retains 50 Prayer and a one-time 75,000-coin payment. Equipment,
distance, funds and current Farming state are validated at confirmation;
successful payment requests persistence. Currency is cache item `COINS` (995),
not the non-stackable quest item Coins (617) selected by a name-only lookup.
Equipment affiliation parameters are 40 (Saradomin), 41 (Zamorak), 42 (Guthix).
Only real positive-quantity equipment in its correct cache wear slot counts.

Sources: [Bologa](https://oldschool.runescape.wiki/w/Bologa),
[dialogue transcript](https://oldschool.runescape.wiki/w/Transcript:Bologa),
[god-equipment table](https://oldschool.runescape.wiki/w/God_Wars_Dungeon#God-related_protection),
[Torva variants](https://oldschool.runescape.wiki/w/Torva_armour#Sanguine_torva),
[ancient sceptre upgrades](https://oldschool.runescape.wiki/w/Ancient_sceptre#Quartz_upgrades).
The general blessing-item article additionally mentions 65 Cooking, while the
NPC article and actual dialogue list no Cooking unlock gate; this equipment
change preserves the dialogue's Prayer-only level gate and does not change
grape use/yield rules or introduce a new Cooking requirement.

Tests use real Player, inventory, equipment and cache definitions, driving the
actual Tithe NPC/payment and reward callbacks. Menu rendering and persistence
requests are mocked; live dialogue rendering and packet-capture verification
are not claimed.
