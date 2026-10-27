# Olmlet: native dust unlock

## Evidence and scope

- [Metamorphic dust](https://oldschool.runescape.wiki/w/Metamorphic_dust): use one dust on Olmlet for a permanent unlock; repeated use must retain additional dust. Item dialogue uses the published transcript.
- [Olmlet](https://oldschool.runescape.wiki/w/Olmlet): March2021 change prevents consuming all dust and adds an already-unlocked message.
- Local pinned cache241 at6e5033af6215963581a51b348f452320ff18f0f6 confirms `raids_challenge_morph`22386, `olmpet`20851, follower`raids_olm_pet`7520. House7519 is not the follower. No indexed `olmpet`/`dogadile_pet` recording; exact response timing/refusal wording is not capture-verified.
- This PR repairs the unlock input and consumption boundary. Missing Enraged Tektiny/Flying Vespina forms, form-specific item IDs and official form-selection presentation are separate work; it does not claim the whole Olmlet family is finished.

## Real path and shared assumptions

- Native inventory Use→NPC packet → `NetworkBuilder` → `UseItemPacketListener.itemOnNpc`: validates slot/id, resolves actual target, queues real walk-to, then rechecks source Item identity/id/amount and NPC identity before emitting the public item-on-NPC event.
- `Dust.Pets.useDust` scopes to a registered owned current follower whose pet definition is Olmlet, and rechecks the exact selected live slot. Other players' pets and other items cannot consume or unlock anything.
- Real `ItemContainer.deletedItem` removes one from that selected slot; no capacity-dependent reward is produced. Existing `pets:morph-unlocks` and `petFamily` remain the state owner; historical `item:20851` saves continue working. Persistence is requested after consumption/unlock. The item-statement dialogue then displays the Wiki transcript.
- Native Metamorphosis→Pets shared gate now requires that saved permanent unlock; holding dust is insufficient. Other pets' item-gated morphs are unchanged.
- Walking, NPC removal, inventory replacement or Bank transfer can invalidate the queued action. Tests exercise real native packets, containers, bank APIs, save restoration and registered NPCs, not handler-only fake game objects.

## Verification

- New real-object native tests8/8: first use with two dust leaves one and preserves form; carrying-only Metamorphosis refusal; repeated use/free subsequent morph; another owner's follower; queued use after real bank deposit; logout/PlayerSave/fresh login followed by native morph; zero hitpoints and actual trade opened during walk-to preserve dust and deny unlock.
- Startup/shutdown hooks initialized; network messages captured only. No random rolls or clock changes are needed for these mechanics.
- Final build passed; full suite9,157/9,157, no skips. Independent Codex review reproduced dead/queued-trade consumption, then passed5/5 additional lifecycle checks and32/32 Pets foundation checks on the guarded source. Real Bank remove/return, exact selected-slot metadata preservation and legacy unlock restoration were checked. Dust is unstackable; no stack-merge claim.
- Final-source native browser Use consumed one of two dust and rendered the Wiki item-statement text/icon; repeat Use retained the second dust with the already-unlocked message. Native Metamorphosis worked. Items were seeded QA fixtures, not raid-earned drops.
- A separate gameUpdate restart exposed existing follower persistence loss: shutdown saves omit the physical active pet and do not run Pets logout. Its independent shutdown/snapshot/fresh-login reproduction is retained for a separate fix. This PR verifies normal logout, not shutdown/crash recovery.
