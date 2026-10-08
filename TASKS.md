# Task Board — The Mortal Age

Claim a task by changing it to `IN PROGRESS — <name>`, committing, and pushing
before you start. See `COLLAB.md` for the full protocol.

## NOW

- [ ] Citizen AI mission (ongoing) — personalities, social mechanics, relationships,
  guilds, shops. Break off concrete subtasks below as they arise.
  Paths: `server/plugins/citizens/`
- [x] DONE — heartbeat-1325 — Citizen movement diagnosis + fix (Jon playtest: citizens materialize but never move). Temp debug logging removed, BYPASS LOD reverted after inconclusive test. PC deployed clean 14:16. OPEN ITEM: Jon's live playtest only — no more speculative fixes.
  Paths: `server/plugins/citizens/lib/CitizenAlive.js`, `server/plugins/citizens/`

## NEXT

- [ ] _Empty — add tasks here as they come up. Format:_
- [ ] _Example: "Quest: <name> — <one-line scope>" — Paths: `<dirs>`_

## LATER

- [ ] _Empty — bigger ideas waiting their turn._

## DONE

- [x] 2026-10-08 — citizens: bards rung audit (coordinator-1415) — CLEAN 5/5: LOD-gated (cooldown→bard→materialized→real player within 14 tiles→evening hours→chance; forceChat only near players; daily rhythms day-gated data-tier), tick-safe (outer + per-citizen try/catch), scripted-only (zero LLM; ballad-of-the-week from journaled event words), no overlap (street-performer exclusion via CitizenStreetPerformers.performerTypeOf and inn-bard exclusion via CitizenInnkeepers.innTypeFor — both verified exported), real APIs (getJournal/seedRumor; commission/request ledgers journaled). 22/22 tests pass. No code changes.
- [x] 2026-10-08 — PC deploy 14:25 EDT (coordinator-1415): kill → pull 1117e99e→74206338 → node --check CitizenOffices.js/.test.js clean → start-tma.bat → port 43594 LISTENING, clean boot in C:\\tma\\server\\logs\\server.log, watchdog re-enabled (Ready). RAM free 0.99GB — 12 node procs are ONE server (ts-node 975MB) + ONE craco client dev server (591MB) + yarn wrappers, NOT duplicates (answers 1400 selfreview open item).
- [x] 2026-10-08 — citizens: offices rung — honor judge claims in candidacy, deterministic weighting tests (13/13 pass), pushed to origin/main c0e6abdd
- [x] 2026-10-08 — citizens: revert LOD diagnostic bypass + remove temp debug logging (CitizenAlive.js:637 LOD gate restored); BYPASS never went live on PC beyond disk state at 13:46 — removed via deploy; debug instrumentation never fired (0 players logged in after 12:51 deploy), so the BYPASS test was INCONCLUSIVE — movement bug NOT root-caused, needs live-player test with Jon
- [x] 2026-10-08 — PC deploy 14:16 EDT: kill (12 stale node procs) → pull 1117e99e → node --check → start-tma.bat → port 43594 LISTENING, clean boot in C:\tma\server\logs\server.log, watchdog Ready, RAM free 3.4GB (was 842MB)
- [x] 2026-10-08 — citizens: fix animation.getId crash from playtest
- [x] 2026-10-08 — citizens: fix LOD bands using director positions

## Handoffs

_2026-10-08 ~14:45 EDT (coordinator-1415) → next:_
- origin/main = <new-sha-after-push> (this run: 14:25 PC deploy + bards rung audit recorded in TASKS.md). PC is on 74206338 — offices rung c0e6abdd + TASKS.md now LIVE on the PC.
- Movement bug: STILL awaiting Jon's live playtest. BYPASS gone from disk, LOD gate sound on review, spawn intact. Do NOT write speculative fixes (alignment law: claim nothing until his screen agrees).
- Duplicate-node-process anomaly resolved: 12 node procs = one ts-node server + one craco client dev server + yarn wrappers (verified via command lines). Normal start:stable footprint. RAM free 0.99GB on boot — the 8GB ceiling remains the gating constraint; browsers are the reclaimable bulk per Jon.
- Next rung audit candidate: pick another profession guild (bards audited clean 5/5 this run, no changes; offices rung + deployed). Festivalgames / guards / healers / farmers untouched by today's audits so far.

_2026-10-08 14:30 EDT (coordinator-1400) → next:_
- Origin/main = c0e6abdd (offices rung). PC is on 1117e99e — offices rung is pushed but NOT deployed; deploy it in the next unblocked window (kill→pull→verify→start + watchdog re-enable).
- Movement bug: spawn works when players near (12:48 diag: 16 citizens online w/ players); 0-online with 0 players is by design. LOD gate is sound on code review. Do NOT write more speculative fixes — needs Jon's live playtest.
- Movement-diagnosis task entry below (heartbeat-1325) is closed as done: diagnosis phase ended with an open-item for Jon, debug + bypass removed, PC deployed clean.
- [x] DONE — heartbeat-1325 — movement diagnosis phase: root cause NOT found in code review (pipeline spawn→attachBrain→tickProximity→tickAlive→movement intact, LOD gate sound); debug instrumentation never fired (no players post-12:51 deploy), BYPASS test inconclusive. All temp debug + BYPASS removed, PC deployed clean 14:16 EDT. OPEN ITEM for Jon's next playtest: live-player movement verification.
