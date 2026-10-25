# Prayer-book poison treatment

The [Prayer book](https://oldschool.runescape.wiki/w/Prayer_book) page documents
Recite-prayer with a worn holy or hallowed symbol, a positive Prayer-point
balance, the poison-cost formula, partial treatment when points run out, and
venom conversion costing up to 50 Prayer points. It also describes use through
the Hitpoints orb, with potions taking precedence.

The Great Brain Robbery plugin owns both the item action and the
`poison:cure-from-orb` fallback. Both use its existing imported recitation
transcript, including the read-first and missing-symbol refusals. The existing
Harmony gas-warding route remains separate from ordinary poison treatment.
The orb asks for fallback only after its supported potion search finds none.
No cure consumes the book or grants poison/venom immunity.

For ordinary poison, the cost is `max(0, floor((displayedDamage - 1) / 2))`.
With enough points the status is removed; a player with fewer points spends all
of them and reduces severity by ten per point. That partial reduction is derived
from the documented two damage points per Prayer-point cost and the server's
five-severity-points-per-damage representation. Zero Prayer cannot trigger even
a nominally free cure. Full-cure text comes from the transcript; partial and
venom outcome messages describe the implemented result and are not asserted to
be captured verbatim text.

Venom is converted to ordinary poison at the most recent venom hit's damage.
The core records health actually lost through the shared applied-hit observer,
before reactive healing, independently of the next escalating hit. Queued or
cancelled hits do not change history; a transient affliction generation guards
callbacks across cures and reapplication. This includes the first transition to
the 20-damage cap. `lastVenomDamage` is optional in player
saves and omitted when inactive, preserving unaffected saves. Clearing poison
or venom clears the historical value. Plugins access the canonical poison
damage formula through `api.core.CombatPoisonEffect`.

Saves made before last-hit tracking cannot distinguish a recent 18-damage hit
from a recent 20-damage hit once the next value is capped. With no historical
value, conversion retains the current damage; it does not claim to reconstruct
missing history. Venom before its first hit also uses the current damage.

`tests/prayer-book-cures.test.cjs` covers real transcript conditions and manual/orb
flows, resource gates, costs, symbols, partial treatment, actual capped venom
hits, queued/cleared/stale hit ownership, JSON-codec save/load, missing historical
values and potion precedence.
RSProx's item-10890 search returned no recordings during this audit. Exact
message/animation timing and ordering relative to other non-potion remedies
remain unverified; this does not establish complete health-orb fallback parity.
