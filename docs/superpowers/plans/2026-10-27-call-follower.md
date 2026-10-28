# Call follower implementation plan

**Goal:** connect native cache387:7 to owned-follower recall without interrupting the player's actions or dialogues.

**Evidence:** Wiki Call_follower (non-interrupting,5-tile boundary or collision-blocked path); captures232/3213 close/busy,229/2785 absent,239/4288 follower index replacement. Cache241 wornitems:call_follower is387:7 op1. Wiki takes precedence over a blanket busy() guard: interface/dialogue/action alone must not cancel or refuse recall.

**Files:** new Call.Pets.js subunit, existing Pets.plugin.js attach and optional replacement location, real native call-follower.test.cjs, evidence doc. No generated data/core/client/Claude edits. Automatic catch-up and dog/Bloodhound clue-dig integration remain separate.

- [ ] Reproduce native button no-op and existing generic widget fallback answering an unrelated dialogue.
- [ ] Route the exact cache button through the existing early player:widget-action policy hook, consuming unsupported operations without affecting other widgets. Validate current owned registered visible NPC; preserve safe refusal state and area policies.
- [ ] Check same-area/plane distance4 vs5 and actual static walk collision. Reuse real follower replacement and choose a walkable reachable adjacent tile. Preserve item/form, ownership, active persistence and cat clock. Never consume/give inventory or manipulate player queues/dialogues/tasks.
- [ ] Exercise full/empty inventories, foreign/stale/hidden/queued NPCs, real Bank save/relogin, actual private areas, player movement/tasks/dialogues and native browser input. Independent Codex reviewer traces dispatcher, collision/private-area and lifecycle owners, chooses a real adversarial transition and verifies the exact build/source hashes.
- [ ] Run full suite after source freeze, publish separate ready PR, clear own QA services/browser/slot. Document unverified timings and dependency limits; never call all Pets complete from tracker labels.
