# Brine sabre: Liquify

Liquify is an underwater-only melee special. It costs 75% special energy,
doubles accuracy and adds one quarter of damage dealt, rounded down, to
Attack, Strength and Defence. The existing boost ceiling is base level plus
3 plus 10% of base level, rounded down. An existing boost above that ceiling
is preserved rather than reduced.

## Evidence

- [Brine sabre](https://oldschool.runescape.wiki/w/Brine_sabre): underwater
  restriction, energy cost, doubled accuracy and damage-based stat increases.
- [Special attacks](https://oldschool.runescape.wiki/w/Special_attacks#Stat-boosting):
  the existing Liquify boost ceiling.
- [Temporary skill boost](https://oldschool.runescape.wiki/w/Temporary_skill_boost#Visible_and_invisible_boosts):
  the stronger visible boost wins. Preserving a stronger potion boost when
  Liquify reaches its ceiling follows this rule and the description of
  Liquify as increasing the three stats.
- [Mogre Camp](https://oldschool.runescape.wiki/w/Mogre_Camp) and
  [Underwater Tunnel](https://oldschool.runescape.wiki/w/Underwater_Tunnel):
  both explicitly permit Liquify. The tunnel map is on plane 1.
- [Underwater](https://oldschool.runescape.wiki/w/Underwater): Fossil Island's
  sea floor permits brine sabres against lobstrosities.

The location check covers the plane-1 sea-floor map squares at Mogre Camp,
Harmony Island and Fossil Island, including the eastern lobstrosity spawns.
It excludes the surface and Harmony's dry plane-0 basement. Coordinates
match the current map and existing sea-floor spawns.

No recorded brine-sabre weapon actions were available in the rsprox capture
index. These changes use Wiki evidence; there are no recording IDs to cite.
Exact live rejection wording, animation/graphic timing and sound were not
established. The rejection message describes the restriction; it is not a
verified OSRS quotation.

## Regression and in-game verification

Before the fix, three regression cases failed: land eligibility, neighbouring
map-square eligibility and preservation of stronger boosts. At base 80, a
16-damage hit incorrectly reduced Attack 97 and Defence 100 to 91.

Seven focused tests cover the location/plane restrictions, eligible areas,
energy preservation and clearing a rejected special, quarter-damage rounding,
misses/zero damage, repeated boosts, drained stats, stronger potion boosts,
and the registered cost and multipliers. They pass alongside the 25 existing
melee-special regression tests. The server build also passed.

In-game verification used a normally equipped brine sabre and existing NPCs:

- A special attempt against a surface goblin was rejected once, retained
  100% energy and cleared the special toggle. Clearing the toggle prevents
  combat from retrying the rejected special every tick.
- Against an existing Fossil Island lobstrosity, energy fell from 100% to
  25%. A 12-damage hit raised all three stats from 99 to 102.
- With super attack, strength and defence potion boosts, a subsequent
  underwater special left all three stats at 118 rather than lowering them
  to Liquify's ceiling.

The Mogre Camp and Harmony eligibility checks are covered by regression
tests; their quest entry routes were not replayed. No generated data changed.
