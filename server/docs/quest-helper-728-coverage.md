# Issue 728: Quest Helper quest coverage

Tracks [issue #728](https://github.com/RSPSApp/tsps/issues/728). Per-quest results, findings
and runs now live in **[docs/quests](../../docs/quests/README.md)**, one page per quest; the
issue's roster scope (active, deferred, supplemental) and ledger id (q001...) are on each
page. Follow [the quest testing process](agents/quest-testing.md).

- **References:** Quest Helper pinned at `06da90f982518a093f2fe1c9cfac5547fa7053d3`;
  cache `osrs-241_2026-10-20`; initial server revision
  `be4be8d31d83ded906bd6fd1140a719ba5e45e84`.
- **Roster:** 128 quests; on 2026-10-23 the user deferred 22 long ones, leaving 106
  active. Supplemental: Learning the Ropes (q129), Waterfall Quest (q131); supporting:
  His Faithful Servants (q130).
- **Accepted:** 26/106 active quests (24.53%) had an accepted natural main route when the
  ledger moved to docs/quests on 2026-10-29.
- **Community reports:** the 21 completions in
  [issue #1257](https://github.com/RSPSApp/tsps/issues/1257) (reported by
  thehardcorenoobs1234) are pages with `tester: community`. The user accepted them as
  enough to skip a full manual replay; keep their caveats and check known bugs with
  bounded checks. None overlaps the 106.

## What counts as accepted

A completion counts only when the native report, the actually loaded plugin, reward and
state deltas, persistence, a normal logout and an independent review all agree. Source
reports, regression tests and reviews alone are not native evidence. A checkpoint
continuation counts once with its verified parent prefix, never as a fresh run;
supplemental routes, post-quest checks and retries never add to the count. Declared
ordinary setup aids (skills, commodities, travel, combat aids after real hits) are
allowed; quest-state or item injection and transport or scene bypasses are not. A scoped
pass covers only that route: branches, recovery, full-bag, timing and the Quest Helper
overlay stay unverified unless shown separately.

## History

The full coverage tracker, verification ledger and community exclusions, with their
per-run evidence, are kept in git as of the move:
[coverage](https://github.com/RSPSApp/tsps/blob/4530f44246be/server/docs/quest-helper-728-coverage.md),
[verification](https://github.com/RSPSApp/tsps/blob/4530f44246be/server/docs/quest-helper-728-verification.md),
[community completions](https://github.com/RSPSApp/tsps/blob/4530f44246be/server/docs/quest-helper-728-community-completions.md).
The [PR index](quest-helper-728-prs.md) lists the 108 split PRs.
