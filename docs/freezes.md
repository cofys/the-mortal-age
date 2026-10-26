# Freezes

What happens around a freeze once it lands: Ice spells (Rush, Burst, Blitz, Barrage), the
Bind-type curses (Bind, Snare, Entangle; see [standard-binding-spells.md](standard-binding-spells.md)),
the Binding Tentacle and the Zamorak godsword. `CombatFactory.freezeTicks` applies the freeze
and its five-tick immunity as before, takes who froze the target and the kind of freeze
(`"ice"`, `"bind"`), and emits `combat:frozen` `{ target, source, ticks, kind }`.
`server/plugins/combat/Freezes.plugin.js` owns what follows.

## PvP range

From the [Freeze](https://oldschool.runescape.wiki/w/Freeze) page: a freeze one player puts on
another "will only restrict movement whilst both players remain within the 10-tile maximum player
weapon range. Moving outside of this range will cause the frozen target to become free to move",
and only X and Y are compared, so a player who climbs a ladder keeps the freeze while above
their target.

- The plugin watches each player-on-player freeze with a task for as long as the freeze lasts.
  When the two are more than 10 tiles apart on X or Y (plane ignored), it ends the freeze.
- The freeze immunity keeps running from the original freeze, so an early release does not
  open a refreeze window. The page doesn't say what happens to the immunity.
- If the caster logs out, the freeze runs its course. The page doesn't cover it either.
- Ice spells, binds, the Binding Tentacle and the Zamorak godsword pass their caster. Boss and
  NPC freezes don't, and are left alone.

## Messages

rsprox captures of Ice Barrage freezes in PvP: recordings 451, 604, 612, 623, 624, 629, 2236
and 2238 (revisions 228 and 233).

- Ice spells: `<col=ef1020>You have been frozen!</col>` as a spam (filterable) game message,
  sent in the same tick as the impact graphic and the projectile.
- `<col=ef1020>The freeze cast upon you is beginning to thaw.</col>` follows 29 ticks after it
  (604, 623 twice, 624, 2238 twice) or 30 ticks (451 twice, 612, 629, 2236 twice). The plugin
  sends it when the freeze has three ticks left as tasks see it, which gives 29 when the target
  takes its turn after the caster and 30 when before.
- Bind-type spells send nothing when they land and
  `<col=ef1020>The holding effect is beginning to fade.</col>` before they end (the Freeze and
  [Bind](https://oldschool.runescape.wiki/w/Bind) pages; the text in Leagues recordings 1102 and
  1858). It uses the same three-tick point; no non-Leagues capture times it.
- Casting a curse bind on a target that is still immune: "Your target is currently immune to that
  spell." (Leagues recordings 95 and 2174).

## Acting while frozen

A freeze "restricts movement ... without disabling other actions", and forced movement through
"adjacent game objects such as ladders or cave entrances" still works (Freeze page).

- A frozen player's walk click gets no reply: recordings 623 and 451 show move clicks during
  the freeze with no message (we used to say "A magical spell has made you unable to move.",
  which appears in no recording).
- Objects and NPCs the player already reaches from their tile still work: a frozen player climbs
  the ladder or talks to the NPC next to them. Before, these clicks were refused while frozen.
- Anything further away answers "I can't reach that!" and is dropped, not queued for after the
  freeze. Recording 2238 shows it for a loc 14 tiles away (`clanwars_ffaexit`, clicked over and
  over until the freeze ended) and for an Attack on a player four tiles away. NPC clicks use the
  same reply; no capture shows one.

## Not changed

- In recording 2238 the frozen player's first step comes 33 ticks after "You have been frozen!",
  and they are still held at 32. Our 32-tick freeze frees them one tick sooner in the same turn
  order, because a timer set during a tick counts that tick down for anyone who takes their turn
  after the setter. That is how every `TimerKey` timer counts, so it needs its own change and
  more than one recording.
