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

- [x] 2026-10-08 — citizens: fix animation.getId crash from playtest
- [x] 2026-10-08 — citizens: fix LOD bands using director positions

## Handoffs

_Notes for the other pair go here, newest first._
