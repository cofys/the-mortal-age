# No-Commands Migration Plan

**Directive (Jon, 2026-10-06):** "I don't want ::commands. We should have buttons or other ways to do that."

Every player-facing `::command` gets a diegetic replacement: NPC dialogue, objects, interfaces. Admin/dev commands stay.

## Migration rule

Build the world path → verify it works in-game → remove the command. Never the reverse. The `::command` stays registered until Jon confirms the replacement works.

## UI template

All new interfaces use the Mortal Age UI template from `server/plugins/origins/Gui.Origins.js`:
- Palette: PANEL 0x14100b, GOLD 0xc9a227, PARCHMENT 0xe8ded0, etc.
- Fonts: 497 display, 496 label, 494 body. All text shadowed.
- Nested panels for depth. Gold-glow selection.
- Document any new interface in its module header.

Custom group IDs (must be unique): 30010 citizen stall, 30011 DuelArena, 30012 origin GUI, 30013 player stall, 30014 market board, 30015 war table, 30016+ free.

## Phases

### Phase 1: Market Board ✅ (built)
`server/plugins/citizens/shop/MarketBoard.Shops.js` — group 30014.
"Market board" object → Read → interface with Lease / Manage / Browse.
Replaces: `::shop buy|manage|list` (and via the stall interface: stock/price/hire).
Verify: place/check a Market board object in a capital market, click through all three buttons.

### Phase 2: Steward's audience (offices)
Replaces: `::office list|claim|petition|influence|vacate`
Design: a Steward NPC (or castle steward's desk object) in each capital. Talk → dialogue options:
- "What offices are open?" → office list
- "I wish to petition" → petition flow (existing Politics.petition logic)
- "How do I stand with the court?" → influence
- "I resign my office" → vacate
Use `api.sendMultiChatboxPrompt` for the dialogue (proven pattern from origins fix). Call the existing functions in `Politics.Kingdoms.js` / `Commands.Kingdoms.js` — don't reimplement.

### Phase 3: War table (kingdom info)
Replaces: `::kingdom`, `::kingdom status`, `::war`, `::alliances`
Design: "War table" object in each capital → click "Study" → TMA interface with tabs or sections:
- Your kingdom: name, rank, titles (from Membership)
- Open wars: attacker/defender, hottest borders (from Tension/WarConsequences)
- Alliances and royal news (from Alliances/Royals)
Reuse the existing `onKingdomCommand`, `onWarCommand`, `onAlliancesCommand` logic — refactor them to return strings, then render in the interface.

### Phase 4: Donation chest (war effort)
Replaces: `::donate <kingdom> <amount>`
Design: "Donation chest" object in each capital → click "Donate" → amount prompt (chatbox input or preset buttons: 1k / 10k / 100k) → moves coins, emits `kingdom:donation-made`.
Note: `::donate` was registered TWICE (PlayerCommands opened a store URL, Politics did kingdom donation). Collision resolved 2026-10-06: the PlayerCommands copy (dead link to the tsps fork's deadlypkers.net — no store exists in The Mortal Age) was removed; the chest does kingdom donations via the same donateToKingdom() the Politics `::donate` uses.

### Phase 5: Charter stone (founding)
Replaces: `::found ...`
Design: "Charter stone" in the wilderness → click "Proclaim" → name prompt → founding flow. Lower priority (rarely used).

### Keep as ::commands (dev tools)
`::citizen spawn|memory|status`, `::raid leave` (safety hatch), `::origin` (fallback until GUI fully verified), all DEVELOPER/ADMINISTRATOR/OWNER commands.

## Tracking

- [ ] Phase 1: Market Board built, needs in-game verification
- [x] Phase 2: Steward's audience built (server/plugins/kingdoms/Steward.Kingdoms.js), needs in-game verification
- [x] Phase 3: War table built (group 30015), needs in-game verification
- [x] Phase 4: Donation chest built (server/plugins/kingdoms/DonationChest.Kingdoms.js), needs in-game verification
- [ ] Phase 5: Charter stone
- [ ] Remove `::shop` after Phase 1 verified
- [ ] Remove `::office` etc. after Phase 2 verified
- [ ] Remove `::kingdom`, `::war`, `::alliances` after Phase 3 verified
- [ ] Remove `::donate` (Politics) after Phase 4 verified. Collision already resolved 2026-10-06: the duplicate `::donate` in PlayerCommands.plugin.js (opened the dead tsps-fork store URL deadlypkers.net) was removed — it shadowed the kingdom-donation command depending on plugin load order. `::store` left untouched (separate command, out of scope).
- [ ] Remove `::found` after Phase 5 verified
