# Normal Whisperer pursuit movement-pass correction

Continue the authorized normal-mode fidelity plan in owned
fix/whisperer-pursuit-queue, based on current origin/main3434a860a.

1. Classify actual bind projectile packets and current NPC combat levels across
   retained3281/3285/3299, rather than counting replayed animation masks. There are
   22normal791casts:17moving firstWALK+5,5without motion. The five+3cases are
   Awakened1146and excluded. Preserve the altered-world evidence qualification.
2. Reproduce the extra tick using real NPC queues in World phase order: NPC
   movement precedes player-area encounter processing, so queueing at+5 moves+6.
   Add first-position+5, unchanged adjacent-melee+5 and real-counter controls.
3. Prepare distant-target movement one pass earlier while keeping authored
   pursuitTicks5 and adjacent melee eligibility unchanged. No freeze, phase,
   projectile, damage, selection or RNG constants change.
4. Build before testing, observe meaningful RED/GREEN, run all boss/actor suites,
   request code review and validate actual registered NPC movement on own QA world.
5. Push an individual ready PR; selectively integrate into localf2a30aa79 lineage.
   Full combined suite, source/client/save baseline, graceful backup/install and
   byte-level account/client checks. Coordinate and release claims on the board.

This fixes the implementation of the already-intended first-step schedule. It
does not prove ordinary freeze expiry, optional binding conditions, melee roll
distribution or all remaining boss timing/RNG. Claude's claims remain untouched.
