# Canonical NPC elemental weakness implementation plan

> **For agentic workers:** Execute inline with superpowers:executing-plans and test-driven-development. Planning and implementation are already authorized without more questions.

**Goal:** Make canonical elemental weaknesses affect the eligible standard spells through the shared combat pipeline, including the Whisperer's published60% Earth weakness.

**Architecture:** Preserve canonical type/severity in NpcDefinition through the existing name-guarded loader. Add generic calculation-stage custom events to the existing formula foundation: base magic maximum, final magic maximum with the pre-equipment base, and final target-aware magic attack roll with its raw base. Plugin-owned elemental policy applies additive weakness bonuses and standard-family base scaling. Existing Royal Titans weakness multipliers move to this shared path; its unique minion accuracy/row rules remain.

**Primary evidence:** OSRS Wiki Elemental weakness and The Whisperer (June2025 change), plus original Wiki DPS calculator commit `d50c49c589793dc2ee691592015ba63ff9c49fab`, `src/lib/PlayerVsNPCCalc.ts`, `src/types/SpellMax.ts` and `src/tests/calc/ElementalSpells.test.ts`. No other private-server code.

## Constraints and formula

- Own worktree `fix/npc-elemental-weakness`; do not edit generated monster exports, Claude boss/client/clue work or Farming.
- Standard strike/bolt/blast/wave/surge only. Ice, god spells, powered staves and non-damaging spells receive no elemental bonus.
- Damage adds `floor(baseMaximum * severity /100)` after prior equipment/Slayer/Salve modifiers; do not multiply the final geared maximum by weakness.
- Accuracy adds `floor(rawAttackRoll * severity /100)` after other accuracy modifiers. Do not multiply the already-boosted roll by weakness.
- Standard elemental spell families scale from unboosted Magic level, as the pinned original calculator specifies; base additions such as Chaos gauntlets precede equipment and weakness. Verify matching elemental amulet handling before adopting its base addition.
- A target or spell change in the same world cycle must not reuse a target-dependent elemental bonus. Cache only the raw actor roll; evaluate target modifiers each time with the actual enemy.
- Preserve Royal Titans row-clearing, minion hit chance and force-max behavior while removing duplicate general weakness scaling.
- Keep generic calculation hooks safe for invalid/nonfinite plugin results and document their payloads; register handlers attach-only through api.core/custom events.

## Tasks

### 1. Data and failing end-to-end formula evidence

- [ ] Reproduce missing type3/severity60 on the actual Whisperer row through NpcDefinitionLoader.
- [ ] Failing vectors: matching/wrong element, all five families, base-level/boost distinction, additive geared rounding, raw-roll accuracy bonus, explicit spell override and same-cycle target switch.
- [ ] Failing Royal Titans shared-path vectors and no-double application; verify canonical row/name mapping for all variants.
- [ ] Inspect and record amulet/Chaos/base ordering from primary sources before changing it.

### 2. Shared foundation and plugin policy

- [ ] Add validated definition fields/accessors and name-guarded canonical loading.
- [ ] Add generic base/final maximum and final attack-roll calculation events, preserving explicit spell/target context.
- [ ] Keep raw actor-roll caching; make target-dependent modifiers fresh per calculation.
- [ ] Implement eligible spell metadata/family scaling and additive weakness in a plugin. Move Chaos gauntlets to the generic base stage; migrate Royal Titans away from its duplicate general multipliers.
- [ ] Update actual existing test doubles only where APIs changed; retain or strengthen gameplay assertions.

### 3. Deliver

- [ ] Fresh source build/focused checks and independent review.
- [ ] Selectively integrate owned commits onto the latest installed local baseline; preserve unrelated source/client changes.
- [ ] Existing native staging harness: real elemental casts against the actual normal Whisperer and representative targets; verify wrong elements/other spellbooks and Royal Titans behavior. Save/stop QA.
- [ ] Complete combined suite; repair concrete failures, rerun only as justified.
- [ ] Push source/combined branches, create ready PR, attach it and report exact evidence/limits.
- [ ] Fresh coordination/baseline, clean save/SQLite backup, fast-forward/server build/restart; verify served assets/account rows and release claims.
