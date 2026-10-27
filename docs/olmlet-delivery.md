# Olmlet reward delivery

## Expected behaviour and sources

- [Olmlet](https://oldschool.runescape.wiki/w/Olmlet): 1/53 conditional on a unique; follower if none, backpack with another follower, Probita when both follower and backpack are occupied.
- [Ancient chest](https://oldschool.runescape.wiki/w/Ancient_chest): rewards after Olm dies; unclaimed regular loot is placed on the ground on leaving.
- Local `rsprox_index.py find olmpet`: no recording. No exact pet award tick is claimed from recordings. First-search delivery, and the leave/logout safety fallback, have no direct recording here.
- Pinned dump `6e5033af6215963581a51b348f452320ff18f0f6`, rev241: obj `olmpet`20851; npc `raids_olm_pet`7520 versus house7519; loc `raids_reward_crystal`30027/`raids_reward_chest`30028; interface `raids_rewards`539 (items5, bank6, inventory8, discard10).

## Production path and state ownership

- Olm room `defeated` → actual `Raid.complete` → completion hooks → `Rewards.completed/generate`: retains the existing points/unique-conditioned pet roll. Fix duration before setting `completed`, since `ticksSinceStart` returns stored duration for a completed raid; the reversed order produced undefined duration and unsaveable best-times.
- Native object packet → `ObjectActionPacketListener`/walk-to → Ancient chest Search → `Rewards.openChest` → `claimPetLoot` → public `npc-drops:roll` → `Pets.awardDroppedPets/awardPet`.
- `Pets.recordOwnership` owns family insurance (`pets.owned`), persistence event and collection log. `Pets.drop` owns real follower creation, registration, area and client follower index; occupied/full handling remains centralized.
- Native reward widget packets → reward buttons/`takeItem` use the same helper, retaining ordinary transfer and disabled-Pets fallback. A synchronous save hook may change the reward array: remove the exact consumed entry only if it still exists, never a cached slot that now holds normal loot.
- Actual private-area exit/logout → `Raid.playerLeftArea/removePlayer` → leave hooks → `unclaimedLoot`: deliver pet before ordinary ground fallback, including before logout discards a transient raid. `Player.onLogout` leaves its area before emitting Pets logout hooks; earned follower can therefore use the existing logout/save/login restoration.
- No new persisted raid/reward store, drop roll, client/interface, combat, area policy or generic pet semantics.

## Verification design

- Real cache, plugin startup/shutdown hooks, Player/Inventory/Bank/ClientConnection and Raid; seeded earned points, controlled RNG and clock. Native temporary chest in an open part of the actual cache chamber avoids overlapping the pre-existing reward crystal in the unit fixture.
- Assert first search follower7520/owner/log, occupied follower backpack, full+follower insurance, full without follower, ordinary Bank-all, repeated search, another member, no-unique refusal, leave/logout and actual Bank deposit/withdraw plus PlayerSave/fresh login.
- Independent review additionally runs actual private-map construction/admission, mapped chest input and public raid leave from a synchronous ownership-save listener, plus map logout/save/fresh follower login. Reviewer reproductions retain the old-helper RED and corrected GREEN results.
- A seeded completion is a reward-delivery fixture, not a completed combat playthrough. Exact OSRS award timing and complete CoX reward RNG parity remain outside this fix's verified evidence.

## Results

- Build passed; new tests9/9; full suite9,126/9,126; independent adversarial2/2 and underlying Pets/CoX53/53.
- Actual private-map QA chest at8209,1711 is searchable from its west side8208,1711; its south side is blocked by the map. Native Search sent varbit5457=1/interface539 and delivered follower7520/collection-log item20851. This clarifies why the unit temporary chest uses open floor.
- Real browser at the isolated client: login restored follower7520 once; actual right-click Ancient chest→Search, Bank-all, Close, pet→Pick-up and inventory→Drop rendered and updated correctly. A second seeded completion verified the already-owned refusal without a second pet. Local screenshots record the picked-up item and restored follower; QA helper removed after loading and excluded from the commit. No combat completion is claimed.
- Independent reviewer reproduced logout loss and nested-save slot loss against the earlier helper in scratch-only reconstruction, then verified corrected real map/chest/leave/save/login paths. Exact reviewed basec3ec5985d; production-diff SHA256811E480D347BA6906773ACDC1F9A9362E809CAA221D189782835A75284C4C6E6; author-test SHA2563271F2CF7B169DEB9313F889C6F22EBF8DC6AA92A9337D68B78DB79B0AF0D224.
