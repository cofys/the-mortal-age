# Kalphite Queen standard attacks

The [Kalphite Queen strategy guide](https://oldschool.runescape.wiki/w/Kalphite_Queen/Strategies)
states that a ranged attack drains one Prayer point when its damage roll is positive,
even if Protect from Missiles prevents the damage. A zero roll does not drain Prayer.
The [boss article](https://oldschool.runescape.wiki/w/Kalphite_Queen) also identifies the
Spectral spirit shield as a modifier of this drain. These pages were checked on
28 October 2026. No indexed rsprox player actions were available for this boss; this
correction relies on the Wiki, not on a recording.

The strategy guide also gives the standard attack mix: at melee distance, 50% melee,
25% ranged and 25% magic; further away, 50% ranged and 50% magic. The combat provider
constructs a fresh method on every lookup. Previously its constructor selected Magic
and `finished` selected a next style that was discarded. Consequently ordinary attacks
kept reverting to Magic. Style selection now happens in `start` for the attack being
launched, so all documented branches are reachable.

Previously the boss checked final damage at impact. That prevented any Prayer drain
through Protect from Missiles and prevented the shield modifier from being reached.
Both crawling and airborne forms used that handler, including nearby secondary targets.

The encounter now retains whether each ranged damage roll was positive before the
normal protection and damage reductions. The hit still uses the ordinary damage path.
At impact, a positive original roll spends one Prayer point through the existing drain
modifier, which preserves the Spectral shield's pass/save behavior. Each victim has its
own roll; changing the boss's attack style while a projectile travels does not change
that projectile's drain. Zero rolls, melee attacks and magic attacks do not trigger it.

The plugin delegates to `kalphitequeen/Encounter.KalphiteQueen.js` and accesses engine
classes through the core API. The reusable timed object replacement task is exposed
there for the existing rope attachment. Named rope and tunnel callbacks retain their
existing destinations and yield unrelated objects.

## Regression coverage

`server/tests/kalphite-queen.test.cjs` drives the registered combat method with real
pending hits, NPCs, players, protection prayers and the existing Spectral modifier.
Four of the original eleven cases failed against the old implementation: both forms
with Protect from Missiles, a protected drain passed by Spectral, and a projectile
whose attacker changed style before impact. All eleven passed after the fix.
Additional checks cover independent secondary-target rolls, rope-hook fallthrough and
all six distance/random-roll branches across newly constructed combat methods. Four
launch-style cases failed before moving selection to launch. The final focused boss,
spirit shield and Prayer-drain suites pass 29 tests. The server TypeScript build passes.

In an isolated headless encounter, Protect from Missiles was active and the corrected
standard attacks produced an extra Prayer drain: Prayer fell from 96 to 94 between
consecutive ticks, including natural prayer consumption. Health assistance was explicitly
enabled; this verifies the resulting Prayer state, not unassisted damage balance.
The boss was engaged through normal combat; positioning and skill setup were assisted.

The scope is standard attack selection and ranged Prayer drain, not a complete boss
parity audit. A full kill and phase-transition check was not completed: separate retreat
and regeneration behavior interrupted that attempt. This is a movement-mechanic lead,
not part of the standard attack correction. Exact projectile flight differences between magic and ranged attacks need capture evidence before changing
the existing timing. No changes are made to generated definitions or drops.
