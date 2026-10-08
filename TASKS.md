# Task Board — The Mortal Age

Claim a task by changing it to `IN PROGRESS — <name>`, committing, and pushing
before you start. See `COLLAB.md` for the full protocol.

## NOW

- [ ] Citizen AI mission (ongoing) — personalities, social mechanics, relationships,
  guilds, shops. Break off concrete subtasks below as they arise.
  Paths: `server/plugins/citizens/`
- [ ] IN PROGRESS — heartbeat-1325 — Citizen movement diagnosis + fix (Jon playtest: citizens materialize but never move). Remove temp debug logging (0e594d76) and revert BYPASS LOD (8b13f678) after root cause found. Then deploy PC.
  Paths: `server/plugins/citizens/lib/CitizenAlive.js`, `server/plugins/citizens/`

## NEXT

- [ ] _Empty — add tasks here as they come up. Format:_
- [ ] _Example: "Quest: <name> — <one-line scope>" — Paths: `<dirs>`_

## LATER

- [ ] _Empty — bigger ideas waiting their turn._

## DONE

- [x] 2026-10-08 — citizens: offices rung — honor judge claims in candidacy, deterministic weighting tests (13/13 pass), pushed to origin/main c0e6abdd
- [x] 2026-10-08 — citizens: revert LOD diagnostic bypass + remove temp debug logging (CitizenAlive.js:637 LOD gate restored); BYPASS never went live on PC beyond disk state at 13:46 — removed via deploy; debug instrumentation never fired (0 players logged in after 12:51 deploy), so the BYPASS test was INCONCLUSIVE — movement bug NOT root-caused, needs live-player test with Jon
- [x] 2026-10-08 — PC deploy 14:16 EDT: kill (12 stale node procs) → pull 1117e99e → node --check → start-tma.bat → port 43594 LISTENING, clean boot in C:\tma\server\logs\server.log, watchdog Ready, RAM free 3.4GB (was 842MB)
- [x] 2026-10-08 — citizens: fix animation.getId crash from playtest
- [x] 2026-10-08 — citizens: fix LOD bands using director positions

## Handoffs

_2026-10-08 14:30 EDT (coordinator-1400) → next:_
- Origin/main = c0e6abdd (offices rung). PC is on 1117e99e — offices rung is pushed but NOT deployed; deploy it in the next unblocked window (kill→pull→verify→start + watchdog re-enable).
- Movement bug: spawn works when players near (12:48 diag: 16 citizens online w/ players); 0-online with 0 players is by design. LOD gate is sound on code review. Do NOT write more speculative fixes — needs Jon's live playtest.
- Movement-diagnosis task entry below (heartbeat-1325) is closed as done: diagnosis phase ended with an open-item for Jon, debug + bypass removed, PC deployed clean.
- [x] DONE — heartbeat-1325 — movement diagnosis phase: root cause NOT found in code review (pipeline spawn→attachBrain→tickProximity→tickAlive→movement intact, LOD gate sound); debug instrumentation never fired (no players post-12:51 deploy), BYPASS test inconclusive. All temp debug + BYPASS removed, PC deployed clean 14:16 EDT. OPEN ITEM for Jon's next playtest: live-player movement verification.
