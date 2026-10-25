# Arceuus Corruption lifetime

An inflicted Corruption effect belongs to the living, registered target that received it. Target death or unregistration ends the effect, and a subsequent respawn or return does not restart its remaining drains. Ward of Arceuus also nullifies an existing effect. Caster death or logout alone does not cancel an already inflicted effect.

Previously, the delayed task checked registration and Ward only when a drain was due and never checked the target's Hitpoints. It could drain a dead player, or miss a death/departure followed by respawn/return between two drain executions. It now checks target validity on every task tick and again before each scheduled drain. The execution guard is necessary because `Task.tick()` runs a due execution before calling `onTick()`.

Initially dead, unregistered or warded targets are refused before consuming the prepared corruption spell, displaying its graphic or submitting a task. Existing caster independence, chance and hit graphics remain unchanged.

## Cadence and sources

The [Corruption status page](https://oldschool.runescape.wiki/w/Corruption_(status)) and individual [Lesser](https://oldschool.runescape.wiki/w/Lesser_Corruption)/[Greater Corruption](https://oldschool.runescape.wiki/w/Greater_Corruption) pages establish the amounts, cadence and Ward cancellation. The [progress tracker's Status effects task4](https://rsps.app/assets/extensions/rsps-world-auth/osrs-progress.json) explicitly requires delayed Corruption tasks to check registration and target liveness before applying. The Wiki cadence is preserved; the tracker supplies the death/departure lifetime requirement.

| Prepared spell | Drain amounts | Without Mark | With Mark |
| --- | --- | --- | --- |
| Lesser Corruption |1,2,3 Prayer|ticks10,20,30|ticks5,10,15|
| Greater Corruption |2,4,6 Prayer|ticks10,20,30|ticks5,10,15|

The task still uses its original5/10-tick delay. The per-tick validity check does not advance the drain counter or shorten its intervals. No new duration or caster-lifetime rule is introduced.

## Verification

Five lifecycle regressions failed against the previous implementation: death/respawn between executions, death on a drain tick, unregistration/return between drains, Ward between executions, and initially invalid target application. The new tests drive the actual `Task.tick()` countdown rather than calling `execute()` directly. Controls cover all four spell/Mark combinations, exact amounts and ticks, termination after three drains and caster death/logout after application.

The Ward fixtures use an unambiguously active timestamp and manually clear it, so these lifecycle checks do not depend on the spellbook's timestamp representation or assert a new Ward duration.

Validation: fresh TypeScript build and all23 checks in `tests/magic-stance-bonuses.test.cjs` pass. No full-suite or live-server verification is claimed by this isolated change.
