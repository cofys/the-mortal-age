# Geomancy browser

Stacked on #1300's native Cast input. Cast opens the cache's farming_view modal even when no crops are planted. The normal spell validation still requires Lunar,65 Magic and3 astral/3 nature/8 earth runes, awards60 Magic XP and refuses combat before payment.

## Sources

- RSProx225/01583 and228/02276: normal-world interface179, OP1 tabs and farming_view_tab updates; model and panel packet sequence. Older patch indices differ from current cache.
- RSProx238/01221 and238/04128: current farming_view_setpanel(1119) signature has4 integer arguments and1 string; these are Leagues captures, used only for UI packet shape.
- OSRS Wiki: https://oldschool.runescape.wiki/w/Geomancy lists crop type,growth,protection,compost,water,yield and continuous refresh without another cast.
- Cache241: enums1233–1238 define patch indices,locations,types,components and crop labels. Script1119 decodes a packed coordinate as stage/yield/water and a bitset as disease/death/protection/waterability/compost. All107 panels map explicitly to canonical world patch coordinates in plugins/skills/farming/data/geomancy-panels.json; quest and duplicate map patches are excluded.

## Implementation

Geomancy.Farming.js owns only the modal/session renderer. Spells.Farming.js opens it after the existing spell validation. Patches.Farming.js attaches native tab/logout handlers and invokes changed-row refresh from its existing Farming task. Model.Farming.js exports its existing diseaseFree predicate so the browser uses the same flower-protection rules as growth.

Tabs are accepted only for an open owned browser, OP1 and slots0–5. Selection is kept in the existing persisted farm state. Closed/replaced modals,death and logout release the renderer. Canonical offline growth advances while open and only changed panel snapshots send updates. This browser never pays again during refresh or stores a second crop state.

Compost progress and counts come from existing bin timestamps and inventory counts. Crop progress/yield reflects this server's existing Farming model; this PR does not change its unpublished growth/yield approximations. Empty farms display every normal patch rather than an empty dialogue. New sailing patch layouts come from this revision's cache and world patch catalogue, not older recordings.

## Verification

Real Player,PlayerSession,ClientConnection,Inventory and PacketSender; all plugins loaded. Only transport/message/render output is captured. Tests cover native Cast costs/gates,107 unique panels,all crop labels,tabs,bad/stale input,protection,disease/death,compost and changed-only refresh/close/logout/reopen. Full-suite and native/client results are recorded in the PR after running them.

Native immunity icons follow238/01221: Troll/Weiss use bit2 (the gardener icon, including empty patches), Harmony bit9 (undead). The cache tooltip calls bit2 a gardener even on the two Troll patches; this is the recorded native behavior. Falador/Fortis passive immunity is not labelled as a paid gardener; there is no measured native icon mapping for those in this PR. Their canonical growth protection remains effective.
