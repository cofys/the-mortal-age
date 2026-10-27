# Lumber Up

The [Dragon felling axe](https://oldschool.runescape.wiki/w/Dragon_felling_axe)
shares Lumber Up with dragon, infernal, 3rd Age and crystal axes and their variants:
a visible +3 Woodcutting boost for 100% special energy. At base level 58 this can
meet the level 61 requirement to chop with a dragon axe.

The [Infernal axe](https://oldschool.runescape.wiki/w/Infernal_axe#Degradation)
retains the dragon axe's special when depleted. The
[Crystal axe](https://oldschool.runescape.wiki/w/Crystal_axe) also acts as a dragon
axe when inactive. The [special attacks table](https://oldschool.runescape.wiki/w/Special)
lists the shared Lumber Up ability across the axe families, including felling axes.

## Registration and activation

The special registry previously omitted the dragon felling axe, both ornamented
dragon axes, the depleted infernal axe and its two ornamented charged/depleted
pairs, and the inactive crystal axe and crystal felling axe. Equipping one of
these left the player without a usable special, so pressing the special control
neither boosted Woodcutting nor spent energy. They now use the existing instant
Lumber Up handler. Cache revision 241 supplies the item identifiers; noted items
and bank placeholders are excluded.

Rsprox captures **293** (revision 229) and **3149** (revision 232) show dragon axe
activation on the click tick: animation `dragon_smallaxe_anim` (2876), graphic
`dragon_smallaxe_swoosh_spotanim` (479, height 96), special energy 1000 → 0, and
area sound **2531**, one loop, range 1. The animation has no embedded sound in
cache revision 241. Lumber Up now broadcasts that area sound at activation.

## Verification

The focused regression suite exercises actual special registration and activation
for all 16 supported axe variants, checks the +3 boost and full energy cost,
and checks the captured area sound and refusal without enough energy. Against
the original handler, ten variant cases and the sound case fail; the fixed
handler passes all 17 cases. The existing melee-special fixture now supplies a
position for the area sound. The four relevant test files pass all 58 tests,
and the TypeScript build passes.

Live server checks reproduced the dragon felling axe's missing effect before
the fix. Afterward, the combat-tab special button boosted Woodcutting 58 → 61,
spent energy 1000 → 0, left Woodcutting XP at 224466, and kept the axe equipped.
A second activation at zero energy refused the action. The depleted infernal
axe, inactive crystal axe, ornamented dragon axe and inactive crystal felling
axe also boosted 58 → 61 and spent all energy through the special control.

## Evidence limits

The available activation captures are for the ordinary dragon axe. Variant
eligibility comes from the Wiki; variant-specific animation and graphic parity
has not been established by those captures. The live checks verify gameplay
state; appearance and audible playback have not been visually reviewed.

Capture 293 also increments the global special-attack usage counter. The live
server leaves cache varp 4524 (`tracking_special_attacks_used`) at zero after
activation. This is deferred because it belongs to the separate, shared
special-attack activity-tracking mechanic, rather than axe eligibility or its
activation effect.
