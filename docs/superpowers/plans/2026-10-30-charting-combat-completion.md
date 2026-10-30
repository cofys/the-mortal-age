# Charting combat and revival completion plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task by task; source research may run independently before implementation.

**Goal:** Finish the documented combat/revival gaps in PR1559 and mark it ready only after source-backed behavior, independent review and native verification.

**Architecture:** Retain the existing charting encounter/session owners. Combat methods and scoped death interception own special attacks and revival; shared PendingHit, damage, prayer, movement and NPC death/drop services remain authoritative. Canonical NPC data changes require source/parser fixes and regeneration, never hand-edited exports.

**Tech Stack:** Existing JavaScript plugins, TypeScript core APIs, node:test, RSProx transcripts/index, pinned rev241 dump and active cache.

**Spec:** Curt's 2026-10-30 request to finish remaining combat and revival in #1559 using Wiki, RSProx and cache, follow the PR process and stop QA services. Existing PR/head1dbacdf5, own branch fix/sea-charting-effects, slot9; no new PR or live install.

## Global constraints

**Latest user ruling (2026-10-30):** "Right, lets just do it as close as possible" supersedes the earlier no-estimates gate. Complete behavior using verified values where available and explicit, bounded approximations for the unresolved server rules. Retain all evidence/history below as provenance; it does not supersede this new authorization. Do not claim1:1.

- Read/claim coordination before edits; keep unrelated owners and generated data intact.
- Wiki establishes mechanics, captures establish recorded responses/timing, cache establishes IDs/client expectations. Do not turn a visual effect or a small random sample into an exact server probability.
- Establish each previously unknown value before implementing it; retain explicit evidence gaps rather than silently choosing a value to make the PR ready.
- Follow real entity/container/task/death semantics; corpse revival cannot duplicate loot, lose ownership, leak NPCs or bypass cleanup.
- Keep draft until required functionality and checks are actually complete. Push forward signed commits; no force-push.
- Gracefully save/stop own slot9 server/client, close own tabs and verify3109/43709/49809 clear before final handoff.

## Review focus

- Fatal queued hits and multiple death observers cannot produce duplicate corpses, revivals or rewards.
- Revived NPC retains owner/deck/encounter identity and correct reset HP/combat; cleanup/logout cannot leave delayed resurrection behind.
- Per-attack prayer/distance/style decisions and freeze/knockback timing pass through the actual shared pipeline.
- Forced movement respects arena/deck bounds, target death/logout/teleport, pending actions and subsequent normal movement.
- Exact damage/max-hit values come from verified source data; regeneration/import is deterministic and does not replace unrelated canonical edits.

## Work sequence

- [x] Recheck current PR/reviews/open-and-closed overlap, branch/main and claims; collect fresh sources and audit available hooks before code.
- [ ] Resolve source questions: corpse revival probability/cap/HP/stages; Dinky damage; Rocks max/style/freeze/teleport/cast timing; Dad special chance/knockback/stun. Search newer remote captures if local coverage is insufficient. Record each exact value, source, conflict and limit.
- [ ] Append concrete implementation boundaries and literal expected cases after research, before editing production. Reuse shared owners and canonical sources as appropriate.
- [ ] Write real-object/native regression tests first, retain meaningful RED, implement the supported behavior, then GREEN. Cover normal and interruption/capacity/ownership/lifecycle boundaries.
- [ ] Independent reviewer traces unchanged shared systems and executes an adversarial real transition. Fix findings with retained regressions.
- [ ] Fresh pinned build, focused and full suites with clean-main reproduction for unrelated failures. Native client verifies relevant combat, revival, effects and cleanup using disclosed fixtures.
- [ ] Update docs/PR around final mechanics and evidence; signed forward push, verify head/mergeability/checks, mark ready only when the remaining work is fulfilled, release claim and verify QA shutdown.

## Evidence ledger

- Initial fresh PR read: draft/open/mergeable, no comments. All-state searches for corpse revival, Dinky and charting combat found no competing implementation beyond1559 and earlier Sailing work.
- Local branch matches published1dbacdf5; current main495ddabd3. Prior gaps are explicitly documented in docs/sea-charting.md and the PR.
- Read-only source tasks split corpse, troll mechanics and cache/shared API research; no implementation values chosen yet.

## Source gate result (2026-10-30)

Curt explicitly requires 1:1 OSRS behavior; configurable estimates are not authorized. Research is complete for the available sources, but the implementation gate has not passed. No production changes, tests, publication or readiness transition were performed in this research pass. The existing PR remains draft at1dbacdf5.

Verified observations include full90HP corpse revival on the same NPC without a death animation, four-tick corpse/Dinky attacks, Dad's captured five-tile knockback and animation pair1158/1157, and Rocks' impact369. These do not establish the missing server rules: corpse revival probability/count-selection/time policy, Dinky's exact maximum (Wiki51+), Rocks' magic maximum, or exact special odds/stun/freeze/cast timing. Neither animation lengths nor small random samples establish those values. Cache param10 implies an ordinary formula inconsistent with Dinky's documented lower bound, so that formula cannot supply its missing special damage behavior.

