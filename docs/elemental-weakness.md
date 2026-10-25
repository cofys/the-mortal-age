# Canonical elemental weaknesses

The NPC loader preserves the generated elemental type and severity behind its existing
cache-name guard. The Elemental Spells plugin consumes that data for the twenty standard
Strike, Bolt, Blast, Wave and Surge spells. No generated JSON is changed.

Standard families use the highest base damage unlocked by the player's unboosted Magic
level. Chaos gauntlets add three to Bolt's base; a matching elemental amulet or the usable
universal Elemental amulet adds two. These additions precede equipment bonuses and weakness.
The canonical Wind Bolt spell replaces the old erroneous hardcoded gauntlet spell ID.

Weakness damage adds `floor(baseMaximum * percent / 100)` after equipment and existing
damage modifiers. Accuracy adds `floor(rawAttackRoll * percent / 100)` after the existing
accuracy modifiers. Neither multiplies the already equipment-boosted result. Only the raw
actor roll is cached; changing target or spell cannot reuse a weakness bonus.

Royal Titans now uses these same canonical fields instead of registering duplicate general
weakness multipliers. Its special row clearing, minion hit chance and force-max rules remain.
Ancient ice spells retain their encounter-specific row behavior but receive no standard
elemental weakness bonus. Powered staves, god spells and other spellbooks are excluded.

## Generic calculation events

These mutable custom-event payloads keep gameplay policy outside the formula foundation:

| Event | Context | Mutable result |
| --- | --- | --- |
| `combat:magic-base-max-hit` | `attacker`, `target`, actual `spell`, `originalMaxHit` | `maxHit`, before Charge/equipment |
| `combat:magic-max-hit` | `attacker`, `target`, actual `spell`, pre-equipment `baseMaxHit` | `maxHit`, after existing modifiers |
| `combat:magic-attack-roll` | `attacker`, actual `target`, `spell`, `baseAttackRoll` | `attackRoll`, after existing modifiers |

Results must be finite and nonnegative; invalid results retain the preceding calculation.
An explicit damage spell override is propagated to every stage.

## Primary references

- [OSRS Wiki: Elemental weakness](https://oldschool.runescape.wiki/w/Elemental_weakness).
- [The Whisperer](https://oldschool.runescape.wiki/w/The_Whisperer): 60% Earth weakness.
- [Elemental amulet](https://oldschool.runescape.wiki/w/Elemental_amulet) and
  [Amulet of earth](https://oldschool.runescape.wiki/w/Amulet_of_earth): additive base bonus.
- Original Wiki DPS calculator, pinned commit
  [`d50c49c589793dc2ee691592015ba63ff9c49fab`](https://github.com/weirdgloop/osrs-dps-calc/tree/d50c49c589793dc2ee691592015ba63ff9c49fab):
  `src/lib/PlayerVsNPCCalc.ts` (raw-roll/base-maximum ordering),
  `src/types/SpellMax.ts` (unboosted family scaling), and `src/lib/BaseCalc.ts`
  (matching individual/universal amulets). No other private server is a behavior source.

## Validation and limits

The new formula regressions cover the actual Whisperer definitions, all twenty spells,
unboosted level boundaries, geared additive rounding, same-cycle target changes, explicit
spell overrides, all four individual amulets, usable/noted/placeholder universal variants,
Chaos stacking, canonical Royal Titans/minions and excluded spellbooks. The former Royal
weakness tests moved to the shared real-formula path; its registration fixture now rejects
duplicate general modifiers. Existing stance assertions retain their exact values.

This corrects the elemental calculation stages, not every magic-combat mechanic. Tome
ordering, special NPC spell rules, client presentation and unresolved boss timing/RNG are
separate verification work. Do not infer complete boss fidelity from these formula checks.

Native packet checks on an isolated normal Whisperer confirmed five actual cast calculations
with a Kodai wand: Earth Wave38 versus Fire Wave23 with the Earth amulet; Earth Bolt29
with that amulet and Chaos gauntlets; Wind Bolt19 with the universal amulet and gauntlets;
Ice Barrage34 with no elemental bonus. Their accuracy calculations were independently
checked from the same live calculation events: matching Earth uses raw11016 plus6609;
the other spells retain11016. These are calculated maximums/rolls from real casts, not a
claim that every random hit lands for its maximum. QA accounts saved and the world stopped.
