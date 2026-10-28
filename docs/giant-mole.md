# Giant Mole burrowing

The Mole's burrow check runs after an eligible hitsplat has taken HP, through the
existing damage-application event and its applied observer. Starting the dig when
an attack was launched made the Mole untargetable before impact, discarding the
very hit that triggered it. A projectile could also start the dig before arriving.

The [Giant Mole](https://oldschool.runescape.wiki/w/Giant_Mole) and
[strategy](https://oldschool.runescape.wiki/w/Giant_Mole/Strategies) pages were
checked on 28 October 2026. They establish:

- A one-in-four dig chance in the 5–50% health range, with no digging at or below
  10 HP (the main page's 18 February 2016 change explicitly includes 10).
- Melee/ranged zeros can cause digging; magic splashes and poison cannot.
- Burrowing loses aggression and moves the Mole elsewhere in the lair.
- Thralls can cause digging. The strategy page also identifies the extra dig
  chance from Twinflame's second hit; eligibility therefore follows applied hits,
  rather than one notification for an entire multi-hit attack.

The plugin checks surviving HP after each eligible hit. The existing direct-damage
path attributes thrall hits to their player, so it now reaches the same check as
ordinary combat. Magic splashes never apply damage; poison and reflected damage
are excluded. Once buried, another hit already landing still deals its damage,
without scheduling a second dig. A single lethal hit never starts a dig.

The plugin remains members-only. Its transient buried attribute uses a namespaced,
kebab-case key. Registration only attaches named handlers with the existing core
API; no generated definitions or shared combat code are changed.

## Verification

The regression suite runs the real hit queue and combat hit execution with
cache-backed NPC definitions. It covers damage preservation, projectile delay,
health boundaries (including exactly 10), zeros and splashes, two-hit attacks,
poison, failed rolls, resurfacing, loss of the combat target, and the real thrall
summoning/attack task. Nine of its 21 cases fail against the original plugin;
all 21 pass with the fix. The related hit-queue and thrall suites also pass
(34 tests across the three suites). The server TypeScript build passed.

A running-world combat check used a max-level player with an abyssal whip and
explicit damage immunity, then lowered the Mole to 80 HP after establishing a
normal damaging attack. A zero-hit dig preserved 80 HP; a subsequent damaging
dig retained its 12 damage, resurfacing at 68 HP at a different lair location.
This verifies server state, not the visual quality of the animations or
unassisted combat balance. Exact 10 HP and thrall eligibility are covered by the
regression suite rather than claimed as live-world boundary checks.

## Evidence limits and separate mechanics

No Giant Mole combat recording was found in the available capture index; the
behavior evidence above is the Wiki, not a recording. The existing four-tick
buried interval and animation/graphic IDs are retained; their exact live timing
has not been established.

The Wiki also describes a chance of dirt extinguishing nearby open lights. That
branch remains unimplemented: neither the checked pages nor an available combat
capture establishes its odds or exact packet sequence. Implementing it would
require more evidence rather than an invented probability.

Falador shield tracking, dark-area damage, entrance counting, private-instance
purchase and diary-dependent drops are separate mechanics outside this burrow
fix. The existing plugin identifies tracking and entry features as omitted;
this change does not certify them.
