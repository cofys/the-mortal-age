# Explorer's ring free alchemy implementation plan

**Goal:** Finish native free alchemy, then focus on Pets.
**Spec:** ../specs/2026-10-27-explorers-ring-free-alchemy-design.md
**Architecture:** Plugin-owned ring sessions/payment; generic core alchemy entry and payment event.

- [x] Add failing real-object regressions using native widget paths.
- [x] Add generic cast API/payment event and preserve source/item identity through queues.
- [x] Implement Alchemy.DiaryRewards.js panel, choices, item-use warning and payment guards.
- [x] Wire ring inventory/worn/submenu Alchemy while preserving other actions.
- [x] Build and run focused/full suites; reproduce unrelated failures on baseline.
- [x] Independent Codex review, fix findings and re-review.
- [x] Own MCP walkthrough, persist/relog and stop owned services.
- [ ] Push ready PR with factual source/testing evidence; release claim.
- [ ] Audit Pets page versus code, claim and implement remaining items separately.