Evidence retained outside tracked production sources in the workspace root:

- `.runtime/pr1559-revival/research-findings.md` (Wiki/history/talk and exact packet contexts; only one completed corpse fight, overlapping partial captures excluded).
- `.runtime/pr1559-trolls/research-findings.txt` (all available local encounters and Wiki histories).
- `.runtime/pr1559-cache/findings.md` (pinned241/cache/shared pipeline audit and parameter comparisons).
- `.runtime/pr1559-root/catalog-check.json` (newest100 public RSProx submissions already present locally). Private `.rsprox` has logs only.

Next prerequisite is authoritative mechanics evidence or additional controlled official-game observations that resolve these gaps. Then append literal implementation expectations and resume the remaining steps above. No tests were rerun for this documentation/research-only pass. No QA services were started, and host listener verification confirms3109/43709/49809 clear. Coordination claim released with the evidence handoff.

## Expanded external research (2026-10-30)

Curt requested other sources and newer RSProx recordings. Independent research covered catalogue completeness, external corpse observations and external troll observations; no production edits were authorized by an unsupported estimate.

- All43 public RSProx catalogue pages contain4283 unique recording IDs, exactly equal to the local archive. The supported form distinguishes recording-date order from revision order; checking both and comparing the entire ID set avoids missing a newly uploaded older recording. Highest revision239, newest recorded2026-07-14. This establishes public catalogue coverage only, not private/unpublished captures. Evidence: workspace-root `.runtime/pr1559-expanded-rsprox/audit.json` and `findings.txt`.
- The site's own NPC search API independently confirms corpse948/3711/3712, Daddy/Rocks948only, Dinky11recordings. Later Dinky985 and3836 are bystander captures with no target player's received-hit records.985 independently shows four-tick attacks and a complete140HP kill, but neither supplies outgoing damage or scaling. Anonymised bounded contexts are retained in that research directory.
- RuneLite's published `runelite/static.runelite.net` NPC data at212ecca52def42238b2f0799ef769eea03d4cff1 confirms90/120/130/140HP for15165/15167/15168/15171 respectively; these entries provide no damage maximum or revival rule. Public GitHub searches returned identifiers, Wiki-derived data and other private-server data, no primary OSRS server rule. Other private-server implementations are not parity evidence.
- External corpse sweep checked firsthand Reddit crate discussions, Waters'2025-11-21 bottle-video metadata/full subtitles/comments, H8's public bottle-video listing, official/ModAsh indexed searches and other public archives. No second complete corpse fight or exact revival/credit rule was found. Detailed exclusions and URLs: workspace-root `.runtime/pr1559-expanded-corpse/external-source-sweep.md`.
- External troll sweep found and visually inspected dated Dinky videos `xO5vOd4Valg` (2025-11-29) and `sxVnPGqCvog` (2025-11-22), plus firsthand Reddit reports. None establishes the ceiling or missing special rules. The apparent independent51+ Reddit image is a Wiki screenshot, not a measured hit. Waters'2025-11-21 arena-video captions provide a further footage lead but no numeric mechanics; media retrieval returned403, so no visual claim was made. Detailed provenance and access limits: workspace-root `.runtime/pr1559-expanded-trolls/external-primary-research.txt`.
- Twitter's authenticated CLI was unavailable because cookies could not be extracted; indexed public searches were used. Reddit's authenticated backend was unavailable, but indexed posts/comments remained readable. Searches did not inspect private Discord discussions and cannot establish that no unindexed evidence exists.
- PR1559 remains open/draft/mergeable at1dbacdf5, maintainerCanModify=true, no comments/reviews. Fresh all-state charting searches found existing1472/1492/1553 and1559, no competing new completion.

### Next evidence collection must answer specific questions

1. Corpse: record from bottle use through final removal, with exact ticks and every lethal hit/revival. Compare rapid kills, deliberately delayed first kill and slower subsequent kills to distinguish duration from life-count policies; record quest/slayer/kill counters and ground items across intermediate/final deaths. A few ordinary encounters cannot identify an exact hidden probability; developer clarification is needed if statistical observations leave multiple formulas possible.
2. Dinky: obtain target-player packet captures (bystander footage omits received-hit data), with player stats/HP/equipment/prayer/damage modifiers and NPC stat measurements where supported. Vary suspected scaling inputs under controlled conditions. An observed maximum is a lower bound until a formula/cap is established.
3. Rocks: isolate its magic attacks from the other trolls, record cast/impact ticks and every movement/attack input around release, test protected/unprotected attacks and adjacent/diagonal/distant positions. Establish magic cap and selection/teleport rules rather than transferring another NPC's spell behavior.
4. Daddy: record ordinary/special selection and native inputs throughout knockback, including clipping/boundaries, then determine the variant's stun/recovery and selection rule. Normal Dad's1/3 rate cannot be silently assigned to this variant.

