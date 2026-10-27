# Chompy chick acquisition checks

Source baseline: main 2c8cf71af, 27 October 2026. This fixes the Pets tracker quest/activity
acquisition gap for Chompy chick, not all Chompy hunting behaviour.

## Evidence

- [Wiki: Chompy chick](https://oldschool.runescape.wiki/w/Chompy_chick): the elite Western
  Provinces diary and its claimed reward are required; killing and plucking each roll 1/500.
- Shipped generated `npc-drops.json`: `tables.chompy_bird.entries` already has item13071,
  weight1, out_of500, main_max_roll500. The tracker missing-row note is stale. No data edit.
- Cache NPC1475 `chompybird` has Attack; NPC1476 `chompybird_dead` has Pluck (option4).
- Local RSProx index has sightings but no indexed actions for these gamevals. No recording
  supplies the reward condition or timing; those come from the Wiki and cache.

## Behaviour

- Replace the never-set synthetic elite-diary flag with a query of canonical claimed rewards.
- Existing kills retain their existing configured roll. Successful owned-corpse plucks request
  only the chick row through the shared roller, retaining its denominator and award service.
- Consume each tracked corpse once. A full bag retains it; multiple corpses remain independently
  pluckable. Reject foreign, stale, unregistered, dead/busy, distant, other-plane or other-area input.
- Common Pets ownership, duplicate, collection-log and insurance/reclaim paths handle delivery.

## Verification

- New real-object tests load the shipped cache, maps and all plugins. They exercise real diary
  claims, quest bait release/death, native queued Pluck, deterministic winning/losing configured
  rolls, full bags, invalid inputs, multiple corpses, duplicate awards and fresh Player save reload.
- Legacy quest fixture tests now create a tracked corpse, stand beside it and retry the same
  corpse after freeing space. Their reward and removal assertions remain intact.
- Independent Codex review caught the initial latest-corpse-only guard. A two-corpses regression
  reproduced it; the identity-set implementation and final fixture changes passed re-review.
- Native isolated slot10: prepared elite claimed state in only the QA SQLite profile; admin quest
  completion, stats and items were setup. Equipped Ogre bow/arrows, teleported to Feldip, released
  bait, used Attack, observed the death/corpse and kill varp294=1, then Pluck. One raw chompy arrived,
  the corpse vanished and the repeated click reported no NPC. No rare pet happened in this walk;
  winning rolls are verified deterministically in the real-object tests.
- The native combat walk increased Strength XP despite the equipped bow; this existing weapon
  classification is outside this pet-acquisition fix. No claim of complete hunting parity.
- Own server stopped through `gameUpdate 3s`, saved the QA player, and released ports3110/43710/49810.
  No live-game installation or restart.

Final verification: TypeScript build passes; focused70/70; full suite9,117/9,117,
no failures or skips (352 seconds), with test concurrency4. `git diff --check` passes.
