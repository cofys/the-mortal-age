# Leviathan Pathfinder Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Prevent avoidable pathfinder stalls and activate its effects when its NPC actually registers.

**Architecture:** Keep the existing encounter, clockwise corner destinations and authored movement interval. Replace only the monotonic greedy next-step choice with a deterministic breadth-first search bounded by the arena floor. Gate effects and the movement schedule on actual registration, with no additional invented activation delay.

**Tech Stack:** Existing JavaScript boss units, revision 241 cache collision, Node test runner and real Player/NPC/HitQueue fixture.

**Spec:** `docs/leviathan.md`; [Wiki strategy](https://oldschool.runescape.wiki/w/The_Leviathan/Strategies) for clockwise pathfinder behavior; [boss change history](https://oldschool.runescape.wiki/w/The_Leviathan) for protection until the pathfinder spawns (16 August 2023).

## Global Constraints

- Branch `fix/leviathan-pathfinder` starts at `feat/leviathan` commit `94e435684`; PR depends on #892.
- Modify Leviathan units/tests/docs only. No generated data, client/clues, main/live checkout, saves, deployment or server restart.
- Other agents are working concurrently; preserve their work.
- Normal mode only; awakened remains inaccessible. Retain documented unknown timings and damage maxima.
- Use existing collision and APIs through `Common.core`; do not introduce core changes or guessed IDs.

## Review Focus

- An open detour may initially maintain or increase distance to the destination.
- Diagonal movement must not cut through blocked orthogonal neighbors or cache wall clipping.
- Fully sealed or blocked destinations must leave the pathfinder stationary without unbounded searching.
- Delayed NPC registration must not activate effects or move an invisible NPC.
- Correct impact prayer works inside the registered aura and before registration; outside it, registered enrage attacks pierce protection.

### Task 1: Bounded detours

**Files:** Modify `server/plugins/bosses/leviathan/Hazards.Leviathan.js`; create `server/tests/leviathan-pathfinder.test.cjs`.

**Interface:** Preserve `stepToward(from, to) -> [x,y]`. Use deterministic neighbor order, `open(tile)`, both orthogonal neighbors for diagonal safety, and `RegionManager.canMove` for each adjacent center-tile transition. Search visits only the finite arena floor, with the starting point allowed so an initially blocked fallback corner can escape.

- [x] Write actual-cache regression: from `(2074,6379)` toward `(2089,6379)`, debris at `(2075,6378..6380)`; prove movement and eventual arrival through a valid detour.
- [x] Add deterministic tie, orthogonal corner clipping, cache wall clipping, sealed-route and blocked-goal checks.
- [x] Run and record expected red failures before implementation.
- [x] Implement minimum bounded next-step search and run green.

### Task 2: Registration-driven activation

**Files:** Modify `Hazards.Leviathan.js`; extend `leviathan-pathfinder.test.cjs` and `docs/leviathan.md`.

**Interface:** `pathReady()` is true precisely when the pathfinder NPC is registered. Initialize the first movement due tick from the first observed registered process cycle plus the existing interval; preserve subsequent interval and clockwise destination changes.

- [x] Add red regressions for registered aura activation without two extra ticks and no effects/movement while registration is delayed.
- [x] Exercise real impact damage with protection before registration, inside the registered aura and outside it.
- [x] Pin movement interval and clockwise corner progression.
- [x] Remove artificial activation offset; run green and document remaining capture gaps.

### Completion

- [x] TypeScript build and all Leviathan regressions pass; run relevant collision/combat regressions.
- [x] Independent source-worker review, address findings, then fresh checks.
- [x] Commit/push feature-only changes, create ready follow-up PR with dependency #892, attach it, and report hashes to root for local integration.

Validation: all seven new checks failed on the old implementation, then passed. TypeScript build, 62 unique focused/combat/template regressions and all 4,987 server tests pass with zero failures/skips. Independent source-worker review is clear. Ready PR: https://github.com/RSPSApp/tsps/pull/894 (depends on #892).
