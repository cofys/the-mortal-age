# The Fractured Archive (Raids 4)

Raids 4, released on 2026-10-20, needs the `osrs-241_2026-10-20` cache. It is one members plugin, `server/plugins/minigames/FracturedArchive.plugin.js`, which hands off to one unit per area in `server/plugins/minigames/tfa/`.

Sources:
- Three rsprox captures from release day, all rev 241.1:
  - the lobby, with the first visit and mining;
  - a session that forms a party and makes five attempts at the Archive Guardian;
  - a second session of Guardian attempts.
- The OSRS Wiki pages [The Fractured Archive](https://oldschool.runescape.wiki/w/The_Fractured_Archive) and [Archive Guardian](https://oldschool.runescape.wiki/w/Archive_Guardian), which were still mostly empty at the time.
- The cache: gamevals for every id, and the client scripts for the interfaces.

**Estimate** marks what none of these show.

## Layout

| File | What it owns |
| --- | --- |
| `Shared.FracturedArchive.js` | Ids by gameval name, resolved through `CacheDefinitions` on first use. Also the tiles, the script numbers, and the helpers: fades, prompts, projectiles and timers. |
| `Entry.*` | The Chasm of Tears shortcut, the lobby's exit back, the opening cutscene, and the saved `wgs_tfa_shortcut_unlocked` and `tfa_miniquest`. |
| `Lobby.*` | The lobby `Area`: the party overlay (975) and leaving parties on the way out. Also Montoya's pronoun. |
| `Gathering.*` | The Ascension rocks' rotation, mining, the gathering sprite and the builders' banter. One task runs all of it. |
| `Parties.*` | The party model: up to eight members, applicants, rejections and the leader's preferences. |
| `Grouping.*` | The Grouping Board: the party list (977) and party details (976). |
| `Records.*` | The Alliance records (979): personal attempts, completions, deaths, wipes, failures and best times. |
| `RaidState.*` | `Raid` and the `Room` base class: the private copy of the Archive, the HUD (974), deaths, spectating, wipes, abandoning and logouts. |
| `Raid.*` | The Archive Door, the Passageway, the death, item and login hooks, and the room hooks. |
| `Guardian.*` | The Archive Guardian's room. |
| `Commands.*` | `::tfa`, `::tfaguardian`, `::tfaintro`, `::tfacomplete` and `::tfahp <n>`, all for developers. |

Plugin data lives in `server/plugins/minigames/data/fractured-archive.json`: the intro's actors, camera shots, walk and lines, plus the rock tiles and the builders' lines. The lobby NPCs are in `npc-spawns.json` at their captured tiles (`"source":"rsprox"`). The Record Keeper's and General Montoya's conversations are in `npc-dialogues.json`.

## Engine changes

- **`PlayerDeathTask.dropItems` / `returnKeptItems` / `loseItemsAsDeath`**:
  - A death's item loss, split out of the death task.
  - The raid keeps its dead in the room with their items and takes them only when the party wipes, as live does.
  - The death task calls the same methods, so nothing changed for other deaths.
- **The `ease_in_sine` camera easing**: the intro's first glide uses it. Added to both the server encoder and the client decoder.

## Getting in

**The Chasm of Tears.**
- After While Guthix Sleeps, reaching the Chasm sets varbit 16354 `wgs_tfa_shortcut_unlocked` to 1. That turns the Blocked cavity (multiloc 62542 at 4050,4567) into the Opening ("Crawl-through").
- The varbit is saved and sent at login.

**Crawling through.**
- `human_longcrawl` and synth 2454 (four loops, delay 4), a fade, and two ticks later the player is in the lobby at 4127,5508.
- The lobby's own Opening (63009, "Enter", at 4126,5505) goes back. It uses the quest's `wgs:enter-chasm` event and lands east of the cavity. *Estimate:* the exit was never used in a capture.

**The first visit** (`tfa_miniquest` 0) plays the cutscene instead:
1. "You have unlocked a new music track: Into the Archive" (891).
2. `cutscene_status` 1, minimap off. The player stands at 4131,5540, and Armacus Selles, Eva Cashien and Ivy Sophista (the cutscene NPCs 16727-16729) stand by the lobby's east wall.
3. The camera: a sweep across the lobby (`cam_moveto_cycles` 500 cycles, `ease_in_sine`), a second one southwards (555 cycles, `ease_out_sine`), a look at Montoya's corner, then onto the three.
4. The player walks to 4135,5548 over ticks 32-39.
5. From tick 41, forty lines of conversation with their captured chathead animations.
   - Ivy's "Hello agai-" and the player's "Thank you, I'll-" are cut off after three ticks without a click.
6. Ivy bows, the three walk off, the screen fades, and the player is in the lobby at 4135,5548 with `tfa_miniquest` 2.

A logout during the cutscene skips it. *Estimate.*

## The lobby

**The overlay.** `tfa_lobby` (975) is on overlay_hud while you are in the lobby (region 16470). 975:5 lists the party's eight members, with "-" for an empty slot. 975:4 is drawn by the client from `tfa_client_partystatus`: 0 "No Party", 1 "Party", 2 "Step Inside Now!".

**NPCs.**
- **Record Keeper.** His conversation ends on "View Stats?", and "Yes." opens the records.
- **General Montoya.** Four options; the "Thank you." branch was never chosen, so it just ends. He quotes Armacus as seeing the flame of justice "in her eyes". The capture's player was female, so the pronoun follows the player's own.
- **Builders.** One says "This bridge will hold a thousand marching soldiers once I'm done with it!", another answers "Stop boasting and get back to work, pal." four ticks later, and sometimes "I am!" follows. *Estimate:* how often they talk.
- **Others.** The Banker and the Bank Chest work as every bank does. The druids, the Temple Knights and the wizard apprentice stand at their captured tiles.

**The Alliance records (979).**
- Opened by "Read" on the records, or by the Record Keeper.
- The client asks for each category's rows with a script trigger on 979:34 (`[category dbrow]`). The server answers each row with script 10125 `(category, stat, party size or -1, current or blank, 0, personal, global, global today, world today)`, then 10124.
- Overall lists attempts, completions, deaths, wipes, failures, and the time for each party size. Each boss lists attempts, completions, practice completions, deaths and the times.
- Only the personal column is kept. The global and world columns stay blank (`-2147483648`).

**The Ascension rocks.** The map places ten rocks as inactive, as `tfa_gathering_rock_inactive01-03`. The rotation:
- Three at a time become `tfa_gathering_rock_active0N` ("Mine").
- Every 289 ticks a new three come up. They are never the three just lowered.
- The rocks going down play `crystal_ascension0N_lower`, the ones coming up `_raise`, both with synth 2661. The wizard apprentice says "The roots are shifting!" from the second rotation on. *Estimate:* when he says it.
- A player mining a rock that goes down stops.

Mining:
- "You swing your pick at the crystal." and the pickaxe's wall animation (`human_mining_<metal>_pickaxe_wall`).
- `tfa_gathering_coord_temp` (varp 5916) holds the rock's packed tile: (z << 28) | (x << 14) | y.
- Success: "You manage to mine some ascension shards.", one `ascension_shards` (34669) and synth 3600. Successes came 20-70 ticks apart with a dragon pickaxe at 89 Mining. *Estimate:* the success chance.
- **No Mining experience is given.** The captures' stat packets carry no usable totals, so the amount is unknown.

**The sprite.**
- `tfa_gathering_sprite` appears beside the rocks once a rotation (synth 10391) and wanders.
- "Look-at" shatters it: `tfa_gathering_sprite_explode`, synth 10467, "The sprite shatters, giving you some ascension shards.", one or two shards, and the loot-tracker script 7192 with live's key 196151.
- *Estimate:* its timing and its 40-tick lifetime.

## Parties

**The list.** The Grouping Board's "Inspect" opens `tfa_partylist` (977).
- Each row is script 10094 `(row, "8 names|members|preferred size|preferred completions|mode|age in ticks")`.
- All 45 rows are sent each time, row 44 last, because that row lays the list out.
- 977:1's buttons: 0 Refresh, 1 Make Party / My Party (by `tfa_mycontroller`), 2 the Friends/Clan filter (varbit 16380, saved).
- 977:14 sub i opens row i.

**The details.** `tfa_partydetails` (976) is drawn as follows:
- Eight script 10053 `(rights, line)` member rows, leader first.
- Then 10058 applicant rows.
- Then 10060 `(rights, preferred completions, mode, preferred size, spectating disabled, tab)`.
- Rights: 0 can apply, 1 member, 2 leader, 3 applicant, 4 can't apply.
- A line is "name|combat|attack|strength|ranged|magic|defence|hitpoints|prayer|completions|practice".
- Both screens count their rows from their onload script, so every redraw opens the interface again, as live does.

976:1's buttons:

| Sub | Button |
| --- | --- |
| 0 | Back |
| 1 | Refresh |
| 2 | Unblock |
| 3 | Preferred size |
| 4 | Preferred completions |
| 5 | Mode |
| 6 | Disband / Leave / Withdraw / Apply |
| 7 | Members tab |
| 8 | Applicants tab |
| 9 | Spectating |
| 10+r | Kick (or quit, on your own row) |
| 18+r | Move up |
| 26+r | Move down |
| 34+i | Accept |
| 41+i | Reject |

The client sends Refresh by itself every ~17 ticks.

Captured details:
- A new party opens on the applicants tab with a preferred size of 4.
- Joining sets `tfa_mycontroller` (varp 5913) to an opaque number. It is -1 outside a party.
- *Estimate:* the rules behind the buttons, modelled on the Theatre of Blood's. A rejected player is blocked until the leader unblocks. Leaving hands the lead to the next member. Leaving the lobby leaves the party.

## The raid

**Entering by the Archive Door** (62768):
1. A messagebox: "You are about to enter the Fractured Archive which is not a safe area. In addition, be aware that the raid uses various flashing effects that may cause discomfort to some users. Are you sure you wish to enter?"
2. Then "Are you sure you wish to enter?" with Yes. / Yes, and don't ask again. / No. The last choice is saved.
3. "You enter the Archive...", `hpbar_hud_show_extra_bar` (varp 5991) 0, `tfa_miniquest` 4, and the lobby overlay closes.
4. A fade, and three ticks later the player is at 4127,5571, then the fade back.
5. Two ticks after that, `tfa_hud` (974) opens on overlay_atmosphere:
   - script 10042 with the eight names;
   - `tfa_client_partyslot` (the viewer's slot, from 1);
   - each slot's `tfa_client_p0-7`: 1-27 health, 30 dead, 31 not in the room;
   - the timer, script 10036 `(ticks, 1 = stopped)`, every tick.
6. Members still outside see "Step Inside Now!". They go in by the door themselves, each joining the raid as they do; the leader has to be first.
7. Nobody can join once the Inert Guardian has been touched (or after it is beaten): "Your party has already started the challenge. You can't join them now." (our wording), and "Step Inside Now!" goes back to "Party".
8. A member who leaves the lobby or logs out before going in just leaves the party and their HUD slot. The raid ends as soon as nobody is left inside it.

*Estimates:* needing a party, and the late-join message.

**Instancing.** The Archive's first map square (region 16471, levels 0-1) is one `PrivateArea` per raid, at the real coordinates. Live copies it into an instance. The area is multi-combat, and teleports are refused ("You can't teleport out of the Archive.", *estimate*).

**Deaths** in a challenge:
- "You have died. Total deaths: N." The others see the name in red.
- "You will respawn when your party completes or fails the challenge." while anyone still fights.
- Then "Spectating the room. Click a fighting player's health display to spectate them." at the corner tile 4097,5569, with `tfa_client_spectate_mode` 1 and the inventory and combat tabs closed. Items stay with the player.
- Spectate on a HUD slot (a script trigger on 974:5, `[slot, 1]`) sets `tfa_spectate_slot` to the slot + 1. It sends that player's inventory as another's (inv 93 + 32768), opens `tfa_spectate_hud_inv` (978) on side3 with script 158 and "Ping", and says "Spectating NAME...". `[-1, 1]` goes back to the room.
- **Estimate:** a won challenge brings the dead back at the room's entrance.

**A wipe**, two ticks after the last fighter falls:
- The boss bar clears, "You failed to survive the Fractured Archive.", a fade, and jingle 90.
- Three ticks later everyone is at 4130,5560 in front of the door.
- Those who fought lose their items as a death would there, to a gravestone ("Some of your dropped items are being held in a gravestone, near where you died.").

**Abandoning** by the Passageway (62766, placed at 4124,5569):
- A warning: "You are about to abandon the raid. If you do this, you will not be able to return to your current run."
- "Abandon the raid?" with Yes, abandon the raid. / No, I want to stay.
- "You abandon the raid and leave the Fractured Archive.", a fade, and the move to 4128,5559 three ticks later.
- The Passageway's ops are off while a challenge runs (opflags 0).

**Logouts.** *Estimate*, as the Theatre of Blood: a logout in a challenge counts as a death. Logging back in returns the player to the raid while it lasts. If it has ended, they lose their items as the wipe would have.

**Records.** These are counted, as the boards show them: attempts on arrival, deaths, wipes and failures on a wipe, failures on abandoning, and the Guardian's attempts and completions. The Wiki's death-fee discount for the first five clears is not done.

## The Archive Guardian

**Before the challenge.** The Inert Guardian (16657, 5x5) at 4125,5597 shows `vfx_guardian_spawn_idle_spotanim01` every three ticks. Four batteries (Inert Guardian 16661, 2x2) stand at 4139,5592 / 4139,5605 / 4114,5605 / 4114,5592. The room's doors are placed by the server, not the map:
- Doors (63094) at 4141/4113 x 5597/5584, and from later 5610.
- The Ocellus door (63110) at 4124,5621.

**Starting it.** "Touch" asks "Begin the challenge?":
- "Challenge started: Archive Guardian.", music 887 unlocked, `npc_archive_guardian_spawn01` with `vfx_guardian_spawn_spotanim01`.
- Five ticks later it becomes `tfa_guardian` (16659, 550 shield) and the batteries become active (16662, 180 hitpoints).
- The boss bar shows npc 16659, 550/550, in the shield's blue (back 132, sliding 623, remaining 853).

**Flying.** It acts every five ticks:
- **Ranged.**
  - `range_attack01` with `vfx_guardian_ranged_spotanim01`, and projectile 4201 (start 48, end 116, angle 127, heights 0) at each target.
  - It lands four ticks later with `vfx_guardian_ranged_hitanim01`.
  - Prayer counts as it is thrown.
  - About one attack in five went to both players.
- **Special**, every fifth action.
  - `special_attack01` with its graphic.
  - It places two mushrooms per player: one at Chebyshev distance 1, one at 3.
  - A mushroom ripens three ticks later (`nightmare_infection_spotanim_idle`). With a player beside a ripe one it bursts: the despawn loc, area sound 12175, poison 10 and "You have been poisoned!".
- **Swoop.** With its target 7 or more tiles from its centre, it swoops (`swoosh_attack01`, an exact move of 40-56 cycles) and lands a few tiles from them.
- **Melee.** A player under it is hit in melee (`melee_attack01`, 33 seen through Protect from Missiles).
- **No melee against it.** Melee gets "It's flying too high to hit using melee." Its footprint can be walked under while it flies.

**The shield at 0.**
- Three ticks later: `idle_to_ground01`, `vfx_guardian_idletoground_spotanim01`, and the landing blast on its centre.
- It becomes `tfa_guardian_unshielded` (16660). The boss bar moves to its 1,100 hitpoints, which carry over between landings, in red (25600/576/800).
- On the ground it doesn't attack. From five ticks in, a Vine (16664) rises beside each player every three ticks: spawn, attacks at +3, +6 and +9, despawn at +12, gone at +13.
- The landings last 35, 41, 47, 53... ticks, six longer each time.
- Then `ground_to_flying01` and a full shield.

**Enraged** (seen at 316 of 1,100):
- It takes off at once and stops its ranged attacks.
- Every 20 ticks a special, and five ticks later `enraged_phase01` with "@mes_hl_ora@The Archive Guardian focuses intently on you!". Ten ticks later 43 damage lands on that player's tile, through prayer.
- With a live battery about four tiles away, the battery takes it:
  - The battery is hit for 180, plays `guthixian_battery_despawn` and shakes the camera, and is destroyed (16663) two ticks later.
  - The player takes 20.
  - Four ticks after the beam the Guardian loses 220 shield, 40%.

**Estimates:**
- The enrage threshold: 30% here.
- The ranged and melee damage: 25 and 35, with prayer letting through 40% and 50%. The Wiki gives a max hit of 25.
- The vines: 20, halved by Protect from Melee. The captures show 17-19, and 6-11 under the prayer.
- The swoop's trigger and landing, and the mushroom and battery reach.
- A player's own hits on a battery doing nothing.
- No scaling past two players. The Wiki says hitpoints scale with the party, from at least two, but gives no figures; 550/1,100 is what a duo met.

**The kill was never captured.** Its end here is a guess:
- `npc_archive_guardian_death01`, then the dead Guardian (16658).
- "Challenge complete: Archive Guardian." The dead get up, and the Passageway works again.
- A `fractured-archive:room-complete` event `{ raid, room, players }`.
- "The way onward is not open yet: the Archive's other chambers are still to come."

## Not done yet

The next phases, and what each needs from a capture:

| Phase | Content | A capture needs to show |
| --- | --- | --- |
| 2 | The Guardian's kill and what follows it: the doors, the room where the next boss is chosen. Ezekiel, and Bork and the Smorks (`tfa_bork_smork_hp_ui_handler` suggests the boss bar's second bar, `hp_bar_extra`). | the kill, the door choice, both fights from start to end |
| 3 | Moia (`tfa_moia_shadow_shield_amount`) and Dreadnoth the Jellied. The Quartermaster and the mid-raid shops (`tfa_midraid_supplies_shop`, `_failure`): Omnishop must read the row's `omnishop_buy_q1-4` instead of its fixed 1/5/10/50. Supply points (`tfa_supply_points`). | both fights, the shop opened and used |
| 4 | Xarth, and the Dagon'hai Elder with the monks. BossHud drives the second bar wherever a boss uses it. | both fights |
| 5 | Ocellus: three phases, artifacts, quadrant barriers, platforms. | the whole fight |
| 6 | The Blade, the vault chests (`tfa_vault_chest_*`, `tfa_vault_own_chest`), the loot, the lobby rewards chest, the cape claims, the records' completion times. The Combat Achievements kill (`combat-achievements:kill`, monster key 26), the collection log, the death-fee discount. | a completion and its loot; Wiki drop rates |
| 7 | The items: Obligator's and Zorya's tome's weapon types (the Wiki gave them "Unarmed"), Leftovers, the Ascension crossbows and bolts, the elemental fragments, Horn of Bran and Zeal, the Archivist's folio, Rondache, the Living records, and what the shards are for. | each item used |

Also missing from phase 1:
- The banker's and the wizard apprentice's dialogue.
- Mining experience.
- Party scaling.
- Practice mode, which is not out on live.
