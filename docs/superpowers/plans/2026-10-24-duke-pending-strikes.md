# Duke strike resolution and cancellation

The cross-boss audit found two related resolver issues in Common.DukeSucellus:
a dummy zero PendingHit followed by applyStyleDamage can trigger Elysian effects
twice, and cancellation zeros parts without refreshing the cached total used by
retaliation. Reproduce both before changing the Duke helper.

1. Reuse exactly PR #996's optional generic PendingHit protection-bypass flag on
   a separate prerequisite commit. It is already installed locally; the Duke PR
   must disclose this shared prerequisite and contain no Whisperer feature code.
2. Add real-player/cache-NPC regressions to the existing Duke capture-combat file:
   one Elysian reaction for melee/magic; stop/fell cannot consume Vengeance/recoil;
   retained protected damage, normal retaliation, misses and ordinary hazards.
3. Construct a single PendingHit from the existing uniform damage range, bypassing
   ordinary full protection because Duke already chose the protected range.
   Preserve accuracy, equipment/ward effects, HP caps and existing queue timing.
   Track strike totals and refresh them when cancelling parts.
4. Build, run all Duke/combat checks, review, and publish a separate ready PR.
   Selectively integrate only Duke source/tests/docs into local083fd515b; preserve
   the installed generic API, spell context, all prior fixes and Claude content.
   Verify combined tests and native staging, then back up/install locally.

No damage maximum, distribution claim, combat clock or provisional numerical
parameter is newly established here. Primary equipment rule:
https://oldschool.runescape.wiki/w/Elysian_spirit_shield
