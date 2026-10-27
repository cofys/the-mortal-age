# TzHaar Fight Cave

`server/plugins/minigames/TzhaarFightCaves.plugin.js` runs the cave; its Elite Karamja Diary
resurrection is `tzhaar/Resurrection.TzhaarFightCaves.js`. Rules come from the OSRS Wiki
(<https://oldschool.runescape.wiki/w/TzHaar_Fight_Cave>, <https://oldschool.runescape.wiki/w/Karamja_Diary>,
<https://oldschool.runescape.wiki/w/TzTok-Jad>). The recordings predate these rules (rev 235), so every
rule below is Wiki only.

## Entering and leaving

- There is no wait before going back in. The Wiki's 12 August 2026 entry (Update: Summer Sweep Up -
  Agility & Chambers of Xeric Changes): "You can now re-enter the Fight Caves immediately after
  leaving, with no cooldown." Recording 3889 (rev 235) shows the wait this replaces ("you were in
  cave only a moment ago. You wait a minute or so before going in again.").
- Leaving a run in any way clears a TzTok-Jad Slayer task, with the message "You no longer have a
  slayer task as you left the fight cave." and without resetting the streak (Wiki: TzTok-Jad,
  Slayer; TzHaar Fight Cave, 13 August 2015). The cave sends `slayer:leave-task-area`, which
  `Tasks.Slayer.js` answers.
- The TzRek-Jad pet is 1/100 from a Jad killed on a Slayer task, 1/200 otherwise (Wiki: TzTok-Jad,
  drops). The cave answers `npc-drops:tertiary-chance` by asking `slayer:on-task`.

## Elite Karamja Diary

- **Double TokKul** from the Fight Cave, the Inferno and TzHaar-Ket-Rak's Challenges. Each pays
  through `diary:tokkul { player, amount }`, which `AchievementDiaries.plugin.js` doubles once the
  Karamja elite tier is complete. The amount is doubled wherever it is paid: a finished run, a run
  ended early or lost, and a challenge's partial reward. The text of the Ket-Rak and Inferno lines
  shows the amount actually paid; the Wiki does not say whether live shows the base or the doubled
  figure there.
- **Resurrection.** Once a day (UTC), on reaching 0 hitpoints in the cave, a player who has the
  elite tier carries on with full hitpoints and all stats restored instead of dying. The Wiki's
  5 March 2015 changelog entry adds "if you already own a fire cape"; the current Death and Karamja
  Diary text name only the diary, so no fire cape is required here. Pending hits and poison are
  dropped. The day is saved per player (`tzhaar:fight-cave-resurrected-on`). No message or
  animation is recorded for it, so none is sent.

## Not covered

- The fire cape exchange's extra 1/200 pet roll at TzHaar-Mej-Jal.
- Leaving the cave by a teleport or command does not clear a Jad task (only the exit, a death and
  finishing do).
- The diary journal does not show whether the day's resurrection is used (the Wiki mentions it).
- Hardcore Group Ironman life loss on a death that the resurrection avoids.
