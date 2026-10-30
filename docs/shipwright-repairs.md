# Shipwright Seb boat repairs

Seb's Repair-boat option and the repair choice in his ordinary Talk-to menu repair the
boat currently visiting the shipyard. Dock shipwrights retain their existing services.
Only the selected owned boat changes; this does not recover a sunk boat or change cargo,
facilities, docking state or another boat.

## Sources and limits

- [Shipwright Seb](https://oldschool.runescape.wiki/w/Shipwright_Seb) and
  [Boat](https://oldschool.runescape.wiki/w/Boat):50coins for each missing HP; use inventory
  funds when sufficient, otherwise the entire fee from the bank.
- The existing generated `npc-dialogues.json` Seb entry supplies the repair question,
  healthy response, fee/confirmation, Yes/Yes-and-don't-ask/No, worker message and completion.
  It is projected per playback, never edited or mutated globally. Other Talk-to options
  continue through the same canonical transcript service.
- Pinned241dump6e5033af6215963581a51b348f452320ff18f0f6 and active241cache identify
  sailing_shipyard_manager/vis15351/15352, Repair-boat op4 and
  boat_repair_cost_warning_dismissed (settings_varp_6 bit24).
- Local RSProx identifies13 recordings of Seb, with Trade attempts in235/3455, but no
  Repair-boat action for either base or transformed NPC. Repair animations and exact
  packet/tick order are unverified. No worker NPCs or timing are invented.
- Payment and healing commit synchronously when the confirmed choice resolves; subsequent
  canonical lines describe the completed repair. Stale quotes are refused rather than
  silently repriced. The don't-ask preference is saved after a successful repair. Those
  boundary/timing policies and refusal wording are implementation choices where evidence
  does not establish exact OSRS behavior.

## Production path and ownership

- Native NPC op4 / Talk-to → NPC interaction dispatcher → named repairs plugin handler.
  Talk-to reuses `npc-dialogue:start` with its request-local `select` projection; only the
  repair choice receives a plugin action. No shared dialogue service changes are needed.
- `NpcDialogues` → `DialogueManager` speech continuations → `MultiChatboxPrompt` native
  widget219:1 resume → canonical action hook → repair quote commit. The action replacement
  guard preserves replacement dialogues; explicit transcript cancellation owns only its
  chatbox. A multi prompt closes interfaces before its callback, so the quote is invalidated
  on `interface:changed` when a bank/trade/main modal opens, before that state is erased.
- `Shipyard.visitedBoat` owns the chosen profile reference. The quote keeps that exact boat,
  NPC, damage/fee and session. Registration, life, distance, busy state, visit/profile
  identity and unchanged damage are rechecked before charging; refusal/No consumes nothing.
- Real Inventory/Bank own currency mutation. A read-only slot plan spends the complete fee
  across matching coin stacks using `deleteAtSlot`, preserving metadata on the remainder;
  `getAmount` sums those stacks but the legacy `deleteNumber` only touches the first slot.
  Bank fallback uses `bank-pin:guard`; only that
  intentional modal transfer retains the quote, and the resumed operation revalidates it.
  Removing/replacing the visit while PIN entry waits cannot charge or repair a different boat.
- `BoatHp.heal/sendHitpoints` own HP/storage varbits; `Shipyard.refreshShownBoat` owns the
  displayed boat. Currency charge and healing are synchronous. No item is produced, so
  output capacity/stack-merge rewards are inapplicable. No retained currency Item reference
  is deleted later; current fungible coin balances are checked at commit.
- A persisted namespaced preference restores the named cache warning varbit on login.
  Quotes and callbacks are temporary and cleared on logout. Duplicate old resumes cannot
  pay twice; a new repair gets a new session.

## Validation ledger

- Fresh incremental server build after including mainb3c813bb1's changed dialogue foundation.
  Gameplay additions are JavaScript; no subsequent compiled source edits require rebuilding.
- Initial real-actor Repair-boat case failed because the option was unhandled, then passed
  through the real dispatcher, dialogue owner, prompt, Inventory and BoatHp path.
- Six additional boundary groups passed initially; a real Bank.open replacement retained
  the old prompt and exposed a stale payment. Interface-change invalidation fixed it;
  the bank replacement, real trade and real PIN/resume checks pass3/3. Their original
  assertions were retained. No blanket suite run.
- Save hydration restores the preference; quote changes, real replacement visit, teleport,
  death, full bank fallback, insufficient separate sources, decline and duplicate resumes
  are covered by real-object checks. Only network boundaries are stubbed.
- Independent review completed with four passing adversarial cases, including real bank
  deposit, metadata-distinct coin stacks, a non-active visited boat and immediate repair
  through the locked PIN guard. Nine distinct author cases passed across focused runs;
  this is not a claim of one combined nine-case run. No full suite was necessary.
- Independent review reproduced an undercharge with two metadata-distinct coin stacks:
  a500coin quote consumed only the first100coins. Payment now plans/commits exact slots;
  the retained regression also challenges actual bank deposit of those separate stacks.
- Native production client on isolated slot12 verified the Talk-to repair choice, No,
  right-click Repair-boat op4, the500coin quote, Yes and HP70/80 to80/80. A later550coin
  bank-funded repair used native scrambled PIN buttons and the don't-ask choice:
  damage0, inventory0, bank3950, warning1. Actual logout/relogin restored the preference;
  a new2HP repair skipped confirmation, requested the PIN and left bank3850, damage0.
  The initial Talk-to and post-relog NPC requests were sent by agent MCP; repair choice,
  decline, the initial right-click repair, confirmations and both PINs used native client input.
- Disposable QA setup seeded a skiff, damage,5000coins, skills/developer access and a test
  PIN; it entered the existing shipyard and repositioned the player. Coins were moved by
  actual Bank.open/deposit. No feature handler, dialogue owner or currency container was
  mocked; no spawn or generated-data edits. The unchanged client build was reused after
  verifying source identity. Player bots were disabled (dependent BountyHunter skipped).
- Local evidence is retained under .runtime/seb-repairs: focused logs, independent review,
  native state snapshots and four screenshots. Those fixtures/artifacts are not production
  files and are excluded from the PR. Exact OSRS worker timing remains unverified.
