# Pet names and pickup sound

## Scope and evidence

Cache revision241, pinned dump6e5033af6215963581a51b348f452320ff18f0f6, names the physical item22473 `verzikpet` / Lil' Zik and synth2582 `synth_2582`. ItemDefinition hydrates its display name from the actual cache. Enum labels are implementation identifiers: they dropped the apostrophe from Lil' Zik and the `Pet` prefix from Pet kraken, and could invent a colour prefix for Rift guardian.

RSProx229/2783 and239/4288 both show Lil' Zik Pick-up emitting synth2582 with delay20. The existing generic pet sound had delay0; puppies already use delay20. A pet-local Sound preserves the shared sound's ID/volume/loop fields and changes only its delay. Shared Sound.PICK_UP_ITEM and ordinary item pickup are unchanged. No transfer timing, animation or global audio setting changes. The two recordings are not species-wide evidence; using the same delayed generic pickup sound for other pets remains an implementation choice. No claim of human-listened audio timing or exact audible onset is made.

## Real path and state owners

- Native inventory Drop → NetworkBuilder/interaction dispatcher → Pets summon/ownership → real NPC/current follower, physical item removal and follower varps.
- Native NPC Pick-up → dispatcher/walk-to interaction → Pets.pickup → real Inventory capacity/transfer → ownership and active descriptor clearing → PacketSender.sendSoundEffect → encodeSound. Duplicate queued clicks cannot transfer or sound again because the active-follower identity is cleared. Refusals return before the sound.
- Native Probita Check → Recovery.open/PIN service → interface148, native dynamic row selection/Confirm → fresh live family/possession/capacity checks → actual item add → getPetDisplayName using the returned physical item's ItemDefinition → persistence:save. No recovery cost or ownership rules change.
- Real skilling success event → existing chance/family award logic → cached display helper → World broadcast. Existing duplicate-family suppression is unchanged.

Sound and display text add no delayed tasks or persistent data. Tests exercise real Bank deposit/withdraw and PlayerSave/fresh login so the sound/name change does not conceal item/follower duplication. Cache names are used when nonblank and not `null`; prior enum formatting remains the unavailable-definition fallback. Shared-item morphs deliberately use the physical item's name, not an invented enum-derived form name.

## Verification

TypeScript build passed. New real native regression suite:6/6; before the change5 fail and1 unchanged squirrel-name case passes. Existing pet/follower/recovery foundations with the new suite:61/61. Network capture is the only stubbed transport; real Player, NPC, Inventory, Bank, ClientConnection, startup hooks and PlayerSave are used. New cases cover exact encoded sound/loop/delay, duplicate pickup/confirm, full inventory, last slot, foreign ownership, actual bank transfer, fresh login, Lil' Zik, Giant Squirrel and Pet kraken names.

Independent Codex review:41/41 feature/foundation/reviewer checks, no findings in inspected paths and no hook errors. The reviewer independently decoded the native pickup packet with the real client decoder, proved ordinary shared PICK_UP_ITEM remains delay0, and exercised real agility and runecrafting pet-award hooks with controlled RNG. The latter verifies cached `Rift guardian` rather than enum-derived `Air Rift Guardian`, alongside duplicate broadcast suppression. Reviewer scratch SHA256:991C92F703B736B03E68CE73E980632AB9D6373BD11E09F928F3EA96B8E3B87E.

Reviewed source at basefaf4f9883 plus tracked diff: Pets.plugin.js SHA256 C8C3AB538F48F9E3CAEBE1412660C24EC02641C4488AF8071B187E72768941D8; new test SHA256 DCDC6C2C90F6D699BD73441A1B3DA9D0F432486CA7307444923921923F1EB8BF.

Rendering client on own isolated slot7: disposable account's pet ownership was established by native Drop/Pick-up, then admin clearinv seeded its lost state. After a fresh browser login and welcome dismissal, native Probita Check opened recovery; browser row selection and Confirm awarded exactly one22473 and visibly printed `Probita returns your Lil' Zik.` Native inventory Drop and NPC Pick-up returned one22473 with follower varps cleared. Screenshots and post-action state retained locally. Seeding the lost state is not evidence of combat-death loss. No client code changes.

Own server/client/browser stopped after QA;3107/43707/49807 closed and own slot7 reservation cleared. Claude's worktrees and live game untouched. Full-suite result is recorded in the PR after completion; a first sandbox-restricted attempt was discarded because temp-file rename and localhost tests could not execute correctly, then rerun with required access.

The unrelated AdventurePaths fixture emits Hunter/WarpedSceptre null-core login-hook errors despite passing: it loads plugins but never emits server startup, which initializes those modules. The independent reviewer reproduced the same selected native-login test with exact-base faf4f9883 Pets source loaded in memory (base source SHA25603BC3971525D872B826508DD8EDDFAE95A18A0FE9423337325FF390BD640CAE0):1/1 passes with the same errors. Critical pet suites do emit startup and have no hook errors. Baseline loader SHA25649BF1A6F09BDF4A794E1DDBB2AFF5BAF8A85C124AD99641FE70B6BEAB3ED44A5. This is disclosed rather than changed in a pet interaction PR.

Final full suite: node --test --test-concurrency=4 tests/,9193/9193, no failures/skips/cancellations, exit0. Reviewed product/test hashes remained unchanged throughout the final run.
