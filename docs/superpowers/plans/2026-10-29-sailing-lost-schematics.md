# Sailing lost schematics implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task by task. Root owns this isolated worktree.

**Goal:** Replace unconditional schematic unlocks with source-backed acquisition, reading, persistent unlocks and authoritative shipyard building restrictions.

**Architecture:** A members Schematics plugin owns the twelve cache schematics and ten lockbox/key/directions loops. It uses the existing item/object/NPC dialogue hooks, real containers, collection-log event and PlayerSave attributes. Sailing login only describes boats; shipyard parts/facilities ask an additive schematic policy before consuming materials.

**Tech Stack:** JavaScript content plugins, TypeScript server APIs, node:test, pinned rev241 cache/dump.

**Spec:** Curt approved all three proposed Skills units. This branch owns lost schematics only; bounty and charting are independent PRs. Official Wiki mechanics outrank captures on changed behaviour; cache controls IDs.

## Global constraints

- Base origin/main776c7f0a9, own existing isolated worktree/slot7; preserve previous PR branches. No live or other-worktree writes.
- Read local pinned dump6e5033af6215963581a51b348f452320ff18f0f6 first and confirm active cache osrs-241_2026-10-20.
- No generated JSON hand edits. Reuse canonical Ava dialogue and Red Reef reward owner; source changes require canonical regeneration if truly needed.
- No guessed gameplay limits, no global processing hook, named handlers/register attach-only; new core access through api.core.
- Use real slot/capacity/identity semantics; rejected or interrupted acquisition must not lose a key, schematic or other item.
- Hold push until batch review/integration; graceful QA save/shutdown and verified client stop.

## Evidence and design

- Wiki Lost schematics: ten lockboxes/keys, no directions required to dig; Ava requires Animal Magnetism and Pandemonium; Elder Raley schematic follows Red Reef.
- Current Sailing.describeBoatsOnLogin unconditionally sends eleven learned bits. New state starts locked, twelve learned bits restored from a registered namespaced saved attribute; existing built boat parts are retained.
- Detailed Buccaneers key page establishes underground2054,10092; overview2075,3687 conflicts and must not be used.
- RSProx235/3792,00936,00960,01029 and238/04152 establish dig, consume/read/objectbox/varbit and lockbox timeline. Available direction/refusal text comes from Wiki transcripts; disclose uncaptured fallback messages.
- Read actual collection, destroy, bank/ownership, item-action dispatcher, quest reward/dialogue owners and shipyard requirements before relying on them.

## File responsibilities

- Create server/plugins/skills/sailing/Schematics.plugin.js: members registration with named unit attach handlers.
- Create server/plugins/skills/sailing/schematics/{Common,Acquisition,Unlocks}.Schematics.js: source rows/cache IDs, scoped dig/box/NPC acquisition, read/save/build policy respectively. Split only where cohesive.
- Create server/plugins/skills/sailing/data/lost-schematics.json: authored source mapping of cache names, lockbox/key/directions tiles and known read/directions text.
- Modify Sailing.plugin.js: remove unconditional learned-bit loop, retaining boat descriptions.
- Modify Shipyard.plugin.js and ShipyardFacilities.plugin.js: additive schematic policy on real build paths before mutation; preserve existing gates and ownership.
- Extend existing quest dialogue conditions/actions only if shared owners cannot supply their existing reward path, with explicit source and review.
- Create server/tests/sailing-schematics.test.cjs and docs/sailing-schematics.md.

## Review focus

- Read actual bank/drop/withdraw replacement identities, not fresh-item-only stubs; duplicates and same-name foreign keys must not unlock.
- Lockbox asynchronous stages cannot consume twice, lose output at capacity, act after move/death/logout, or mutate another player's object view.
- Saved opened-box state differs from learned recipe; server build rejects forged/native messages even when client flags suggest unlocked.
- Acquisition is collection logged once through existing owner; destroying/reclaiming and reading are separate semantics.
- Canonical quest/NPC gates remain authoritative; existing earned/built state and sibling varp bits survive relog.

## Tasks

- [x] Source/map: extract exact cache rows/IDs, read captures and Wiki detailed pages/transcripts, verify active cache and actual mapped lockboxes. Document remaining uncertainties before code.
- [x] Write meaningful failing real-player/native regressions for locked login/build, key dig, lockbox success/refusal/capacity/repeat/interruption, schematic read/exact slot/duplicate/save and NPC quest gates.
- [x] Run RED against existing unconditional unlock/stubs, retaining evidence. Implement minimal plugin-owned state and source-backed handlers; preserve all unrelated hooks.
- [x] Run GREEN with real startup/shutdown and affected foundation suites. Validate actual PlayerSave persistence, collection log and legitimate build after reading.
- [x] Trace native packet/menu -> dispatcher -> plugin -> real task/container/state owner -> saved/client state. Independent reviewer challenges a material real transition.
- [x] Root native UI: dig/open/read, item/directions dialogue controls, locked/unlocked shipyard rows, real build, full/refusal/relog; retain rendered evidence and scoped cleanup.
- [ ] Final pinned Yarn build, affected checks and coordinated full baseline/integration; local commit and prepared PR with sources, limitations and evidence. Push only when all three ready.
