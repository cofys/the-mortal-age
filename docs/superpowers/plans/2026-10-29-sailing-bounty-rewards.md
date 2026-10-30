# Sailing bounty rewards — approved implementation plan (2026-10-29)

Baseline: 776c7f0a9fa2422e851037594c92eedb1f93bd30, branch fix/sailing-bounty-rewards. Previous cargo branch retained. Tracked checkout clean before switch; old ignored runtime/untracked cargo plan preserved.

## Sources and decisions
- Wiki Bounty_tasks (raw retrieved 29 Oct): boosted uniques only until required received-count first met; dropping/destroying/loss cannot extend. Cancelled parts retained and count on reassignment; second same-creature task waits for first parts. 17 June changes scope damage scaling to narwhal, orca, great white shark, armoured, veiled, vampyre krakens.
- Each of those six creature pages: bounty parts and pre-roll chances scale proportionally to damage. Use applied damage / creature maximum HP, clamped [0,1], snapshotted before death clears the real Combat record. This denominator is the natural interpretation of proportional creature damage; Wiki publishes no separate healing formula. No quantity scaling, main/common/clue scaling, or scaling of other creatures.
- Wiki Narwhal: nails 3–7 -> 5–10 at unchanged 1/75; Orca nails4–8 ->7–11 unchanged1/75. Orca echo pearl1/70 ->1/35; great white hook1/500 ->1/250; armoured storm1/500 ->1/250; veiled barrel1/500 ->1/250; vampyre storm1/350 ->1/175. Dragon sheet/keel/large-keel pre-roll rates double for those five, never narwhal horn/nails or Inky paint.
- Existing generated drop rows retain those base rates and conditional nail quantity alternatives. Never edit generated data. Existing npc-drops:chance and npc-drops:context supply per-harvest conditions without reimplementing shared loot.
- Captures: rsprox index finds235/00948 sailing_vampyre_kraken, but pre-dates June2026 rebalance and has0 direct actions. Exact reward formula/boost therefore Wiki, not claimed recording evidence. Existing tern capture messages/jingle unchanged.
- Local osrs-dumps HEAD6e5033af6215963581a51b348f452320ff18f0f6 searched first: vampyre alive15212/dead15213, echo pearl31946, storm31949, parts32818/32837, counter14662. Active target osrs-241_2026-10-20; existing bounty cache table197 provides part requirements and IDs, active-cache assertions in tests.

## Path and owners
Native cannon Attack/crew cannon -> Cannon.SeaCombat.fire -> PendingHit/CombatFactory capped applied damage -> Combat.addDamage (captain for crew) -> onNpcBeforeDeath snapshot -> NPCDeathTask clears map -> Loot.SeaCombat.onDeath corpse. Native Harvest -> npc routing/interaction -> Loot.harvest -> delayed Loot.loot -> npc-drops:roll-table -> NpcDrops killContext/chance rules -> Sailing bounty condition/rate handlers -> sea-combat:harvest part -> shared npc-drops:add/roll/generated (Ironman, members, collection log) -> committed received count -> inventory or shared ground placement.
Persisted owner: existing port-tasks slots attribute collected field remains monotonic received count, capped at task requirement. Actual inventory/cargo possession independently controls replacement parts and hand-in. Acceptance credits retained physical parts without allocating same stack twice. Commit is tied to exact accepted slot object and is idempotent, rejecting cancellation/reassignment during shared hooks. Loss never lowers received count or reactivates boost. Corpse snapshots use WeakMap; corpse map lives until all reward hooks complete, then is removed.

## File scope
- plugins/skills/sailing/seacombat/Loot.SeaCombat.js: before-death read-only snapshot, corpse reward-context custom query, contribution in harvest, corpse lifetime.
- plugins/skills/sailing/porttasks/Bounty.PortTasks.js: exact-name chance/context handlers, part scaling, replacement/earned accounting and guarded commit.
- tests/sailing-bounty-rewards.test.cjs: real Player/NPC/inventory/cache + production hooks; only network sinks/RNG controlled; startup, death/harvest, saved attribute roundtrip, lost parts, sequential bounties, cancellation/reassignment, shared Ironman, partial contributions/crew ownership boundaries.
- docs/port-tasks.md / this plan: source and remaining limitations; additive only.
No core/shared NpcDrops edits currently necessary; notify root before any scope expansion.

## RED/GREEN and verification
1. Build pinned Yarn, add real-object test for below-threshold boosted rate/quantity and watch fail; implement hook wiring and rerun.
2. Failing part contribution and real before-death snapshot tests; implement scaling for six only and rerun ordinary drops controls.
3. Failing destroy/replacement, cancellation stale commit and relog tests; implement lifecycle/earned guards and rerun.
4. Targeted sea-combat, port-tasks, shared drop foundation tests + build. Root serializes full suite and arranges independent review/native rendering against exact source fingerprints before commit/publication.
5. PR draft at .runtime/bounty/pr.md. No server startup without verifying own3110/43710/49810 free. No QA processes left running.

## Verification addendum (2026-10-30)
- Five initial expected RED failures became GREEN; real simultaneous PendingHit overkill then failed 1 vs0.6 before HitDamage.onApplied accounting, and shared zero-quantity suppression failed before the positive-amount receipt guard.
- Specific creature-page wording overrides a generic first/second interpretation: Armoured_kraken raw line67 and Vampyre_kraken line67 specify tentacles before ink sacs regardless of acceptance order, without a port hand-in. Two reverse-acceptance RED cases became GREEN through a narrow policy for these two species; a tern control preserves accepted order elsewhere.
- Actual HP ledger uses nested WeakMaps (NPC -> player -> applied damage), reset using the shared Combat owner's prior-credit validity at resolved-hit time. Before-death retains the ledger reference so the fatal observer can finish; corpse death reads it before releasing the ledger.
- Final targeted:87/87 pass (24 new bounty tests + existing sea-combat/port-tasks/Ironman); pinned Yarn build exit0. Independent reviewer:3 real expiry/reset/fatal controls,64 initial focused tests, then24 priority-followup tests pass, no findings in inspected paths. Root retains full combined suite and native rendering ownership.
- Own MCP QA: native Piscarilius board acceptance task535/counter14662=5; transient command-seeded armoured creature (not persistent spawn_npc), native gangplank/Operate/Attack -> full kill -> native Harvest yielded ordinary Earth battlestaff, then actual logout/relog retained accepted task535/counter5 and loot. The bounty part did not roll on that natural1/10 trial; no rare-rate claim is based on that one kill.
- Raw Wiki evidence and action transcripts are local ignored .runtime/bounty/. Final rendering fixtures, saved evidence and graceful shutdown are coordinated by root. A gameUpdate5 restart persisted1 account with0 failures before the final-priority server.

## Final native rendering and cleanup (2026-10-30)
- Root used a real rendering client, saw the naturally harvested Earth battlestaff and the explicitly seeded/reaccepted five-part stack, then operated the real Port master's Claim-rewards. Task535 cleared, the five ink sacs were removed and40,370coins were awarded. The rendered payment dialogue was continued usingSpace. Root closed browser page9 afterwards.
- Native input/state evidence and screenshot are retained at root .runtime/bounty-native-claim2.json, bounty-native-claim-state.json and bounty-native-claim.jpg. The initial failed Portmaster lookup is preserved separately; the successful interaction used the exact NPC name Port master.
- Final own server was shut down via gameUpdate5: one account saved, zero failures, player persistence completed. Own productionstatic process was stopped after verifying PID37068. Host TCP inspection confirmed no listeners on3110/43710/49810; no other services were stopped. Root owns the combined full-suite run and atomic publication.
