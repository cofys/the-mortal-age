# Port coin bag safety implementation plan

**Approved scope:** Curt authorized coin-bag safety, courier cargo restrictions and the Captain's log as three separate PRs, pushed only after all three are ready. This branch owns coin bags only. Keep existing PR1546 reward bags and PR1529 combat/bounties separate.

**Base:** origin/main `acf4a8659`. Own checkout: `tsps-feat-port-reward-bags`, switched from its completed PR1546 branch to `fix/port-coin-bag-capacity`; live game untouched.

**Design:** Validate the native inventory source and exact clicked Item/slot, reject busy/dead/stale states, and plan one bag-to-coins exchange with the real Inventory capacity/metadata/stack-cap APIs. Consume only if the complete payout fits. Preserve a failed roll through real banking and save/reload in a registered `port-tasks:pending-coin-bags` attribute; the next successful bag then rolls fresh. Keep unchanged slot identity and metadata. The current Wiki also corrects the pre-existing Small/Medium/Large quantity endpoints to 1600–2400,2400–3600,3600–5400; Tiny800–1200 and Huge6400–9600 remain.

**Sources:** Wiki `Port_coin_bag` raw fetched29October; local RSProx indexed searches for coin-bag gamevals; pinned rev241 dump.obj `port_task_lootsack_t0_coins` through t4; verify shipped cache actions, sizes and coin identity. Do not infer payout formulas from display params, or claim captured message/timing if absent.

**Files:** existing `server/plugins/skills/sailing/porttasks/Bags.PortTasks.js`; new focused real-object `server/tests/port-coin-bags.test.cjs`; `docs/port-tasks.md` evidence and path map. No core, generated data, new interfaces, task delays or storage/PIN service.

## Execution

- [ ] Build base and run existing port-task/Sailing tests.
- [ ] Write native-action regressions for full inventory, last bag slot, existing coin stacks/cap, exact metadata input slot, invalid/stale/busy/dead events and inclusive Wiki endpoints. Observe RED.
- [ ] Implement exact-slot atomic eligibility and validated persisted pending roll; verify GREEN.
- [ ] Exercise actual Bank deposit/withdraw and SQLite save/reload, no selective rerolls or partial payouts, successful next bag and retained unrelated metadata. Run appropriate shared-foundation tests.
- [ ] Run full suite and reproduce unrelated failures on the exact clean base.
- [ ] Native own-port client: Open/menu/default action, rendered payout and bag decrement, full/cap failure and retry, logout/relog. Retain evidence and stop QA gracefully.
- [ ] Independent fresh reviewer builds exact fingerprinted source, traces native/shared owners and runs an additional adversarial transition; address findings.
- [ ] Commit and hold locally. Root pushes all three branches together and opens/attaches the three PRs only after the batch is ready; update board and release claims.

**Coordination:** Cargo worker owns new Cargo.PortTasks plus minimal carrying hooks. Log worker owns native935 log/progress/cancel module, reusing existing PortMaster.cancel. Separate worktrees; shared additions must remain compatible when combined. No worker pushes or opens PRs.
