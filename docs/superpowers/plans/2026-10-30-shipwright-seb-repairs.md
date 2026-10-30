# Shipwright Seb repairs implementation plan

> Execute with superpowers:executing-plans, task by task. Independent review is required before publication.

**Goal:** Enable Seb's native Repair-boat action and canonical Talk-to repair choice for the boat currently visiting the shipyard.

**Architecture:** A members-only Sailing plugin owns repair quotes, confirmation and payment. Reuse canonical Seb dialogue through `npc-dialogue:start` and its existing per-request `select` projection; replace only the repair branch with a plugin action which starts the live quoted flow. Reuse Shipyard's exact visited-boat owner, real Inventory/Bank, bank-PIN guard and BoatHp healing/synchronisation. No generated-data or shared dialogue-owner changes.

**Sources:** Current Wiki Shipwright Seb and Boat pages: Seb only,50coins per missing HP, inventory payment with whole-fee bank fallback. Canonical `npc-dialogues.json` already contains Seb's repair question, quoted confirmation, Yes/Yes-and-don't-ask/No and worker/completion lines. Cache241: sailing_shipyard_manager/vis NPCs15351/15352, Repair-boat op4, boat_repair_cost_warning_dismissed. Local RSProx has13records of Seb and Trade in235/3455, but no repair action; exact repair timing/animations cannot be claimed from captures. Keep canonical source text rather than guessing new dialogue. Record implementation choices where sources omit behavior.

**Base/isolation:** New own branch feat/shipwright-seb-repairs, slot12 (3112/43712/49812), initiallyf3a000b49, fast-forwarded to newly merged dialogue-owner foundationb3c813bb1. The app worktree helper rejects the nested repository, so Git fallback follows the repository directory convention. Existing dependency/cache junctions avoid installation/copying. Compiled inputs changed with the new dialogue foundation; one incremental server build is needed. No client source changes: verify an existing production client's source revision before reusing it.

## Task1: establish the real path and failing behavior

- [x] Read Shipyard.visitedBoat/refreshShownBoat, BoatHp.heal/sendHitpoints, actual currency mutation, PIN resume behavior, NpcDialogues action replacement guard and native menu resume ownership.
- [x] Add a focused real-actor test using actual shipyard visit, NPC dispatcher, dialogue manager, Inventory/Bank and all enabled plugin startup hooks. Observe Repair-boat missing before implementing.
- [x] Test a successful damaged boat and its exact charge/HP/client update, plus healthy/no visited boat, insufficient funds, declined/repeated/stale confirmation, changed/replaced boat, leaving/logout/trade/death and bank-PIN fallback where relevant. Prefer grouped material scenarios over mirrored implementation tests.

## Task2: implement the bounded service

- [x] New ShipwrightRepairs.plugin.js entry and shipwrightrepairs/Repair.ShipwrightRepairs.js unit; named attach-only hooks and core through api.core.
- [x] Bind Seb by name for Repair-boat and Talk-to. Preserve all other canonical Talk-to branches via the transcript projection; route only the repair branch to the same quote function as op4.
- [x] Quote the current visited boat's missing HP at50coins each. Confirmation retains exact boat/NPC/session and quoted damage/fee; revalidate before atomic currency charge+healing, preserving cargo, facilities, location and unrelated boats. Decline/refusal consumes nothing.
- [x] Prefer complete inventory payment; otherwise request the shared bank-PIN guard and revalidate on resume before taking the entire fee from the bank. No combined-source payment unless authoritative evidence establishes it. Never silently repair/recover a sunk or unrelated boat.
- [x] Support the canonical don't-ask-again choice with persistent namespaced preference and the named cache varbit on success/login. Subsequent repairs still revalidate all conditions and funds.
- [x] Refresh stored HP and shipyard display through existing owners. Source confirmation is dialogue-based; do not invent worker NPCs or exact repair animation/tick timings.

## Task3: targeted validation, review and publication

- [x] Incremental server build only because the merged dialogue dependency changed; no rebuild of unchanged client/compiled sources thereafter.
- [x] Run focused repair cases through the real shipyard/boat-HP/dialogue/PIN consumers; no automatic full-suite run.
- [x] Independent reviewer reads actual shared owners and executes a chosen stale-session/PIN/boat-replacement adversarial transition on the reviewed source/build.
- [x] Native production-client Repair-boat and Talk-to paths show fee, confirmation, decline, success, repeat preference and HP/client state. Clearly disclose fixture boats/damage/coins.
- [x] Gracefully save/stop only own slot12 server/static client, close own tab and verify owned ports clear. Publication follows these completed checks: signed forward fork push, focused PR body with sources/limits/results, ready after review; release coordination claim. No live deployment.
