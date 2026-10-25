# Shared poison counter implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. The human has authorized planning and implementation without further questions.

**Goal:** Reproduce the observed shared poison/protection pulse, modal withholding and distinct poison/venom treatment policy without modifying another agent's work.

**Architecture:** A player-owned `PoisonClock` retains the negative protection counter and a 0–30 tick remainder shared with positive affliction. The existing single `CombatPoisonEffect` task advances that clock, including protection-only players. A separate short protection flag covers food/equipment without replacing the counter or curing an existing affliction. NPC timers and generic `SecondsTimer` retain their existing contracts.

**Tech stack:** TypeScript core status lifecycle; existing JavaScript consumable plugins; Node test runner and native MCP staging.

**Spec:** `docs/poison-protection-clock.md`, pinned RuneLite counter interpretation and reduced ordinary-world RSProx1637 fixture. The Wiki Venom page's cited Jagex statement describes strange fruit's separate approximately18-second poison/venom flag. Counter protection ends at -38 for venom and0 for ordinary poison. Initial idle phase is30ticks; historical unknown phases are not claimed reconstructed.

## Constraints

- Own worktree `fix/poison-shared-counter`; no generated JSON, client, Claude Hydra/clue/Farming or shared hit-queue changes.
- Keep one status task per registered living actor; cancellation/logout is not a cure; death resets status and phase.
- Preserve existing phase on cure/conversion/renewal before task processing; a held overdue pulse releases once, never in a catch-up burst.
- Keep old numeric immunity save for compatibility; add an optional validated counter/phase/short-flag snapshot, omitted when unaffected. Legacy seconds give only an approximate tick phase, documented honestly.
- Potion policy remains in plugins: ordinary cures downgrade venom without granting simultaneous protection; anti-venoms fully cure, then apply counter protection. Weaker doses cannot shorten a stronger counter.
- Extend the existing native staging harness; use existing clean-backup/fast-forward/client/account-preservation deployment gates.

## Review focus

1. Replaced/cancelled/logout tasks must not advance newer actor state.
2. A due final negative counter while modal stays protective even if its displayed seconds reach zero.
3. Short equipment/food protection cannot replace a long potion counter or falsely cure affliction.
4. Optional persistence must survive the actual JSON codec and reject malformed phase/counter snapshots safely.
5. The observed capture proves one dose and phase transition, not every potion, idle random phase or animation timing.

## Tasks

### 1. Shared actor pulse and persistence

- [x] Write failing real-player regressions: existing poison phase continues through anti-venom+, modal fixture updates only at captured close, repeated doses retain phase, protection expires after the last held pulse.
- [x] Implement `PoisonClock.ts`, Combat's player timer facade and CPE clock ownership; leave NPC seconds timers untouched.
- [x] Remove the obsolete fractional-pause plugin reconciliation; native PacketSender tracking is the modal authority.
- [x] Persist a validated optional snapshot through PlayerSave, including positive-affliction phase and short flags; migrate old numeric seconds without inventing historical precision.
- [x] Run focused positive/negative status, lifecycle and persistence checks; update obsolete pause assertions to the captured policy without weakening generic timer tests.

### 2. Treatment and protection policy

- [x] Add failing real consumable/CombatFactory tests for ordinary antipoison versus venom, -39/-38 boundary and full anti-venom cure.
- [x] Distinguish player venom protection from ordinary poison protection; keep NPC resistance behavior.
- [x] Implement ordinary venom downgrade versus full anti-venom, preserve stronger counters and use base anti-venom's published -41 tier.
- [x] Route charged serpentine equipment and strange fruit through explicit short poison/venom flags; verify they preserve stronger counters and affliction phase.
- [x] Audit/register canonical missing upgraded/mixed remedies as required; use cache chains, not invented item IDs.

### 3. Review, verify and deliver

- [x] Independent read-only review and source build/focused regressions.
- [x] Selectively integrate owned commits onto the latest installed local baseline, preserving all existing changes.
- [x] Actual doses, held NPC dialogue, boundary susceptibility, short flags and relog on the owned QA server; save/stop QA.
- [ ] One complete combined server suite; fix concrete failures and repeat only where justified.
- [ ] Push source and combined branches, open a ready PR with exact limits/dependencies, attach it, update relevant owned PR status truthfully.
- [ ] Fresh coordination check, safe save/SQLite backup, fast-forward/server build/restart; verify all client hashes/account rows and release live operations.
