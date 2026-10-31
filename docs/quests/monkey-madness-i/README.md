---
quest: Monkey Madness I
key: monkey_madness_i
status: in-progress
tested: 2026-10-31
tester: agent
model: claude-haiku-5-5
commit: 5f1155177
cache: osrs-241_2026-10-20
start: checkpoint
travel: travel_to
---

# Monkey Madness I

Chapter 1 (stages 0 to 7) was played start to finish on a watched client: the Narnode start, the Karamja shipyard, the hangar and the Reinitialisation Panel, the Crash Island landing and the Lumdo boat to Ape Atoll. Chapters 2 to 4 are not played, so the quest is not passed. The run also found a transcript bug (pronoun placeholders) that is not fixed yet.

## Findings

Newest first. Nothing is filed as an issue or PR yet.

- **open** Transcript pronoun placeholders show literally: "[He is/She is/They are]" in Daero's hangar briefing, and "[him/her/them]" in Waydar's Lumdo menu. The quest needs a pronoun substitution for the player.
- **open** Quest Helper is stale from stage 5: after the Panel it says "Talk to Garkor", then at stage 6 and 7 "Return to King Narnode Shareen". In the hangar, before the Panel, it showed the Ardougne Zoo step. This is helper integration, not quest code.
- **open** The hangar Teleportation Devices (objects 4869 and 4870, Operate) do nothing. Daero's "teleporter round the corner" line leads nowhere. The flight to Crash Island is Waydar's talk ("Yes, let's go."). Whether the device should work is unverified.
- **open** The hangar sliding puzzle is not implemented. Operating the Reinitialisation Panel completes stage 5, as the plugin documents.
- **open** On Ape Atoll, walking from the Lumdo landing stalls inside the Greegrees area. The planner also reports the Bamboo Gate (object 4787 at 2720, 2765) as needing Monkey Madness II, so the route to Garkor is not established. Whether this is a travel or quest issue is unresolved.
- **open** `travel_to` returns `no-route` for the Tree Gnome Stronghold, since it needs a Spirit Tree, glider or teleport. Its legs also name ladders by their live ids, which differ from the data ids (matched by name).

## Runs

### 2026-10-31 · agent · claude-haiku-5-5

- **Start:** the Tester account was at a plain spot with all skills at 99 and melee max gear from setup commands. The prerequisites The Grand Tree and Tree Gnome Village were not finished, and Narnode refuses to start the quest without them. They were set complete with the quest command as declared setup. Then the account was placed at Narnode's tile with `::tele` before the quest's first step. Quest points went from 0 to 7 from the prerequisites.
- **Route:** from Narnode, up the Grand Tree ladders (objects 4458, 56233 and 56232), a glider from Captain Errdo to Gandius, the shipyard gate, G.L.O. Caranock. Back to Ta Quir Priw by glider, down to Narnode. Up to Daero, the blindfold to the hangar, the Panel, the hangar glider with Waydar to Crash Island. Lumdo, Waydar's convincing menu, then Lumdo's boat to Ape Atoll.
- **Result:** the quest varp 365 (`mm_main`) reached stage 7. Stage 1 gave the Gnome royal seal (item 4004). Stage 3 gave Narnode's orders (item 4005), which Daero took at stage 4. Stage 5, the panel, and stage 6, the Crash Island landing, were both recorded. Quest points stayed at 7 because the quest is not complete. The Gnome amulet (item 589) was in the inventory after the prerequisite quests were completed, probably their reward.
- **Not checked:** chapters 2 to 4, quest rewards, the repeat talk to King Narnode after completion, and a logout and login persistence check. The server was restarted once, so Tester went through a relog, but no explicit logout check was run.
