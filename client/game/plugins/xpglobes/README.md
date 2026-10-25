# XP Globes

A port of RuneLite 1.13.3's XP Globes. Turn it on in the plugin list; it is off on fresh installs.

When a skill gains experience, its globe appears at the top centre of the game view: the skill
icon on a translucent circle, ringed in black, with an arc in the skill's colour showing
progress to the next level (or to your XP-drop goal, as the XP Tracker sees it). Up to five
globes show at once, in skill order; each disappears after "Duration of orbs" seconds without
a gain.

Hover a globe to darken it and show the percentage, plus a tooltip with the skill, level and
current XP, then (unless the goal is reached) actions left, XP left, XP per hour and time left.
Hovering keeps the globe from expiring.

Right-click over the globes for **Flip XP Globes overlay** (a column instead of a row) and
**Configure XP Globes overlay** (this plugin's settings). Alt-drag moves them.

## Settings

As RuneLite: tooltip lines, hide maxed skills, show virtual levels, a custom arc colour, the
outline and background colours (with alpha), arc width, orb size and orb duration. The keys
are RuneLite's, spaces included (config group `xpglobes`).

## Differences from RuneLite

- RuneLite reads goals and rates from the XP Tracker. With the XP Tracker off here, the arc
  runs from the current level to the next, and the tooltip leaves out actions left, XP per
  hour and time left.
