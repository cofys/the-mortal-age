# Adventure Paths

The current cache exposes the Combat path (15 level milestones) and Gatherer path
(Fishing, Woodcutting and Mining level 5). This plugin implements those paths with
Adventurer Jon, the native overview, side panel and reward catalogue, task claims,
starter kits, the Combat path voucher and Lamp of the Gatherer.

## Eligibility and saved state

- New and returning Tutorial Island answers qualify after leaving the island.
  Experienced and Ironman accounts do not. Unknown tutorial eligibility does not
  silently qualify an existing account; the stock world disables Tutorial Island.
- Completed milestones use base levels, not temporary boosts. The plugin records
  verified enrollment in its own saved state, so later disabling Tutorial Island
  does not erase an enrolled account's eligibility.
- Task progress, separate free/member claims, completion rewards, kit use, voucher
  redemptions, lamp use, opt-out state and view settings survive saving and login.
- Jon's canonical dialogue supports enrollment explanations, starter kits, reward
  claims, opt-out/opt-in confirmation and opening the overview. His Claim option
  also recovers missing unused completion items.

## Rewards

Task and path reward rows come from cache enums/structs. Each bundle is planned on
a real copied Inventory before applying it; a failed bundle remains claimable.
Free-to-play claims preserve later members-only additions.

Searching the starter kit grants its documented contents once. A lost unopened kit
can be recovered; opening it permanently prevents another contents grant.

The Combat path voucher has nine redemption flags across six Varrock recipients.
A free-to-play world consumes it after its last available reward; joining a members
world allows Jon to replace it for the remaining member rewards. The Wiki documents
actual quantities that differ from the cache's descriptive text: grants use the
Wiki quantities, and the native descriptions remain unmodified.

The Gatherer lamp opens the shared XP interface restricted to Fishing, Mining and
Woodcutting, awards 150 XP once, and validates the exact item again on confirmation.
A lost unused lamp can be recovered; a used lamp cannot.

## Native interface protocol

- Overview 642, reward catalogue 643 and side panel 644 use the current cache's
  listeners. Reward renderers 2843 and 3509 are invoked with their cache arguments.
- Side-panel Show Paths/task information and both panels' hint controls are wired.
  Hints select nearby fishing NPC categories, tree categories or the specified
  rock ID; unavailable or off-scene targets use cache fallback coordinates/text.
- The client transmits only view/focus/filter varps 2357, 2358, 2359 and 2370.
  The server validates modal ownership and writable bits. Recommendation bits
  share 2359 and remain authoritative; saved settings contain only writable bits.
- The cache disables the alternate Warrior/Wizard/Ranger variants in this revision;
  their unused data does not make them selectable.

## Evidence and limits

Sources: [Adventure Paths](https://oldschool.runescape.wiki/w/Adventure_Paths),
[Jon's transcript](https://oldschool.runescape.wiki/w/Transcript:Adventurer_Jon),
[starter kit](https://oldschool.runescape.wiki/w/Combat_path_starter_kit),
[voucher](https://oldschool.runescape.wiki/w/Combat_path_voucher), and
[lamp](https://oldschool.runescape.wiki/w/Lamp_of_the_Gatherer). IDs, layout, options,
reward rows, target categories and fallback text are from cache 241.

The RSProx index has no indexed Adventure Paths/Jon interaction evidence. The
15-tile loaded-scene hint search and first-incomplete recommendation ordering are
implementation choices, not recorded timing or ordering claims. Native client VM
checks are not an interactive visual certification.

## Verification

- Real Player, Inventory, PacketSender, NPC, map, ClientConnection and PlayerSave
  tests cover all 18 task rows, both path items, all nine voucher rewards, the
  free-to-play/member transition, duplicate/full-bag cases, delayed lamp guards,
  canonical dialogue, settings, live hints and save restoration.
- Client checks cover all three interfaces, both path reward catalogues, voucher
  rendering and the transmit whitelist.
- Isolated MCP walkthrough on slot 83 used a prepared eligible QA account: Jon
  opened 642 on 161:16 and 644 on 161:74; native dialogue granted a starter kit;
  Attack 5 granted a steel longsword and 500 member coins. Logout/login preserved
  inventory, participation 9340=1, task/free/member masks 2364/2365/2366=2, selected
  path 2357=1 and combined focus/recommendations 2359=19005441.
- Independent Codex reviews identified and verified corrections for delayed lamp
  guards, ineligible dialogue, side-panel operations, focus bit preservation and
  missing completion-item recovery through Talk.
- The QA server was stopped through its gameUpdate command after saving.

The Jon/progression/modal route is implemented here. A companion integration is
still needed for the native journal icon (629:26): the existing client maps that
tab to generic menu 187, rather than the Adventure Paths focus panel 644. Its
Disable operation must also be wired. This item and the overall Clues,
achievements & collections section are not yet certified complete.

## Native journal companion (26 October2026)

The Adventure Paths star now mounts644 at629:43 (the normal journal container), while642/643 keep644 as their modal side panel. Header Disable uses Yes/No and restores summary712; opting in through Jon restores participation and the journal. Selecting another journal tab cancels pending restoration and persists the AP panel preference. An unrelated main window defers restoration, and Disable refuses to close that window.

The welcome screen’s raw gameframe bootstrap can replace the sidebar after login. A generic gameframe:ready notification allows a next-tick AP restore after Play, including when PacketSender still remembers the earlier mount. Native QA verified enrollment from the persisted path record with Tutorial Island disabled, Show, Disable/No, Disable/Yes, disabled relog, Jon’s canonical opt-in, and the resulting9340/8168 values (active1/tab3, disabled2/tab0). Other-tab selection survives as a preference not to force AP back in; the shared journal currently boots to summary0 after relog. The client VM sweep of629/644 reports no script errors, item0 or null text.

Independent Codex reviews found and verified fixes for preserving an unrelated main window and for restoring summary after opting out of a closed modal. Native QA also produced a failing welcome-Play regression, now fixed and independently re-reviewed. The focused AP/journal/gameframe checks pass61. Full-suite evidence is recorded separately once complete.

Final journal-companion full suite:8,232/8,232 pass,0 failures/skips (node --test --test-concurrency=2 tests/). The frozen native walkthrough also confirmed the panel returns after Welcome Play and another-tab preference prevents an unwanted AP restore.
