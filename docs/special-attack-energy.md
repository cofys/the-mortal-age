# Special attack energy restoration

Special attack energy comes back 10% at a time on a restore timer (`RestoreSpecialAttackTask`,
started by `CombatSpecial.ensureRestoreTask`). The Lightbearer's rules are in
`server/plugins/items/Lightbearer.plugin.js`.

## Rules

| Situation | Behaviour | Source |
| --- | --- | --- |
| Normal rate | 10% every 50 ticks (30 seconds) | [Wiki: Special attacks](https://oldschool.runescape.wiki/w/Special_attacks) |
| Lightbearer worn | 10% every 25 ticks (15 seconds) | [Wiki: Lightbearer](https://oldschool.runescape.wiki/w/Lightbearer) |
| Logging out | The timer restarts: the first 10% after login takes the full 50 ticks | Wiki: Special attacks; rsprox captures (below) |
| Putting the Lightbearer on | The timer restarts at 25 ticks only when more than 25 are left ("only if natural regeneration is below half"); otherwise it keeps running | Wiki: Lightbearer |
| Taking the Lightbearer off | The timer always restarts at 50 ticks | Wiki: Lightbearer; rsprox captures (below) |

The restore timer is therefore not saved with the player.

## Captures

rsprox captures send the client script `spec_regen_timer` (4721) with `[period, start tick]`
whenever the timer starts, which shows where the server restarts it:

- **Login** (recordings 3861, 3868, 3961, 3962, 1139, 3992, 3994, 4052, 4096, 4101, 4123, 4136,
  4269, 4272; rev 235-239, normal worlds): the player logs in below full energy, the server
  sends `spec_regen_timer [50, <login tick>]`, and the first +10% comes 49-50 ticks after login.
  No time carries over from before the logout.
- **Lightbearer** (recordings 101, 553, 554, 582, 1833, 1837, 1852; rev 227, all Leagues worlds):
  taking the ring off sends `spec_regen_timer [50, <this tick>]` every time, even with 1-11 ticks
  left on the old timer (553, 554, 582, 1833, 1837). Putting it on sends `[25, <this tick>]`. Every
  recorded equip but one happened at full energy, when no restore was due. The one below full
  energy (1833) came 1 tick into the timer, where the Wiki's rule also restarts it. These
  recordings can't show the "keeps running when 25 or fewer are left" case; that rule comes
  from the Wiki alone.

## Not implemented

- The orb's regeneration indicator. Live sends `spec_regen_timer` at login and again every
  50 ticks, even at full energy (recording 4258); at login it comes with `health_regen_timer`
  and `spec_regen_orbs_synch`. Its start tick is the server's `map_clock` value (varp 3079),
  which this server doesn't send. That belongs to the orb display for hitpoints and special
  energy, not to the restore timer.
