# Resurrect Crops correction plan

**Goal:** Match the published integer success roll and refuse crops that cannot be resurrected before spending runes or awarding XP.

**Architecture:** Keep the existing Farming spell handler, shared Spell validation, crop lifecycle and one-attempt behavior. Replace its approximate floating success check with the Wiki's integer numerator `floor(64*(level-36)/21 + 0.5)+1` out of 256, using visible Magic capped at 99. Extend existing eligibility checks to redwoods and Hespori; anima/compost and non-dead/already-resurrected crops remain refused.

**Sources:** OSRS Wiki Resurrect Crops (exact formula and excluded crops), Redwood tree (Farming) (cannot resurrect dead redwoods). No unverified probabilities or cache IDs are introduced.

**Isolation:** Independent branch `fix/farming-resurrect-crops` from upstream `106b6f141`, new project-managed worktree. No dependencies on gardener, Bologa or redwood PRs; no edits to concurrent boss/client work, live saves/server or generated data.

## Steps

- [x] Baseline build and Farming tests.
- [x] Reproduce integer-roll boundary errors with the real cast handler and rune inventory at 78, intermediate, 99 and boosted Magic levels. Verify redwood/Hespori rejection preserves runes, XP and patch state.
- [x] Add checks for one attempt, failure clearing, valid resurrection, insufficient runes/level and unaffected Cure Plant/Fertile Soil behavior.
- [x] Implement only the eligibility and integer-roll corrections; run focused checks and server build.
- [x] Independently review and run full server validation.
- [ ] Commit, push and open a separate ready PR with honest testing limits.

## Review focus

Invalid targets must not reach resource consumption. Check the last passing/first failing discrete roll, visible-level boosts and cap, preserved dead-growth stage and one-attempt flag, and failure clearing. Do not invent new probabilities for other Farming systems.

## Evidence and rulings

Baseline server build and Farming/Belladonna checks passed (6 tests). The unchanged spell then failed both the discrete-boundary regression and redwood resource-preservation regression; the latter spent all runes on an excluded target. After the correction, all eight dedicated tests and the 14-test focused run passed. Independent reviewer found no actionable bugs and independently reran all eight dedicated tests.

The Wiki's explicit equation is used rather than its chart: those representations differ by one numerator at levels 87 and 88. This discrepancy is recorded in the spell documentation and will be disclosed in the PR; no live capture establishes exact odds at those levels. Bounds at 78, 90 and 99 agree in both source representations. Visible boosts are capped at 99.

A first additional compatibility test incorrectly expected Fertile Soil to play exactly one animation; its existing behavior also plays the compost animation. The test now verifies that casting occurs and retains its actual rune/compost effects, without changing production animation behavior.

Final server build passed. Focused Farming/Belladonna/Resurrect run passed 14/14. Full server suite passed 4926/4926 (concurrency 4, outside the sandbox), zero failures. Independent reviewer reran all eight dedicated regressions successfully and found no actionable bugs. No live server, saves or concurrent work were modified.
