# Runecrafting altars

Crafting runes at the runic altars (`server/plugins/skills/Runecrafting.plugin.js`). Guardians of
the Rift crafts its own guardian essence through the `runecrafting:altar-rune` event and is
described in [guardians-of-the-rift.md](guardians-of-the-rift.md).

## What an altar binds

- One click converts all the essence in the inventory
  ([Wiki: Runecraft](https://oldschool.runescape.wiki/w/Runecraft)). At the altars that take rune
  essence (air, mind, water, earth, fire, body) rune and pure essence are crafted together, at the
  same XP and runes per essence.
- The other altars take pure essence only. Without it the true Blood Altar refuses in a message
  box: "You do not have any pure essences to bind." (rsprox capture 1636). Only that altar's
  refusal is captured; the server uses the same box at every pure essence altar.
- The Wrath Altar (loc 34772, `wrath_altar`) crafts wrath runes from pure essence at 95
  Runecraft, 8 XP an essence, with no multiple runes
  ([Wiki: Wrath Altar](https://oldschool.runescape.wiki/w/Wrath_Altar),
  [Wiki: Wrath rune](https://oldschool.runescape.wiki/w/Wrath_rune)).
- The true Blood Altar (loc 43479) takes pure essence at 77 Runecraft, 10.5 XP an essence
  ([Wiki: Blood Altar](https://oldschool.runescape.wiki/w/Blood_Altar)).
- Kourend's Blood Altar (loc 27978, Bind) takes dark essence fragments, never pure essence: 77
  Runecraft, 23.8 XP and one blood rune a fragment
  ([Wiki: Blood Altar (Kourend)](https://oldschool.runescape.wiki/w/Blood_Altar_(Kourend)),
  [Wiki: Blood rune](https://oldschool.runescape.wiki/w/Blood_rune)). With nothing to bind it
  says "You have nothing suitable to bind." in a message box (rsprox capture 1673).

## The craft

On the click (or on arrival): sequence `human_runecraft` (791), spotanim `runecrafting` (186) at
height 92, sound 2710 (rsprox capture 1693, crafting at the water and mind altars in Guardians
of the Rift).

## Not done yet

- Daeyalt essence (pure essence's runes at 1.5 times the XP) needs the Daeyalt essence mine.
- Dark essence fragments come from the Dense essence mine, the Dark Altar and a chisel, none of
  which exist here yet; the Soul Altar has no handler.
- The Wrath Altar's Dragon Slayer II requirement and the true Blood Altar's Sins of the Father
  requirement: no capture of the refusal.
- Talisman and tiara enchanting at the altars, combination runes and the Ourania Altar.
- The level and rune essence refusals ("You need a Runecrafting level of at least # to craft
  this.", "You don't have any essence in your inventory.") have no capture.
