# Whisperer paired melee retaliation

Primary requirement: the current Whisperer Speed-Runner Wiki strategy explicitly
uses double Vengeance on the two equal melee hits. The present raw HitDamage
path bypasses combat retaliation entirely. Fix only this confirmed behavior.

1. Add failing real-player/NPC recoil and Vengeance regressions to
   `server/tests/whisperer.test.cjs`, including rearming between equal hits,
   protected chip, lifecycle cancellation and real NPC-before-player ordering.
2. Add a physical melee helper in `Common.Whisperer.js` using the existing
   PendingHit/CombatFactory queue contract (as the verified Leviathan bite does).
   Add optional generic `PendingHitConfig.bypassProtectionPrayer` (default false)
   in `PendingHit.ts` so one pre-rolled hit keeps the partial-prayer snapshot
   without a dummy roll and duplicate Elysian effects. Cover ordinary defaults.
   Reuse applied-damage tracking for perfection and cancellation. Invoke for both
   hits from `Fight.Whisperer.js`; retain the one damage/prayer snapshot.
3. Verify actual player HP precedes lethal reflected boss damage, frozen grading
   and second-hit cancellation. Preserve existing hazard and projectile behavior.
4. Build, run focused/all boss regressions, review, push a ready individual PR.
   Selectively integrate with live8e1a7b112, preserving Claude's work, all prior
   source exports and client files. Run the combined suite before backup/install.

No new damage distribution, freeze duration, melee recovery or ordinary projectile
immunity claim is introduced. Source: https://oldschool.runescape.wiki/w/Whisperer_Speed-Runner