These are recording/research requirements, not proposed gameplay constants. No guesses have been introduced and the readiness gate remains unmet.

Expanded research handoff: zero missing exact mechanic fields resolved. No production changes, tests, push or PR mutation. No QA services or browser tabs were started; assigned listener ports3109/43709/49809 verified clear. Claim released with report paths and explicit blockers.

## Authorized approximation implementation plan

Ruling: use small local named constants with source comments, not shared generated-data edits. These estimates are implementation decisions, not verified OSRS values. Code and PR must distinguish them from captured observations.

- Corpse: choose a uniform integer0..9 revival budget per spawned encounter (estimated distribution; Wiki cap9). On a lethal hit, prevent actual death while budget remains, restore full90HP immediately on the same NPC, preserve combat cadence/owner/deck and announce captured regeneration text/overhead. Guard existing preventDeath and cleanup. No intermediate NPCDeathTask, death rewards or kill credit; final death uses normal pipeline (credit policy is an estimate). Multiple queued lethal hits must not duplicate NPCs/rewards; cap is per encounter. Logout/leave/boat teleport/replacement remove encounter state.
- Dinky: per-instance maxHit51 while spawned by this drink. This uses Wiki51+ lower bound as a provisional ceiling, explicitly estimated, and retains ordinary accuracy/prayer. No shared definitions modified.
- Rocks: melee max23 verified; magic max23 estimated. ProtectMagic selects melee; otherwise choose melee one-in-three when cardinally adjacent (estimate), magic otherwise. At distance greater than1, attempt teleport beside target one-in-four per attack (estimate); only valid same-area, unblocked, unoccupied arena tiles. No diagonal-adjacent teleport. Captured animation284/impact369delay10, estimated magic hit delay1tick and freeze3ticks on accurate magic (including protected zero), interrupt attack/pending action through shared combat APIs. Scope all effects to owned encounter NPCs.
- Daddy: use ordinary melee accuracy/max27 and speed8. Select special one-in-three (borrowed normalDad rule, estimated for variant). Captured1158 attacker/1157 flybacktarget delay20, forcedmove start20/end40cycles, desired Chebyshev displacement5. Estimate3tick stun; validate movement against collision/area, clip to last reachable tile and skip invalid destinations. No unregistered/dead/foreign target or out-of-area delayed effects.
- Use real Player/NPC/HitQueue/TaskManager/MovementQueue/area tests; deterministic RNG only in tests. First watch meaningful failures before production implementation. Cover cap/early finaldeath, queued lethals, death observers/credit, owner isolation, cleanup, prayer changes, style selection, movement cancellation and boundary clipping.
- Independent implementation responsibilities: worker owns DrinkEffects + new revival/damage unit and separate corpse/Dinky test file. Root owns TrollCombat + separate troll test file and docs/integration. Reviewer owns no production edits. Shared code changes only if actual API deficiency demonstrated.
- Forward merge currentmainb57a25f88 before implementation; build/focused/full checks and matching clean-main failure assertions. Independent reviewer must execute real adversarial transitions and read unchanged owners. Native rendering/input verifies corpse revival and all troll specials, disclosed QA fixtures and failures. Save/stop slot9, close tabs, verify ports. Signed forward push existingfork branch; rewrite PR body around final behavior/evidence/estimates; mark ready after completed validation, never merge/deploy.

Execution ledger (2026-10-30): implementation and fresh pinned-Yarn build complete; serial charting61/61 pass, including reviewer-designed actual World placement/cancellation. Earlier broader focused run passed the28 shared/foundation cases; its one Rocks failure was a10HP fixture legitimately killed by the real damage-roll hook. That fixture now99HP with an explicit survival assertion, retaining the actual hit pipeline. Independent review found and fixed four-way facing and loss of NPC engagement after own knockback placement. Full-suite, final rendered repeat-knockback check and publication remain pending.

Crash recovery: Curt reported a PC crash. Saved source/evidence survived; an extra local patch/archive checkpoint was written. Previous concurrent runs logged native Node allocation failures, so recovery tests run serially, with own QA services stopped. Host-level checks confirm slot9 ports free; other applications' processes are preserved. Windows memory readings after reboot were healthy; this does not prove the cause of the PC crash.

Latest testing ruling: Curt's2026-10-30 necessary-testing instructions supersede blanket full-suite gates above. Stopped the remaining full run after9,246 completed cases, with nine observed failures matching the pinned clean-base names/assertions; no completed-full-run claim. The61 charting cases,28 identified HitQueue/thrall/Vardorvis consumer cases, independent11-case review and native rendering/input cover the actual changed paths. Only exact-name clean-base reproductions of the nine observed unrelated failures remain for classification, followed by signed publication/readiness; no repeat passing tests or automatic broad run.

Final ledger: the nine unrelated failures are now reproduced with matching assertions through focused clean-base runs (burying includes its existing cache-initialisation prerequisite). No production changes followed the passing focus/review/native checks. All own QA services/tabs are stopped. Testing is complete under the latest instruction; signed forward publication and readiness remain.
