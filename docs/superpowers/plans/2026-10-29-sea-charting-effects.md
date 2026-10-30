# Sea Charting Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the effects, quiz reward and current-duck replacement flows explicitly deferred by merged PR1472.

**Architecture:** Charting owns session NPCs, delayed effects and persisted reward/cooldown attributes in focused units. CargoHold adds an additive custom-event query before withdrawing a tool; shared containers, real NPC combat/death, deck areas and scene APIs retain their existing ownership.

**Tech Stack:** CommonJS gameplay plugins, TypeScript server foundation, Node real-object tests, revision241 cache.

**Spec:** `docs/sea-charting.md`, Not done (captured), and the source/design record below.

## Global Constraints

- Own worktree `tsps-feat-port-task-log`, new branch `fix/sea-charting-effects`, base776c7f0a9fa2422e851037594c92eedb1f93bd30; old branch preserved.
- No manually edited generated NPC/dialogue/drop JSON; use existing definitions or report canonical regeneration requirement.
- No feature core logic, global player process polling, live/other worktree writes or shared Chrome profile.
- Full suite, independent review, native rendering and publication coordinated by root; no push/PR/commit before those gates.

## Review Focus

- Logout/relogin and server restart must preserve duck replacement deadline without returning a duplicate inventory duck.
- Full inventory while collecting ducks or claiming quiz reward must retain retryable ownership/reward state.
- Repeated drink confirmations must not consume replacement items or duplicate a reward/effect session.
- Boat teleport, sinking, disembarking and owner logout must not leak NPCs into other decks or players.
- Wrong quiz answer, arena exit and interrupted blackout must restore controls and retain correct saved state.

## Source/design record

Wiki mechanics (retrieved2026-10-29): Current duck despawns120seconds after it stops, returns to tools on release and cannot be withdrawn while active. 235/938 tick1316 stop and1348 refusal60seconds demonstrates minute-rounded countdown, not60second total lifetime. Resetvarp5038 values29408822 are epoch-minute scale, never processCycle persistence.

Wiki Bottle of puzzlers poteen: five questions, answers [The things there are., Yes., Go west., No it isn't., Oh, I'm sorry that is incorrect...]; five mystery boxes once; capacity failure/wrong answer permits retry; wrong answer damages floor10%HP. Capture235/941 ticks714-742 records wrong answer;750-786 records complete quiz and rewardvarbit18569. Full sequence retained in ignored `.runtime/charting/capture-extract.txt`.

Wiki drink pages establish ten deck effects: defending troll, seven successive dwarves awarding beer/kebabs, venomous snakeling, blue dagannoth, corpse with up to9revivals, angry tortugan, Dinky, three whiskycritters until teleport/sink/logout, drink troll queen, Sailing cat. Fishier stout separately enters instanced troll arena with three trolls and one-time100SailingXPdrinks; exitLonghall and boat dockRellekka iff62+FremennikTrials elseSarim, noncouriercargo retained. Capture235/948 drink9247/blackout9249/rebuild9250/wake9253/NPCs9254; rewardbits18566-18568 after consuming drops. Exact individual spawn/sequence timing remains to extract before respective tests; do not guess durations.

Pinned dump6e5033af6215963581a51b348f452320ff18f0f6 config/symbols and active cache supply gamevals and varbits. Existing generated npc-dialogue-index has troll/corpse/queen/cat transcripts; generated drops include15164-15171 and15175. NPC combat-definitions use refs/defaults; inspect runtime resolution before claiming combat verification.

## Production path map

- Inventory native item packet → PluginManager.onItemAction → DrinkCrate.drink/choose/swallow → real Inventory consumption, Common.complete, new Effects/Poteen units → owned deck/scene NPCs, TaskManager, persisted reward attributes and PacketSender varbits/dialogue.
- Native cargo tools943:18 slot2 → CargoHold.takeTool → `sailing:can-take-tool` query → CurrentDuck guard → persisted deadline; withdrawal through real Inventory only after capacity and cooldown pass.
- Current-duck native Track-current → CurrentDuck.release → real owned NPC/MovementQueue → stop establishes120s expiry → Collect/climbAboard capacity check → finish clears ownedNPC/deadline/hint; logout removesNPC but retains deadline/tools; login sendsvarp.
- Native quiz menu → real MultiChatboxPrompt callback → next question/wrong damage/reward → real Inventory.getAddableAmount/add and saved once bit.
- Fishier encounter native Drink → scoped Task/instance → real NPC combat/death/ownedgrounddrop → native Drink rewarditem → persisted perdrinkbit/100XP; native escape → sailing leave/dock and Longhall.

## Tasks

### Task1: Current duck replacement lifecycle
Files: modify charting/CurrentDuck.Charting.js and CargoHold.plugin.js; create tests/sea-charting-effects.test.cjs.
- [ ] Write realPlayer/allstartup native cargo refusal, stopped120sexpiry, fullinventoryCollect, logout/save/relog tests.
- [ ] Build and run focused test; retain expected missingtimer failures.
- [ ] Implement persisted timestamp, toolsreplenishment, scopedexpiry and queryguard; preserve exactcapturedwaitline.
- [ ] Rebuild/run GREEN plus existing sea-charting/cargo tests; record controls/fixtures.

