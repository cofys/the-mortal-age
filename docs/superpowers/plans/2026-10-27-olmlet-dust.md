# Olmlet dust implementation plan

**Goal:** Make the native Use dust→owned Olmlet path unlock metamorphosis permanently; merely holding dust must not unlock or consume it through Metamorphosis.

**Architecture:** A scoped `Dust.Pets.js` unit attached by Pets shares its existing family/unlock service. Keep existing saved `item:20851` unlocks compatible. Validate live owned follower and exact source slot. One selected dust is consumed, permanent unlock saved, Wiki item dialogue shown; repeated use leaves dust untouched.

**Sources:** Wiki Metamorphic dust/Olmlet and transcript; local rev241 named identifiers; no indexed olmpet/dogadile recording. No invented form-selection interface. Missing forms and variant item identity remain a subsequent PR.

**Constraints:** Separate own worktree; no Claude, generated JSON, live or raid-delivery edits. Inline execution already authorized. Codex independent review and real shared/native/rendered checks before ready PR; stop QA services/clear slot afterward.

- [ ] Real Player/NPC native item-use and Metamorphosis RED: consumes exactly one on use, refuses carrying-only morph, duplicate/other owner/stale route/save/relog.
- [ ] Minimal unit + five Olmlet requirement metadata rows; retain other pet gates.
- [ ] Build, focused and full tests; underlying real inventory/Bank queued path and persistence checks.
- [ ] Independent reviewer chooses additional adversarial scenario and runs it on fingerprinted source. Actual rendered native dust selection/use/dialogue, repeat and saved unlock.
- [ ] Push separate ready PR with sources, exact limits and reviewer evidence; release claim and owned processes/slot.
