# Gardener currency correction plan

**Goal:** Let ordinary currency pay gardeners to remove checked trees, keeping the 200-coin fee and Alexandra's 2,000-coin redwood fee.

**Architecture:** Replace only the gardener transaction's ambiguous name-based currency lookup with the existing cache-generated `ItemIdentifiers.COINS`. Keep the existing nearby-patch, health-check and stale-menu guards, crop protection and clearing implementation. No canonical/generated data or client changes.

**Sources:** OSRS Wiki Tree patch and Redwood tree (Farming); cache revision 241 identifies normal coins as 995 and the non-stackable quest item also called Coins as 617.

**Isolation:** Branch `fix/farming-gardener-currency` from upstream `106b6f141`, using this chat's isolated checkout. Independent of PRs #903 and #904 and concurrent boss/client work. No live-world deployment or save changes.

## Steps

- [x] Reproduce through the real gardener NPC/menu callback with real Player inventory: tree and fruit-tree removal for 200 coins, redwood removal for 2,000, enough/insufficient currency, unchecked trees, stale/repeated menu and distant players.
- [x] Observe normal-currency regressions fail (three failures), replace the two transaction lookups with the cache currency ID, rerun focused checks.
- [x] Build, run appropriate server checks, independently review and document evidence.
- [ ] Commit and open one separate ready PR.

## Review focus

No charge on failed removal; exact fee charged once; quest coins are not spendable currency; clearing replaces old patch state; unchanged gardener-protection behavior.

## Validation

Server build passed. Focused gardener/Farming model/Belladonna run passed 11/11. Full server suite passed 4923/4923 with concurrency 4 outside the sandbox, zero failures. Independent reviewer found no actionable bugs and independently reran the five gardener tests successfully.

Tests use the actual Services handler, Player inventory and patch-clearing behavior. The gardener NPC/menu and map lookup are fixtures; actual Alexandra spawn/actions and live client dialogue routing were not verified. No live-world deployment or other-chat changes.
