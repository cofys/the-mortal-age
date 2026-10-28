# Recover pets stranded by static collision

**Goal:** allow an owned active pet that cannot progress toward its owner to catch up automatically, while preserving normal walking and owner actions.

**Evidence:** Wiki Pet says pets teleport close when stuck and/or distant. Exact automatic delay/destination distribution is not established by the available captures. Real cache241 church geometry reproduces3 failures: stationary adjacency across blocked edge, alternative route=true with0further steps while3tiles away, and physical-form/cat-clock continuity through the same stall. Plane/private-context/distance>15 catch-up already exists and remains unchanged.

**Architecture:** MovementQueue emits the generic movement:follow-blocked event only after mobility permits following, for blocked stationary adjacency, no legal destination or a route with no checkpoints. A named CatchUp.Pets unit validates current owned registered visible follower/owner life/placement/context/area and repositions the same NPC. No polling/timer, item mutation, new persistent attribute or core pet-specific policy. No dependency on Call follower PR#1437.

- [ ] Preserve failing actual NPC.process/collision reproductions; ordinary clear walking and frozen/non-pet/foreign cases remain green.
- [ ] Add the generic event at the three no-progress exits and pet handler. Pick a statically unblocked, reachable adjacent tile, preserving NPC identity/form, ownership, active item, cat clock and leader dialogue/queues/tasks.
- [ ] Verify underlying partial-route semantics, normal routing, collision, actual mobility, actual private contexts, life/logout state and saved follower. Independent reviewer must choose real system transitions beyond these author's cases and review the small shared core change.
- [ ] Freeze source, build, focused/full tests, native browser automatic catch-up evidence. Document unverified official timing/placement and skip active Claude-owned clue integration.
- [ ] Publish separate ready PR, stop own services/helpers/browser and clear only own slot.
