# Replacement stack review plan (#1407)

Review comment6433281391 targets exact head3222d8f0c. Real ItemContainer.add fills an
empty stack slot by mutating its existing empty Item; real bank transfer empties it by
mutation too. Retained-reference alchemy guards therefore accept a different stack.

- [x] Reproduce native item-on-ring queued cast across real Bank open/deposit/withdraw/close.
- [x] Reproduce a native confirmed cast after real inventory removal/refill; retain legitimate merges.
- [x] Give newly filled empty stack slots fresh cloned Item identity in generic ItemContainer.add.
  Preserve existing nonempty stack merging, metadata matching, bounds/caps and reference guards.
- [x] Build, focused transfer/alchemy/bank tests and full suite; independent Codex review.
- [ ] Push the existing PR without rewriting history, answer review with commit/evidence,
  preserve Claude/live/Pets work and stop/clear own test services/slots.

This is a generic container lifecycle repair, not ring-specific logic in core. The user's
standing authorization allows inline planning/implementation and review fixes. Own original
ring worktree fast-forwarded from30a6193af to the reviewed3222d8f0c; no other worktree edits.
