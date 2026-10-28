# Lil' Zik forms implementation plan

**Goal:** Unlock the six Lil' Zik forms with one native Sanguine dust Use, retaining correct physical items, family ownership, collection progress, storage/recovery and save/load.

**Architecture:** Stack on #1418's canonical family-item metadata and menagerie support. Add five cache-backed follower/item pairs under22473. Extend Dust.Pets' existing guarded operation to a second dust/family pair. Keep `item:22473` as its permanent unlock key. Use a metadata refusal message for the recorded locked operation; do not invent a new selector.

**Sources:** Actual RSProx Metamorphosis op3,229/2783 and239/4288: refusal at+0. Wiki Lil' Zik/Sanguine dust: five alternates, native Use and unlock dialogue. Pinned cache241 enum3856 and actual item/NPC definitions: six physical forms and native operations. Alternate follower appearances exist but no indexed successful player operations; exact field selection presentation/order remains unverified. Hard Mode dust acquisition/rate is a separate raid/reward task, not a free grant.

**Constraints:** Own worktree only. No Claude/clues/Leagues/live edits, no generated JSON/core/client changes. Separate reviewed ready PR, then stop own test services/helpers and clear its actual assigned slot.

- [ ] Build stacked baseline; add real native tests and observe RED for missing dust gate/forms.
- [ ] Add metadata and extend guarded Dust.Pets routing; retain Olmlet regression behaviour.
- [ ] Verify real Bank, ownership/collection, native Probita/menagerie and save/login; independently challenge queued dust Use and item identities with exact source fingerprints.
- [ ] Verify actual rendering client/native operations and every new relevant control; retain source/evidence limits.
- [ ] Run focused/full checks, independent Codex review; push separate ready PR, attach, release claim and clear own services/slot.

Review focus: correct follower rather than POH IDs; wrong dust/foreign/dead/busy/stale item refusals; one permanently consumed dust; native recorded denial; all six explicit item identities; one family/log entry; actual Bank/house/PIN/persistence paths from stacked shared implementation; Hard Mode reward source remains explicit.
