# Olmlet forms implementation plan

**Goal:** All eight cache241 Olmlet followers have their correct physical items, one ownership/recovery family, and one base collection entry. Preserve the existing dust unlock and legacy saved variants.

**Architecture:** Extend existing Pets metadata with a canonical family item ID. Keep its stable `item:20851` key so old unlocks/variant maps still load. Resolve legacy base-item variants only while their old base ownership record remains; newly recorded variant items summon their own form. Morph updates ownership immediately; physical item identity wins over a later family's saved preference. No core, generated data or client changes.

**Evidence:** Wiki Olmlet/Metamorphosis and 28 May2020 update establish the forms/unlock. Local pinned dump6e5033af and active cache establish items/follower NPCs/native actions; enum1711 is a menagerie mapping, not proof of the field interaction order. Actual populated capture index finds the follower appearances but zero player actions on these forms; initial negative lookups used the wrong cwd and were discarded. Existing one-step native cycle is retained, inserting the two alternates beside their normal forms; exact official selection presentation/order remains unverified and is not claimed by this PR. No invented new interface/transcript.

**Constraints:** Own worktree only; no Claude/clues/Leagues/live edits. Follow docs/claude-pr-process.md and server/AGENTS.md. Separate ready PR after independent Codex review and checks. Stop own QA server/client/browser and clear own slot7 afterward.

## Tasks

- [x] Add real cache/native tests for eight NPC/item pairs, dust gate, variant pickup/bank/withdraw/drop, collection/duplicate ownership, recovery and save/relog; initial13tests failed12/13 before implementation.
- [x] Update metadata and generic family/log resolution; preserve legacy key, explicit item identity and current recorded form. Test older saves and separately held duplicate base items.
- [x] Final full suite on frozen source9216/9216; build/authored29/29 and independent77+UI2/actualcachewire checks pass, baseline nonfailing hook errors reproduced separately.
- [x] Run actual rendering client/native controls: both new followers render; native Enraged transformation/pickup and Flying menagerie icon/Take/Examine/Toggle verified with server state and screenshots.
- [ ] Commit/push one ready PR with source/evidence/checks/limits in required layout. Attach it, release claim, stop helpers and clear reservation.

## Review focus

- An explicit physical form must survive real Bank transfer and another form's preference.
- Legacy base-item saves and `item:20851` dust unlock must still restore their old form.
- Alternate forms cannot become independent owned/reclaimable pets or extra log slots.
- Full inventory, another owner's click, death/trade state and repeated pickup cannot mint pets.
- #1417 active-follower persistence is a declared stacked prerequisite; combined legacy native Drop/shutdown/fresh login must preserve the resolved physical marker.

## Implementation rulings

- Correct physical IDs expose menagerie base-only storage; include the minimal dependent Construction unit change, disclose it outside Pets. Persist slot-to-form data, retain one family slot and use cache varbit/enum for icon/roaming/withdrawal.
- Independent real Bank queued-use reproduction found duplication; validate captured slot identity, live house/player/furniture and shared PIN before mutation. Native211 withdrawal validates modal and delayed PIN context.
- Actual rendering-client Take exposed missing dynamic child action flags; grant rows0..71 after native open, including PIN reopen. Examine uses the actual stored item. Existing roaming root has cached transmitop1.
- A QA attempt prepared211 behind the welcome overlay; closing welcome invalidated its flags. Discarded that sequence and retested clean View/Take/Examine/Toggle after welcome. Independent actual-cache wire test confirms ordinary open/flags succeeds and close/remount clears overrides as expected.