### Task2: Poteen quiz and reward
Files: create charting/Poteen.Charting.js; modify DrinkCrate.Charting.js; same real-object test.
- [ ] Add native dialogue menu tests for all5answers, wrongdamage, repeatedreward, capacityandclose/retry; observe RED.
- [ ] Implement captured dialogue with generatedsource whereavailable, persisted18569reward and atomic5boxcapacity.
- [ ] Rebuild/run GREEN, inspect real dialogue/client packets and persistence.

### Task3: Ten deck effects and fishier encounter
Files: create focused charting/DrinkEffects.Charting.js and charting/FishierStout.Charting.js; plugin data only if capture-derived; same test.
- [ ] Finish individual captured timings and canonicalNPC/combatsource audit; report missingcanonicaldata before changing generatedfiles.
- [ ] Write RED tests for NPC ownership/deckmembership, aggressiveactualcombat, dwarf7rewards, corpse9revivals, teleports/logoutcleanup, fishierblackout/arena/deathdrops/rewardbits/exit/save.
- [ ] Implement minimal scopedunits, existingNPCdefinitions and realsharedcombat/death/scenehooks.
- [ ] Build/run GREEN and targetedfoundationchecks; retain exactfingerprints and note unverifiedbehaviour.

### Task4: Review/native handoff
- [ ] Update sea-charting source/limitations documentation and ignored `.runtime/charting/pr.md` with required PRbodysections and pathmap.
- [ ] Send root source/test/build/fingerprint evidence for independent review and nativeChromeUI.
- [ ] Address independently reproduced findings with RED/GREEN; rootserializesfullsuite/publication.
- [ ] StopownQAgracefully(gameUpdate5ssave), verifyports3109/43709/49809free; localcommitonlyafterrootreview/nativegate.

### Authorized combat follow-up (root2026-10-30)

Ownership: new `charting/TrollCombat.Charting.js`, attach from DrinkCrate; own real-object test.
Wiki The rocks supplies melee23 and choosing melee against Protect from Magic; magic max remains unknown. Capture235/948 shows its barrage-impact graphic369 delay10 and interrupt, but no movement-freeze expiry. Dad has captured20/40cycle exactmove but unknown special selection odds. Dinky51+ has no sourced dynamic damage formula. Do not invent any of these unknown values.
- [ ] RED: real arena Rocks chooses magic with no overhead, melee against real Protect from Magic, its melee roll can reach23 through shared prayer mitigation, magic impact interrupts and draws recorded graphic.
- [ ] Implement per-NPC CombatMethod and typed unmitigated melee-roll hook; preserve canonical records. Delegate ordinary range/delay/accuracy/protection to shared CombatFactory.
- [ ] GREEN and independent re-review; restart QAserver to reload plugin JS before finalnativecombat assertions. Leave uncertain freeze duration, random adjacent-melee/teleport policy, Dad selection/stun and corpse probability explicit.

## Execution record (2026-10-30)

Duck deadline/tools/logout/save and poteen native quiz/reward boundaries are implemented with retained RED/GREEN evidence in .runtime/charting. Captured visitor lifecycle and fishier arena/reward flow are implemented. Corpse regeneration remains explicitly unfinished: Wiki states a chance and max nine, but no source supplies the chance; no fixed-count or invented probability substitutes for it. Dinky's damage still falls back to1 pending a sourced exact formula. Rocks has a scoped source-backed style/melee23/impact hook and independent review; its animation follow-up is under RED/GREEN. Author focused checks90/90 and pinned build pass before that last animation correction. Full suite/publication/native gate belong to root. Own QA slot9 is running pending root's restart and shutdown signals.

Final animation RED retained actual successful attack followed by -1 versus284. Explicit shared attack animation fixes both styles without unverified sound/projectile. Final focused91/91 and pinned Yarn build pass; reviewer unchanged7cases+author30 pending. Evidence hashes .runtime/charting/fingerprint.json. Native QA/restart/shutdown remain root-coordinated.

## Final QA handoff and cleanup (2026-10-30)

Reviewed production/tests/source documentation committed and SSH-signed as07efc99173a9bed0f942e4d4e488b8b24bebf8d8; signature verified using isolated allowed-signers file. Final focused91/91, independent37/37 and pinned build pass. Root native poteen/arena/reward/exit and full117-step duck route/natural stop/early refusal/expiry-before-query/Take-once/repeat-click checks are recorded in sea-charting verification. Later mystery-box opening and ground pickup remain unattributed and excluded from native input claims. Corpse revival, Dinky damage formula and remaining Rocks special mechanics are explicitly unfinished. Root combined10214/10185pass/29fail vs clean-base10137/10108pass/29fail comparison is pending matching assertions; equal counts alone are insufficient.

QA shutdown authorized after page10closed: gameUpdate5s saved1onlineplayer/failed0 and completed persistence. Verified ownstatic53464 launch ancestry before stopping only that process. Final qa-stopped.json verifies3109/43709/49809 have0listeners and game49776/static53464 absent. No production source changed after07efc991; this follow-up is documentation only. Publication remains root-coordinated; no push performed.
