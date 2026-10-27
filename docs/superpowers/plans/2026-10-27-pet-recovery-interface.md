# Probita recovery interface implementation plan

**Goal:** Replace immediate return-all with cache-native lost-pet selection and free reclaim.
**Architecture:** Recovery.Pets.js owns ephemeral interface sessions and native packet hooks.
Pets.plugin.js supplies its existing family/ownership/display helpers and delegates Probita's
existing generated dialogue action. No core or generated-data changes. API core only in new unit.
**Tech stack:** Existing JS plugins, shipped revision241 cache/CS2 and real-object node tests.

Evidence: local osrs-dumps pinned6e5033af, interface148, init6126, enum985 (72 pet families),
enum169 (Bank1, Inventory2, Follower3, Menagerie4), selected varbit13980. Three31-bit
insured/held masks and nine packed4-bit location ints drive the native renderer. Dynamic
reclaim rows start6, stride5; native Confirm lives148:37 child0. Wiki Probita confirms free
reclaims since10September2025; cats/dogs excluded. Captures index has no Probita actions.

Design choices: use native row selection then Confirm, re-query live ownership/family/held
state before giving a single item, preserve stored item variants, reject stale or forged inputs.
Guard recovery contents with shared Bank PIN service. Require alive/registered/nonmoving/status
safe state, an open modal and unchanged origin/private area. No artificial fees or pet grant command.
If no indexed pet family exists, fail closed rather than invent a row. Reopening/closing/logout
clears selection; full bags retain eligibility and show no-space without loss. Held-family checks
include all variants rather than just the remembered item. Other storage answers existing
pets:held-elsewhere. No pet transcripts invented; generated dialogue remains canonical.

- [x] Confirm cache148/6126/enum985/169 and packet shape; document capture gap.
- [x] Add real-object failing native-open/select/confirm tests and awkward input cases.
- [x] Implement focused recovery unit and minimal Pets delegation/registration.
- [x] Replace obsolete immediate-reclaim fake assertion with native real coverage.
- [x] Build, focused/full suite; own MCP walkthrough and client script/render checks.
- [x] Independent Codex review; fix findings, re-test, push separate ready PR1410.
- [x] Release claim; stop own services and clear new slot reservation after testing.

User authorizes inline planning/implementation and separate reviewed PRs. Preserve Claude's
clue/League work and all active worktrees. New own worktree uses slot2, the first free slot;
slot1 is deliberately retained for tracked unpublished source.
