# Captain's log port tasks implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Open the native Captain's log and let players inspect and cancel their held port tasks safely.

**Architecture:** The log is cache interface 935 mounted as a floater overlay. Its existing CS2 draws the task slots and detail window from PortTasks' existing persisted slots; cancellation delegates to PortMaster.cancel. Charting continues to draw from the existing Charting progress varps. No additional task state or invented progress widgets.

**Tech Stack:** JavaScript plugins, TypeScript server APIs, node:test, rev241 cache.

**Spec:** Approved three-item Sailing batch; this branch owns the log only, with no pushes until all three are ready.

## Global constraints

- Use native widgets and item options; preserve existing Charting and excluded bounty/combat work.
- Own worktree feat/port-task-log, QA ports 3109/43709/49809; coordinate before QA.
- No generated-data edits, no live-server changes, no pushes or PR creation.
- Register is attach-only, named handlers, members true inherited from PortTasks.
- PortMaster remains the sole cancellation owner; cargo worker does not edit it.

## Evidence

- Wiki Courier tasks: free cancellation through log or port masters; slot thresholds 1, 7, 28, 56, 84.
- Wiki Settings: Port task cancellation warning; no captured cancellation wording, so disclose chosen text.
- RSProx 235/00944,00948,03448,03455,03461,03467: opening overlay935, menu7 flags10..12, task-click16 flags0..12, hide-popup8709; inventory op6 task tab, op4 charts; selection19135=slot+1; Close closes floater.
- Pinned dump6e5033af6215963581a51b348f452320ff18f0f6: script8707 slots,8901 details/Back,8708 completed counter,8709 hides detail; menu slot12 Port Tasks and10 Sea Charting. Active cache dump-widget935 confirmed identical layout/onloads8658,8708.
- Cache total quantity is the native detail text; no dump script consumes cargo-taken/delivered to render new progress text. Test existing progress counters and persistence instead.

## Review focus

- Pending cancellation must not target a replacement task in a reused slot.
- Back, Close, reopening and replacing the overlay must invalidate pending selections.
- Noncancellable task599 must remain protected through both log and port master.
- Cancellation removes matching hand/boat/crew cargo through the shared owner, retaining other tasks and cargo.
- Saved slots, counters and log tab survive save/relog without retaining pending confirmations.

## Tasks

1. [x] Add real Player/native-dispatch tests for View-tasks/View-charts, flags, slots, selection and overlay lifetime. Run RED.
2. [x] Add Log.PortTasks.js and attach it in PortTasks.plugin.js, preserving native chart rendering and item options. Run GREEN.
3. [x] Add RED cancellation tests: warning yes/no, disabled warning, stale slot, close/back, protected task, matching cargo cleanup. Implement log confirmation and minimal shared owner guards.
4. [x] Verify mapped ledger collection/delivery updates and save/relog through real objects; targeted tests and pinned Yarn build pass. Root owns the pending full integrated batch suite.
5. [x] Coordinate serial QA, inspect rendered log/menu/slots/details/Back/Close/cancel and persistence, document source limits and production path.
6. [x] Prepare the local commit as configured UnhealthyKraken with no attribution and return its SHA/evidence/PR draft to root. Root's independent review passed75 checks; posting remains held for batch integration.

## Execution ledger

- Pinned Yarn4.12.0 build passed. The sandbox registry lookup failed ENOTFOUND; approved normal-network retry succeeded.
- Initial RED: five missing-feature failures; startup/lifecycle and login-username fixture issues corrected before claiming persistence coverage.
- GREEN:11 new real-object log tests,9 existing port-task tests and28 charting tests,48/48. Startup hooks are initialized; unrelated bot simulation disabled through the supported test environment switch.
- Added dead/busy/stale-inventory RED, then guarded physical log reads; it is included in47/47.
- Native QA/full suite wait for root's serialized resource allocation.
- Ruling: add the single native Settings mapping457→18130 through the existing Settings owner. Its cache-rendered row existed but was absent from the38 server mappings. RED10/11 proved the native row did not change18130; GREEN48/48 proves toggle, shared preference persistence, login restoration and direct cancellation. Active cache6716 branch939 reads18130; pinned struct6325 names setting457. Root approved this additive shared change.
- Client production build passed with existing warnings; source unchanged in the client.
- Existing Settings foundation24/24 and final log11/11 passed,72 distinct targeted tests across log/port-tasks/charting/Settings.
- Controlled QA account logqa9: Sailing99 and log item via admin setup; five normal courier tasks accepted through the real notice board, two cancelled through native decoded log packets, then saved/logout. Remaining tasks32/36/33 in slots0/1/3, no progress or completion seeded. Root drives browser page5; own services3109/43709/49809 only.
- Runtime Pandemonium quest overlay exposes60321 instead of the ordinary base ledger. Root's cargo worker owns that correction. The mapped real-object ledger test bypasses the runtime overlay and is described explicitly as a fixture.
- Native QA found stale task cards after cancellation despite correct saved slots. Root cause:8707 listens only to general5202, while held slots use5197..5201. Two RED regressions reproduced missing redraw. A single Common.setSlots custom event now refreshes only a mounted log through native8663/8709;12log+9port-task+28charting+24Settings tests pass73/73. The existing crew test now explicitly asserts the new notification before locating the unchanged cargo-taken event/payload.
- Final pinned Yarn4.12.0 server build passed after the redraw fix. Root approved replacing isolated full suites with one final full integrated suite on latest main plus all three final commits and reward-bags1546; that verification remains pending with root.
- Native list/details/Back/No and the actual Settings checkbox were verified by root. Intro stage50 is a controlled QuestRuntime fixture for native menu/Sea Charting testing (8672 hides it below46), without a production unlock override. Final immediate redraw/restart checks remain pending with root.
- Final native PASS: actual Settings457 unchecked→18130=1; graceful restart saved1/failed0, relog retained1. Native granite task cancellation skipped the warning, immediately cleared its card and preserved the kyatt task. Evidence: root .runtime/skills-sailing-batch/log-native-final-cancel.jpg. Root's prior native checks covered list/details/quantity/Back/Close/No/Yes/menu/Sea Charting.
- Independent reviewer found no findings in inspected paths;75/75 passed on final production fingerprints and a fresh pinned Yarn build, with no hook errors. Reviewer challenged real bank open/close prompt ownership and actual SQLite writer flush/new connection load/login of native Settings457. Report: root .runtime/skills-sailing-batch/review-log/review.md.
- Own QA cleanup: final graceful9shutdown saved1/failed0;3109static PID53044 verified as node serve-build.mjs before stopping. Own3109/43709/49809 listeners are clear; live services untouched.
