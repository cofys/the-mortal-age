# Port reward bag opening implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan. Obtain an independent reviewer before posting the PR.

**Goal:** Open supported port reward bags for one Wiki-sourced shared or destination-specific drop without losing bags or rewards at inventory boundaries.

**Architecture:** Extend the existing SailingPortTasks bag handler. Store loot weights and quantity ranges as plugin data using cache gamevals. Use real inventory capacity/stack rules and consume the exact clicked slot only when the complete reward fits. No delayed action is needed. Save blocked rolls in a registered namespaced player attribute so a capacity failure cannot reroll across bank transfer/logout; clear each entry on successful delivery.

**Tech Stack:** JavaScript plugins, TypeScript game/container APIs, node:test, revision 241 cache.

**Spec:** Curt's 29 October request authorizes opening port reward bags, using Wiki/RSProx/cache and the local PR process. Reward-bag sizes, shared/destination drop rates and quantities follow the current Wiki; cache data determines identities, noted variants and actions. Missing/approximate source values must be disclosed. Bounty/combat work in PR1529, coin-bag economics and unrelated Sailing gaps are excluded.

## Constraints and review focus

- Follow server/AGENTS.md; no manual generated-data edits or feature-specific core changes.
- Work in this worktree/assigned ports only; do not alter the live game or other agents' worktrees.
- Preserve exact clicked-slot and metadata identity; never consume a different same-ID bag.
- Capacity failures preserve the bag; the last bag may free an output slot, but a remaining stack does not.
- Metadata stack equality and the integer stack cap must use the real container's rules.
- Native inventory actions, busy/dead/stale contexts, repeat clicks and save/reload need coverage.
- RSProx search found no port_task_lootsack recordings; do not invent captured messages/timing.

## Task 1: Source and baseline

- [ ] Recheck open/closed/merged PRs and upstream source; record current base and claim.
- [ ] Reconcile five shared Wiki tables, destination tables, and local dump/corresponding active cache definitions. Record unavailable evidence and approximations.
- [ ] Build the clean worktree and run relevant existing tests before implementation.

## Task 2: Open bags safely

Files: modify `server/plugins/skills/sailing/porttasks/Bags.PortTasks.js`; add a focused `Loot.PortTasks.js` unit and plugin-owned `data/port-reward-bags.json` if needed; add `server/tests/port-reward-bags.test.cjs`; update `docs/port-tasks.md`.

- [ ] Write real Player/Inventory native-action regressions and observe failure against the placeholder handler.
- [ ] Add source-backed loot data, cache-name resolution and exact-slot capacity-safe delivery. Reject stale, busy, dead and unsupported contexts without mutation.
- [ ] Verify weighted intervals, inclusive quantity endpoints, noted identities and every supported bag/data row; test full/last slot, stack caps, metadata, duplicate input slots and actual bank/drop/relog transitions.
- [ ] Run build, focused suites and full suite; reproduce unrelated failures on the clean base.
- [ ] Start only own-port services; verify native Open, stack decrement, rendered loot and failure preservation with a real client. Save evidence and shut down owned processes gracefully.
- [ ] Write production path/shared-owner map and obtain independent review of exact build, including a reviewer-chosen real-system adversarial scenario. Fix/retest findings.
- [ ] Commit, push to the authorized fork, open/attach PR using the required body layout, and release the claim with evidence/limits.
