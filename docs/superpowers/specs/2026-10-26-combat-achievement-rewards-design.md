# Combat Achievement reward completion

## Verified problems

- The reward unit recognizes only Ghommal. Laidee Gnonock's canonical reward
  variant already exists but never gets selected or granted. She replaces Ghommal
  after While Guthix Sleeps and is the normal Grandmaster reward NPC.
- Delayed claims do not retain the NPC/player context; lamp confirmation validates
  only the slot object and skill level, leaving stale item/life/status cases open.
- Canonical Laidee dialogue opens an unwired hilt reclaim interface. Ghommal's
  current Wiki transcript is explicitly incomplete and lacks that route.
- The lucky penny is currently consumable in cache 241 and the Wiki. Its charge
  effect belongs to a later integration step, coordinated with Claude's Leagues
  work rather than edits to Claude-owned charge-consuming plugins.

## Scope and independent PR sequence

1. Support initial rewards at both canonical NPCs and guard delayed claim/lamp
   transactions. Preserve canonical dialogue and cache reward data. One small
   reviewed PR; no unrelated tier threshold or perk changes.
2. Wire replacement rewards through the canonical action and an evidenced native
   selector; verify free duplicate hilts, earlier tiers and post-quest behavior.
   Resolve the incomplete pre-quest dialogue from evidence without hand-editing
   generated JSON or copying a repaired dialogue subtree into an override.
3. Consume/persist the penny and connect its documented charge-saving behavior
   through shared services after coordinating ownership. Audit remaining tier
   perks separately and make reviewable follow-up PRs.

## Phase 1 implementation

- Named NPC set includes Ghommal and Laidee Gnonock. Capture a real interaction
  context without intercepting quest conversations; canonical variant/condition
  hooks still choose and execute the reward branch.
- A claim keeps the chosen tier and original nearby NPC context. Recheck living
  player, normal status, placement/teleport/force movement, NPC ownership/private
  area and current entitlement when the native confirmation arrives.
- Plan the entire lamp/hilt/penny bundle in a real cloned Inventory. Apply the
  items and claimed state together only after a full successful plan.
- Lamp requests retain exact item ID, object identity, metadata, slot and earned
  tier. Recheck those plus life/status and skill requirements on confirmation.
  Clear pending state on logout. Never consume a lamp if XP was refused.

## Evidence

- RSProx 237/01107 shows an Easy claim at the Leagues VI tutor, claim varbits,
  inventory receipt and lamp behavior. It does not verify normal-world NPC
  replacement dialogue, reclaim layout or newer penny consumption.
- Current Wiki Ghommal/Laidee transcripts and hilt/lucky-penny pages define NPC
  roles and behavior. Both transcripts warn about missing changed penny dialogue.
- Cache 241 supplies IDs, options and tier reward rows; no generated data edits.

## Validation and delivery

Real Player/Inventory/PacketSender/ClientConnection/NPC and all plugins loaded.
Native dialogue input, every tier, duplicate confirmation, full/last-slot bags,
metadata or replaced lamps, death/trade/teleport/placement/force movement, logout
and save/relogin. Build, focused and full suite, own MCP walkthrough, independent
Codex review before PR, user fork and documented source limitations. Stop all
owned servers/helpers. Preserve Claude's branches and live game.
