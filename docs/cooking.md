# Cooking

Fires, ranges and ovens are `server/plugins/skills/Cooking.plugin.js`: one loop for every cooker,
with each food's levels, XP, burn levels, burnt item and line in `COOKABLES`. The Gauntlet's range
is `server/plugins/minigames/gauntlet/Prep.Gauntlet.js`. Tests: `server/tests/cooking.test.cjs`,
`server/tests/cooking-gauntlets.test.cjs`.

## Sources

- **The OSRS Wiki:** levels, XP and burn levels from each food's page, the burnt items from the
  [Burnt fish](https://oldschool.runescape.wiki/w/Burnt_fish) pages (herring and mackerel burn to
  357, trout, cod, pike and salmon to 343, tuna and bass to 367, sardine to 369, anchovies to 323)
  and [Cooked rabbit](https://oldschool.runescape.wiki/w/Cooked_rabbit) (burnt meat), and
  [Cooked meat](https://oldschool.runescape.wiki/w/Cooked_meat) for burning it on purpose.
- **rsprox captures** ([rsprox.net database](https://rsprox.net/database)): recordings 269, 1087,
  1098, 1102, 1718, 1723, 3270, 4103 and 4283 for fires, ranges and ovens; 1158, 3276 and 3285 for
  the Gauntlet.

## What the captures show

- **The menu.** Using a raw food on a cooker, or "Cook" on a range or oven, opens `skillmulti`
  (clientscript argument 6). One kind of food: "How many would you like to cook?" with the raw
  item, offering as many as are carried. Several kinds ("Cook" only): "What would you like to
  cook?" with what each cooks into. A single raw item cooks without a menu.
- **Timing.** The first food is 2 ticks after the choice (or after reaching the cooker with a
  single item), the second 3 ticks after that, then every 4. `busy` is 1 from the choice to the
  first food.
- **Animation.** Fires and a house's firepits and stoves, ovens included, play
  `human_firecooking`; every other range and oven (`range`, `cooksquestrange`, `fortis_stove`
  "Oven") plays `human_cooking`. Each food plays `synth_sound 2577`.
- **Lines** (spam channel). "You successfully cook a shark." / "an anglerfish" / "some shrimps"
  for most fish; "You cook a bass.", "You manage to cook a tuna.", "You cook the rabbit.", "You
  cook a piece of meat.", "You cook the thin snail.", "You successfully bake some bread.", and for
  a karambwan before Tai Bwo Wannai Trio "You cook the karambwan. It looks very dodgy." A burn is
  "You accidentally burn the herring." Cooked meat on a cooker: "You deliberately burn the nicely
  cooked meat."
- **`cooking_success_count`** goes up one for each food cooked and back to 0 on a burn, the
  Gauntlet's paddlefish included. It is saved with the player.
- **Refusals** are message boxes: "You need a Cooking level of 80 to cook a shark.", "You haven't
  got anything to cook." ("Cook" with no raw food, also at the Gauntlet), and "You can't cook
  that." (anything else used on a cooker that no other content takes).
- **The Gauntlet.** "Cook" cooks without a menu; the first paddlefish is 2 ticks after reaching
  the range, with the same sound and spam-channel line.

## Not covered

Sinew on the Lumbridge range ("What would you like to cook?|Cooked meat|Sinew"), pies, pizza,
potatoes, stew and the Sailing fish are captured but are not tsps recipes yet. The lean and fat
snail lines follow the captured thin snail; beef and rat meat follow the captured impaler and
mystery meat.
