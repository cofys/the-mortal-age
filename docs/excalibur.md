# Excalibur

Sanctuary gives a visible +8 Defence boost and costs 100% special attack energy
([Excalibur](https://oldschool.runescape.wiki/w/Excalibur),
[Defence](https://oldschool.runescape.wiki/w/Defence)). Visible boosts do not stack;
a larger boost takes precedence
([Temporary skill boost](https://oldschool.runescape.wiki/w/Temporary_skill_boost)).

The special previously added eight to the current level on every activation. At
50 base Defence, two activations produced 58 and then 66. It also added eight on
top of potion boosts. Sanctuary now caps its increase at base Defence +8 and
preserves a stronger existing boost. A partially decayed or weaker boost can be
refreshed up to that cap.

## Verification

The existing weapon-special regression suite exercises the registered special
through its activation entry point. Four added cases failed before the fix:
repeat use, a weaker boost, an existing +8 boost, and a stronger boost. All 23
tests passed afterward, including target-free activation, the 100% cost, and
refusal with only 99% energy. The server TypeScript build also passed.

In-game verification reproduced 50 -> 58 -> 66 before the fix. Afterward:

- At 50 base Defence, consecutive activations produced 58 and 58.
- At 62/50 after a super defence potion, Sanctuary preserved 62 and spent 100% energy.
- At 25/20 after a defence potion, Sanctuary raised Defence to 28.
- At 99% energy, activation preserved Defence and energy and sent
  "You do not have enough special attack energy left!"
- Each activation preserved XP, inventory and equipment. Successful activations
  cleared the special-energy varp to zero.

The item and special-attack control were checked against cache revision 241:
Excalibur is item 35, and the combat interface's special-attack control is
component 41 in group 593.

No Sanctuary activation recording was found in the rsprox capture index. This
fix uses Wiki evidence; animation, graphic, sound, overhead speech and their
packet timing have not been compared to live OSRS. Behaviour below base Defence
is unchanged and was not compared to live OSRS.
