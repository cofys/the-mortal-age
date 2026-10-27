# Olmlet delivery implementation plan

**Goal:** Route a rolled Olmlet through the existing pet award service when its owner searches the Ancient chest.

**Architecture:** Keep the existing unique-conditioned 1/53 roll. Consume only the pet reward through `npc-drops:roll` before native chest presentation/transfer; the pet service owns insurance, collection log, follower/backpack and duplicate handling. Preserve ordinary rewards and fallback if Pets is disabled.

**Evidence:** Wiki Olmlet and Ancient chest establish rate, follower/backpack/full rules. Pinned revision241 symbols confirm `olmpet`, `raids_olm_pet`, `raids_reward_chest` and `raids_rewards`. No indexed `olmpet` recording; exact award tick relative to first search is not recording-verified. Do not claim 1:1 timing.

**Constraints:** Own worktree only; no generated JSON, Claude/clue/League/live edits. Inline execution authorized by Curt. Separate ready PR after independent Codex review and native rendering checks; stop owned services and release slot afterward.

1. Add real Player/Raid/native packet regression: generate controlled unique+pet, search chest, assert follower/ownership/log and no pet remaining in rewards. Watch failure.
2. Add minimal pet-consumption helper and call before chest transfer/presentation and leave fallback. Retain existing RNG and ordinary loot.
3. Exercise existing follower, full bag, duplicate search, real bank round trip, saved ownership, another raider, no-unique roll and leave-before-search. Read shared owner paths.
4. Build, focused and full suite, own-server native inputs and rendered client; document source/path map and limits.
5. Independent reviewer traces unchanged systems and runs a self-chosen adversarial lifecycle plus foundational tests on exact build. Fix findings, re-review, commit/push/open PR, release claim and clear own servers/slot.
