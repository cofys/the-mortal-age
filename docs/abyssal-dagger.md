# Abyssal dagger: Abyssal Puncture

## Evidence

The [Abyssal dagger Wiki page](https://oldschool.runescape.wiki/w/Abyssal_dagger_%28p%2B%2B%29)
(accessed 26 October 2026) describes a two-hit special with 25% increased accuracy,
15% reduced damage per hit and a 25% energy cost. One accuracy roll determines both
hits, against slash defence. The unpoisoned, poisoned, poison+ and poison++ variants
share this special.

The [imbued dagger Wiki page](https://oldschool.runescape.wiki/w/Abyssal_dagger_%28bh%29)
(accessed 26 October 2026) gives its four poison variants the same two-hit special,
with 5% reduced damage and a 35% energy cost. It restricts their use to Bounty Hunter,
Castle Wars, Clan Wars, Soul Wars, the Fight Pit and the house and Clan Hall combat rings.

The rsprox capture index has no matching Abyssal dagger weapon actions. These gameplay
rules rely on the Wiki; no recording is cited for timing, animations, graphics, sounds
or exact messages.

## Confirmed defects and correction

Only the standard poison++ dagger had a special registered. Equipping an unpoisoned
dagger and activating its special left it inactive. The standard unpoisoned, poison
and poison+ daggers now share the existing poison++ special.

All four imbued daggers also lacked their special. They now use a separate registration
with their 35% energy cost and 0.95 damage multiplier; standard daggers retain 25%
and 0.85. Both registrations use the existing shared accuracy roll and slash defence.
The revision 241 cache identifies the eight usable items separately from their notes
and bank placeholders, which are excluded.

The imbued daggers bypassed the existing equipment restriction outside approved combat
areas. They now use the same restriction as the imbued dark bow. The existing Clan Wars
free-for-all and Soul Wars match also lacked approvals for restricted weapons; each now
answers the existing permission event for opponents inside its actual combat area.
The free-for-all safe zone and private copies do not grant permission; Soul Wars requires
the same active match instance. Ordinary combat rules still decide whether the opponents
may attack one another.

## Validation and limits

The server build passed. The focused dagger, restricted-weapon, Soul Wars, Ferox, melee
special and special-targeting suites passed all 148 tests. The same new regressions
against the original four gameplay modules failed 15 tests. Coverage includes assignment
and activation for all eight variants, one energy deduction, shared successful/missed
accuracy rolls, roll modifiers, exclusion of notes/placeholders, equipment restrictions,
Fight Pit boundaries and the new free-for-all/Soul Wars approvals.

Live verification equipped and attacked with all eight variants in the Clan Wars
free-for-all. Every standard variant reduced energy from 100% to 75%; every imbued
variant reduced it to 65%, and each attack cleared the queued special. The imbued
poison++ dagger was refused against another player in the Wilderness. After the Fight
Pit countdown admitted both opponents to a match, it was allowed there and refused
against an opponent in the waiting room.

Soul Wars match approval is covered by regression tests, rather than a new complete
live match. No claim is made about visual or packet-timing parity. The Bounty Hunter
crater was not exercised. Clan Hall combat rings require a separate area implementation;
no existing Clan Hall implementation was found in the gameplay plugins.
