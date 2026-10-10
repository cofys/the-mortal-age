# Ironman modes

Ironman, Ultimate Ironman and Hardcore Ironman as **account types**: per player, on a normal world, as in OSRS.
- **Plugin:** `server/plugins/modes/Ironman.plugin.js`, with one unit per area in `server/plugins/modes/ironman/`.
- **Data:** `server/plugins/modes/data/ironman.json`.

Group Ironman and the Ironman tutor come later.

## Setting a mode

Admin command (administrator and up):

```
::ironman                                          show your mode
::ironman <none|ironman|ultimate|hardcore>        set yours
::ironman <none|ironman|ultimate|hardcore> <name> set an online player's
```

Setting a mode updates the client at once: the `ironman` varbit and the chat icon. It's saved as the attribute `ironman:mode`.

## What the client is told

- **The `ironman` varbit (1777):** 0 none, 1 Ironman, 2 Ultimate Ironman, 3 Hardcore Ironman. The cache's enum 859 names these values (4–6 are the group modes), and the account summary shows "Your mode:" from it. It's sent on login and whenever the mode changes.
- **A fallen Hardcore Ironman:** `ironman_hardcore_dead` (5403) = 1, `ironman_downgradepermitted` (1776) = 1, and `ironman_hardcore_downgradedate` (5405) = the day of the death, counted from 27 February 2002. All three as in the rsprox captures, where the varbits appear together.
- **The chat icon:** Ironman 2, Ultimate 3, Hardcore 10 (mod icons).
  - StaffCrowns sets it: a staff crown first, otherwise the account's icon, which content answers through the custom event `account:chat-icon`.
  - `account:refresh-chat-icons` recomputes it.
  - The game sends these numbers with the chat line, so they're not in a cache table. Check them in game.

## The rules

Each rule comes from the rsprox capture database (https://rsprox.net/database) or the OSRS Wiki. A message marked *ours* hasn't been recorded or documented, and is meant to be replaced when someone records it.

| Rule | Modes | Message |
| --- | --- | --- |
| No trading with players, either way | all | "You are an Ironman. You stand alone." (captured); to someone asking an Ironman: "*name* is an Ironman. He/She stands alone." (captured) |
| No picking up items other players own (their drops and kills, also once public; unowned spawns are fine) | all | "You're an Ironman, so you can't take items that other players have dropped." (captured) |
| No drop from a kill another player damaged in the last 60 seconds (the same damage record that decides the killer; 0-damage hits aren't recorded) | all | "As an Ironman, you don't get loot if other players helped you kill the monster." (captured) |
| A warning when attacking an npc another player damaged (once per npc) | all | "As an Ironman, you might not receive kill-credit for this monster." (captured) |
| Loot from a player an Ironman kills is the fallen player's (Wiki: Ironmen can't take PvP loot) | all | none |
| No combat experience from fighting players (Wiki) | all | none |
| Shops sell only their own stock, never what players sold to them (Wiki) | all | "As an Ironman, you can only buy the shop's own stock." *(ours)* |
| No Grand Exchange (Wiki) | all | "As an Ironman, you cannot use the Grand Exchange." *(ours)* |
| No presets: this server's PvP loadouts hand out items. Covers `::presets`, the interface, and the automatic opening after a death, which is skipped quietly | all | "As an Ironman, you cannot use presets." *(ours)* |
| No bank (the Ironman tutor, captured) | Ultimate | "As an Ultimate Ironman, you cannot use the bank." *(ours)* |
| All items dropped on death, none kept (the Ironman tutor, captured) | Ultimate | none |
| One life: a dangerous death makes them a standard Ironman; a safe death (a minigame) doesn't | Hardcore | "You have fallen as a Hardcore Ironman. You are now a standard Ironman." *(ours)* |

## How it hooks in

Existing hooks:
- `onTradeRequest`
- `onGroundItemPickup`
- `onCanAttack`
- `onPlayerDeathItemDrop`
- `onCanGainExperience`
- `onCanBank`
- `onShouldKeepItemOnDeath`
- `onPlayerDeath`

Generic additions for these rules:
- **The npc death event** carries `damagers`: every player who damaged the npc, recorded before the killer is chosen. NpcDrops passes them into `npc-drops:roll`.
- **The player death event** carries `itemsLost`: whether the death was dangerous.
- **Presets** ask `presets:can-use` `{ player, allow, message }` before opening or applying one.
- **`ShopManager`** asks `shop:buy-limit` `{ player, shopId, itemId, available, original, limit, message }` before a purchase.
- **The Grand Exchange** asks `grand-exchange:can-open` `{ player, allow, message }` before opening.

## Not done yet

- **Group Ironman** (and Hardcore and Unranked Group Ironman).
- **The Ironman tutor:** choosing a mode on Tutorial Island, and downgrading in Lumbridge.
- **Bonds:** Ironmen may trade bonds and buy them through their own Grand Exchange interface.
- **Other limits:**
  - entering other players' houses;
  - Nightmare Zone group dreams;
  - the group-boss loot exceptions (raids, Wintertodt, Nex…);
  - the Falador Party Room's balloons;
  - the many Ultimate storage limits (seed vault, looting bag on PvP worlds, the POH costume room…).
- **Ironman armour:** the tutor's line "You're not an Ironman. This armour is only for them." is captured.
