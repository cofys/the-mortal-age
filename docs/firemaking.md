# Firemaking: tending Forester's Campfires

## Confirmed behaviour

The [Forester's Campfire Wiki page](https://oldschool.runescape.wiki/w/Forester%27s_Campfire)
and [Fire Wiki page](https://oldschool.runescape.wiki/w/Fire) establish the gameplay rules:

- The first log added to a normal fire sets the campfire duration. The original fire's
  remaining lifetime does not contribute. Regular logs give 102 ticks; oak gives 109.
  The duration is measured from the campfire appearing to disappearing.
- Later logs extend the timer by the log's published increment, capped at 300 ticks.
- Ordinary permanent fires can be converted. When the campfire expires, the permanent
  fire returns and ashes appear. Fires with a Cook option are excluded.
- Coloured fires retain their colour when converted.
- Tending consumes one log every nine ticks and grants the full normal Firemaking XP.
  A single carried log type starts directly; multiple types offer a type and quantity
  choice. Completing the selected quantity or exhausting logs ends the animation.

Rsprox recording **1723** (revision 227, Leagues V) supplies presentation evidence:

- The selection title is “What would you like to burn?” and its skillmulti mode is 27.
- Willow tending uses `forestry_campfire_burning_willow_logs`; each consumed log plays
  `forestry_campfire_burning_spotanim` at the fire. No tending-attempt or log-added chat
  messages accompany that recorded loop.
- Check displays the remaining-time description in a message box with Continue.

That recording predates the normal-game timing change: its four-tick interval is **not**
used. The Wiki records the May 2025 change to nine ticks and full XP. Cache revision 241
confirms the fire/campfire colour pairs, log-specific sequences and graphic. Sequence
selection for other log types follows the corresponding cache names; only willow's
sequence was observed in the recording.

## Changes and verification

Previously, the handler accepted `roving_fire` rather than ordinary `fire`, preventing
conversion of permanent fires such as Prifddinas and Edgeville Dungeon. A converted
player-made fire also inherited the larger of its old lifetime and the added log's
lifetime. Permanent-fire expiry restored the object without ashes. Mixed inventories
silently selected a log, and tending used a cooking animation and extra chat messages.

The plugin now selects valid fire variants, preserves colour, sets the first-log timer,
restores permanent fires with ashes, offers the carried-log selection and respects its
quantity. Check uses the existing message-box dialogue. The plugin delegates to a named unit, with core access through the plugin API and named hooks.

Automated regressions cover the first-log lifetime, all six fire/campfire
pairs, restored objects and ashes, selection/quantity, nine-tick reward boundary, XP,
willow animation/graphic, message box, exhausted logs and rejection of Cook fires and
insufficient levels. The regressions fail against the previous implementation.

Live action checks confirmed conversion of the Prifddinas permanent fire, log consumption,
XP, the mixed-log menu, its selected reward, expiry, permanent-fire restoration and ashes.

## Evidence limits

The indexed tending recording is an older special-world recording. Current gameplay rules
come from the Wiki; there is no current main-game tending recording in the inspected index.
The exact ambient smoke cadence and current looping versus non-looping sequence choice
need newer capture evidence. No visual equivalence is claimed.

The existing interpolated campfire durations for jatoba, camphor, ironwood and rosewood
remain unchanged: the inspected Wiki does not publish their durations. These values need
additional evidence before changing them.

Normal tinderbox lighting is a separate interaction. Recording **1035** shows logs move
from inventory to the ground at the start of lighting, whereas this server consumes them
on success. Its lighting messages also differ; that path is outside this tending fix.
