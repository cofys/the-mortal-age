# Farming redwood branch regrowth implementation plan

**Goal:** Make the four player-grown redwood chopping spots deplete and regrow independently, without changing Woodcutting Guild redwoods.

**Architecture:** Farming owns per-player branch deadlines and cache-derived branch presentation. Woodcutting retains log, axe, XP and session ownership, selecting a farmed-redwood profile through the existing `woodcutting:chop` request. Use existing custom events rather than feature logic in core.

**Sources:** OSRS Wiki, Redwood tree (Farming): four spots, 1/11 depletion per successful log, 200 game ticks to regrow. Regular Redwood tree: 440-tick Forestry depletion and 199-tick respawn, deliberately separate. Local cache is authoritative for branch locs, transforms and varbits.

**Isolation:** Branch `fix/farming-redwood-branches`, worktree `tsps-fix-farming-redwood-branches`, based on local main feaf6bc7c. No changes to another checkout, served client, generated JSON, installation metadata or live saves/server. Use scripts/wt-assigned ports only.

## Steps

- [x] Inspect cache branch transforms and map placements; record verified IDs and visuals.
- [x] Run existing Farming and Woodcutting checks as a baseline.
- [x] Add failing regressions for one branch depleting without blocking the others, independent deadlines at 200 ticks, private state across players, save/relog/offline recovery, and unchanged ordinary tree behavior.
- [x] Implement branch state and private presentation in the Farming plugin; retain one plantable patch. Update the existing Woodcutting request to select the farmed profile with 1/11 depletion and 200-tick respawn, without a Forestry countdown.
- [x] Verify integration through the actual hooks, including cache-derived branch variants, branch removal/replant cleanup and old whole-tree stump saves.
- [x] Run focused tests and server build, review the whole diff, update Farming fidelity documentation, and commit only the isolated work.

## Review focus

- Multiple branches and players must never share depletion state.
- Regrowth must happen at the tick deadline, rather than the minute-based growth sweep.
- Geometry refresh and the object's interaction definition must agree with the private varbits.
- Empty/unchecked/newly replanted trees must not inherit old branch state.
- Existing farmed trees and wild redwood Forestry timers must retain their behavior.

## Execution record

Planning completed before implementation. User explicitly authorized proceeding with the Farming fixes; execute in this chat. Cache inspection and regression evidence will refine the implementation details below.

Cache inspection confirmed the four Cut multilocs at 34633/34635/34637/34639 with their gameval names, map placements and private transform combinations. Production resolves the IDs by gameval name. No generated data was edited.

Initial baseline: 12 tests passed. Five new regression tests failed on the old behavior (whole-tree blocking, missing mask states, shared deadlines, missing offline branch state and old-save migration), then passed after implementation. Final expanded run: TypeScript server build passed; 35 tests across Farming model, redwood, Woodcutting Guild and P2P skilling parity passed.

Independent final reviewer found no actionable bugs and independently reran 19 focused checks. Review traced real click-dispatch order and timer cleanup. Remaining verification limit: map-object lookup and packets are mocked in the new tests; actual client rendering and a live end-to-end click have not been exercised. No live-world deployment is part of this isolated batch.

## Upstream PR validation

The local fix was cherry-picked onto current upstream main `106b6f1411a911c4873e0ac23285a1597ae9ad9d` as branch `pr/farming-redwood-branches`. Its diff contains only the seven Farming implementation/test/documentation files; no unrelated offline-client or boss commits are included.

The upstream-based server passed a forced TypeScript rebuild. The full suite passed 4918/4926 with eight sandbox failures in bot-index persistence, WebSocket localhost connection (`EACCES`) and JSON/IndexedDB temporary-file rename (`EPERM`). The three complete affected files (`bot-brain`, `core-disconnect-guards`, `player-saves`) were rerun outside the sandbox and passed 161/161. The original full run is not represented as entirely green. The focused Farming/Woodcutting/P2P checks also passed 35/35 before upstream packaging; all corresponding tests passed in the final full run.
