# Leviathan Normal Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the complete remaining normal encounter gap ledger using original evidence, implement source-supported mechanics and retain no unsupported claim of completion.

**Architecture:** Keep encounter content in the existing Leviathan units. Add a dedicated achievement unit if needed for complete restriction tracking. Authored encounter parameters carry explicit evidence references; original packet/video measurements replace provisional constants only after mode/equivalence checks. Root owns shared loot progression and any approved generic core foundation.

**Tech Stack:** JavaScript plugin units, real cache/Player/NPC/PendingHit/HitQueue tests, original RSProx packet events and original normal-world videos.

**Spec:** `docs/leviathan-normal-evidence.md` and `docs/leviathan.md`.

## Constraints

- Preserve published pathfinder branch; work on `fix/leviathan-normal-fidelity` from `ef8813b1c`.
- Own Leviathan modules/tests/docs/authored encounter data only. No live/main/client/clues/generated-data edits or restart.
- Other agents work concurrently. Capture worker owns shared decoder; root owns shared DT2 loot and generic core changes.
- No numeric guess replaces another guess. Do not declare normal complete with unresolved numeric/layout requirements.
- User authorized planning/implementation in current mode and publishing after review; no additional confirmation gate.

## Review focus

- Source age: pre-August2023/pre-February2024 recordings may contain corrected behaviors.
- Special-world player multipliers do not prove ordinary NPC damage/stat values; respawn timers may be accelerated.
- Same-tick healing above25 followed by damage must invalidate Unconventional; tick snapshots alone are insufficient.
- Damage/ammo attribution must distinguish owner, thrall, attempted/splashed attacks and launched ammunition before equipment swaps.
- Repeated kills, exit, death, relog and dynamic debris must not preserve stale phase/achievement state.

### Task 1: Complete evidence acquisition and source-backed volley rules

- [ ] Enumerate every current constant and functional hole in the evidence ledger.
- [ ] Obtain normal-video captions/frames and filtered original packet events; record source IDs, tick offsets and world/mode constraints.
- [ ] Red tests for tier-specific volley counts and measured transitions/flight times.
- [ ] Implement verified schedule/animation/roar behavior, then green against real core/cache regressions.

### Task 2: Hazards, layout, travel and lifecycle fidelity

- [ ] Resolve lightning/smoke damage, timing, cover and tell behavior against primary observations.
- [ ] Resolve pool/bite geometry, tails, pathfinder actor/aura route and graphics.
- [ ] Resolve normal travel, scoreboard, kill timer and respawn sequence.
- [ ] For each correction: failing regression first, implementation, green; do not broaden into unverified awakened behavior.

### Task 3: Complete normal achievement/combat integration

- [ ] Verify cache ammunition/weapon categories and actual attack provenance; implement Unconventional with strict HP changes using an existing or root-approved generic foundation.
- [ ] Verify thralls, cannon immunity, poison behavior and remaining normal CAs with real-core integration tests.
- [ ] Coordinate boss-specific loot facts/IDs with root; consume shared integration rather than duplicating loot logic.

### Completion

- [ ] Every normal ledger requirement is supported and verified; investigate remaining evidence gaps rather than declaring completion.
- [ ] Build, focused and full server checks, independent review and corrected regressions.
- [ ] Push checkpoints; publish separate ready PR with prior dependencies, attach it and give root feature-only hashes for local installation.
