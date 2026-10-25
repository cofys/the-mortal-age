# Lunar poison cures

Checked 24 October 2026 against the OSRS Wiki:

- [Cure Me](https://oldschool.runescape.wiki/w/Cure_Me) grants no poison immunity
  and converts venom to poison. Its update history records a once-per-game-tick
  cast limit since 24 May 2023.
- [Cure Other](https://oldschool.runescape.wiki/w/Cure_Other) requires Accept Aid
  and grants no poison immunity.
- [Cure Group](https://oldschool.runescape.wiki/w/Cure_Group) acts on consenting
  players within one tile of the caster.
- [Venom](https://oldschool.runescape.wiki/w/Venom) explains that conversion to
  poison retains the venom's current damage.

Previously one shared core helper cleared both afflictions and replaced existing
immunity with 12 seconds. All three spells now live in the members-only
`LunarCures` plugin and leave the immunity timer untouched. Ordinary poison is
removed; venom is downgraded, and a second cure removes the resulting poison.
The server stores venom as damage and poison as severity, using five severity
points per starting damage; conversion preserves damage through that existing
representation. It does not submit or restart a damage task.

Self casts use the existing spell-cast hook. A generic
`magic:spell-on-player` custom event carries the player, target, cache-resolved
spell name and packet widget/item ids before Lunar/combat fallback. Plugins can
claim the packet with `handled`; unrelated spells retain their fallback. No
content-specific hook or spell policy is added to networking.

The plugin uses the shared Spell requirement/rune pipeline and cache-resolved
spell ids. Existing Defence requirement, costs, XP, target range and Accept Aid
behavior are retained; dead targets are rejected before rune consumption. The
target must also share the caster's private instance. Cure Me records its last
successful World process cycle in a transient WeakMap: duplicate packets in that
cycle consume nothing, and another cure becomes available the next cycle. This
is independent of wall-clock duration or unrelated spell cooldowns.
The
existing shared Lunar cast presentation is retained (animation4413/graphic747);
this correction does not establish visual or comprehensive Lunar-spell parity.

Validation: build, then `node --test tests/lunar-poison-cures.test.cjs
tests/jewellery-crafting.test.cjs tests/npc-spell-target.test.cjs
tests/spell-cast-animations.test.cjs`. Tests dispatch native self/player spell
packets through ClientConnection with real cache spell selections, Player,
Spell guards and poison-task damage. They cover staged cures, existing immunity,
cost/XP, failed skill/book/rune requirements, refused/self/distant/dead/other-plane
targets, group range/consent, and another Lunar player spell's fallback.
Additional regressions cover private-instance isolation and duplicate Cure Me
packets in one game tick without extra costs or XP.
