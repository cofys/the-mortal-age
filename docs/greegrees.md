# Greegrees

`server/plugins/items/Greegrees.plugin.js` (members). Wielding a greegree turns the player into
the monkey whose bones went into it, by an NPC transmogrification in the player's appearance.

## Where it works

- **Ape Atoll** (its four map squares on every plane, and the dungeons under them, y 9088-9215)
  and **the Ardougne Zoo** pen (Wiki: "Zooknock's magic doesn't work over long distances, except
  at the Ardougne Zoo"). These are one `Area`, `GreegreeArea`.
- **Leaving** by any means (walking, a boat, a teleport) takes the greegree off: into the
  inventory, or onto the ground when it is full (Wiki, Ninja monkey greegree (small): teleporting
  off with a full inventory drops it "where they teleport"). Logging out keeps it on; logging back
  in on the island turns the player back into the monkey without the effects, and logging in off
  it takes the greegree off.

## Forms

| Greegree | Form (npc) | Transform sound |
| --- | --- | --- |
| Karamjan monkey (4031) | Monkey (1469) | 1677 (captured) |
| Ninja monkey, small (4024) | Small ninja monkey (1462) | 1671 |
| Ninja monkey, medium (4025) | Medium ninja monkey (1463) | 1677 |
| Gorilla (4026) | Gorilla (1464) | 1676 |
| Bearded gorilla (4027) | Bearded gorilla (1465) | 1676 |
| Ancient gorilla (4028) | Ancient monkey (1466) | 1676 |
| Zombie monkey, small (4029) | Small zombie monkey (1467) | 1680 |
| Zombie monkey, large (4030) | Large zombie monkey (1468) | 1680 (captured) |
| Kruk monkey (19525) | Kruk (6804) | 1677 |

The NPCs are the cache's `mm_transmogrification_*`. The cache has no Kruk transmogrification;
`mm2_kruk_noncombat` (6804) is the plain Kruk. Changing back plays the form's reverse sound
(monkey 1681, small monkey 1683, gorilla 1674, zombie 1690).

## From the captures

rsprox captures 1440 (Karamjan, rev 224, Marim's temple) and 3342 (large zombie, rev 235, the
Ape Atoll dungeon). On the tick of the wield:

- spotanim `windwave_impact` (160) at height 124;
- the equip sound 2238 (`default_equipment`, played by the equip itself) and the form's sound;
- the spellbook tab closed (`if_closesub` side6) with its stone's events cleared, and
  `toplevel_sidebutton_switch` to the inventory;
- the combat tab shows "Category: Unarmed" (varbit 357 = 0, from the item's weapon type);
- no chat message.

Wielding one in combat is refused with "You cannot use this whilst in combat." (3342, twice).

## While transformed

- Monsters on the island (and the zoo) are not aggressive (Wiki: "In monkey form, monsters on the
  island become non-aggressive"), through the Area's `npcAggression`.
- The zombie forms can only walk (Wiki: "Only the small and big zombie greegrees force slow
  movement"); running is turned off each tick they try.
- The player can't attack ("You can't attack while you're a monkey.", the Area's `canAttack`); they
  can still be attacked.
- The spellbook comes back when the player turns back.
- **The equipment tab:** the client draws it from the player's appearance, and a transformed
  appearance carries the NPC instead of the items (the OSRS format). So while a player is
  transformed the server also sends the worn inventory (94), as live does (`update_inv_partial`
  worn in both captures), and the client keeps it rather than clearing it from the appearance.
  This is in core (`Player.setNpcTransformationId`, `Equipment.refreshItems`), so any player
  transformation keeps its equipment tab.
- Other plugins ask for the form with `greegree:form` (`{ player, form: null }`); `form` is the
  form's key (`small-ninja-monkey`, `kruk`, ...) while transformed. The Ape Atoll Agility Course
  uses it.

## Not verified

No capture or Wiki text covers these. From RSPS code:

- the transform sounds other than 1677 and 1680, and the reverse sounds;
- the graphic on changing back;
- "The Monkey Greegree wrenches itself from your hand as its power begins to fade...", shown on
  leaving the island and when wielding off it (the off-island refusal has no known message).

Chosen here:

- Kruk's form NPC;
- the attack refusal's text.

Monkey Madness I still checks the Karamjan greegree itself for its disguise steps.
