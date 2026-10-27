# Chompy chick acquisition implementation plan

**Goal:** Restore real diary eligibility and the missing configured pluck roll.
**Spec:** ../specs/2026-10-27-chompy-pet-acquisition-design.md
**Architecture:** Generic diary reward query; Pets metadata/eligibility and unit; successful
quest pluck event. Existing generated drop row and roller stay canonical.

- [x] Reproduce eligibility and pluck failures on real objects.
- [x] Add read-only claimed-reward query and metadata-based Pets eligibility.
- [x] Guard successful corpse consumption and emit one pluck event.
- [x] Reuse filtered drop-table roll and common pet delivery in Acquisition.Pets.js.
- [x] Update obsolete fake-flag fixture; retain fake coverage while adding real regressions.
- [x] Build/focused/full tests, independent Codex review and native walkthrough.
- [ ] Push ready PR, update tracker audit evidence/coordination, stop owned services.

Ruling: no generated data repair is needed. The original Chompy Wiki source and
generated entries already contain the pet; the progress note incorrectly says missing.
