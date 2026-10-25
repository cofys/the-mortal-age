# Leviathan Implementation Plan

> For agentic workers: use superpowers:executing-plans task by task; the parent coordinates independent Duke/Whisperer workers.

**Goal:** A functional, isolated post-quest Leviathan encounter with source-backed normal mechanics and verified awakened extensions, published as one tested review-ready PR.

**Architecture:** Attach-only members plugin split into Common, Model, Site, Fight, Hazards and Rewards units. A session owns a templated arena and sequential fight; fixed attack impacts query current protection prayers and applied-damage observers freeze a perfect-kill grade. Canonical drops and generic shared foundations remain separate prerequisites.

**Tech stack:** Existing CommonJS content, TypeScript core through api.core, local OSRS cache, node:test.

**Spec:** docs/leviathan.md.

## Constraints and dependencies

- Own only Leviathan plugin/unit/authored-data/tests/docs files in tsps-pr856-merge/feat/leviathan; preserve earlier PR branches. No Claude-owned clues/client/main/deployment/saves, PluginManager/Types or generated JSON edits.
- Depends on published TSPS#882 (local fix/vardorvis-perfect-loot merged before implementation) for applied damage and canonical conditional loot; coordinate generic NPC stat-drain immunity and grave fee provenance with parent.
- Cache names determine IDs. Wiki determines mechanics. Uncaptured timings must be disclosed. No alternate-RSPS oracle.

## Review focus

- Delayed player damage/loot after death or exit must not alter a frozen/replacement fight.
- Wrong owners, stale prompts and incomplete quest stages must not consume orbs or gain access/rewards.
- Smoke must finish on enrage; stun cannot cancel enrage, and pathfinder spawning must not permit transition prayer piercing.
- Debris clipping/cover/pathfinder movement must agree in instance coordinates and be removed on every exit route.
- Reward hooks must reject quest NPCs, stale/foreign fights and duplicate death notifications; perfect counts are session-scoped, not consecutive.

### Task1: Cache-backed model and source data
- [ ] Add failing tests for gameval resolution, map bridge/template walkability, seven volley tiers, aura/backside/cover geometry and progression/reset invariants.
- [ ] Create bosses/data/leviathan.json (authored), leviathan/Common.Leviathan.js and Model.Leviathan.js. Run tests red then green.

### Task2: Normal attacks and specials
- [ ] Add failing real-core/cache tests for impact prayers, misses/immune damage, chip versus avoidable damage, shadow-spell recognition, front cap/back punish, alternating lightning/smoke and enrage transition.
- [ ] Implement Fight.Leviathan.js and Hazards.Leviathan.js; separate scheduled impacts from fight state, use real HitQueue/HitDamage. Test movement dodges, cover and cleanup.

### Task3: Entry/session/lifecycle
- [ ] Add failing registered-hook tests for quest gate, public rowboat/handholds, scoped confirmation/orb payment, private planes0/1, owner isolation, leaving/logout/death/recovery and respawn.
- [ ] Implement Site.Leviathan.js and Leviathan.plugin.js. Grave location/provenance uses shared events only. Test real instance collision where feasible.

### Task4: Loot, persistence and achievements
- [ ] Add failing tests for single kill count/PB, actual canonical perfect-quantity query, accessible loot tile, separate awakened state and legitimate achievement events.
- [ ] Implement Rewards.Leviathan.js. Never roll/grant duplicated canonical loot. Test invalid ownership/stale death/duplicate notifications.

### Task5: Awakened extensions
- [ ] Verify and test health/stats, shortened stun, cross blockers, tornado pursuit/damage, aura7x7, enrage1tick and shared stat-drain immunity. Do not label an incomplete awakened fight finished.

### Task6: Verification and publication
- [ ] Build using node node_modules/typescript/bin/tsc --build; run focused encounter and relevant queue/drop/quest regressions.
- [ ] Parent independent review; fix findings and rerun affected checks. Commit/push source checkpoints, open a ready PR after fresh validation, attach it to this chat. No live deployment.
