# Theatre of Blood pet delivery

Normal-mode Lil' Zik already rolled in the raid's reward table, but was treated as an
ordinary chest item. Opening/claiming it did not call Pets' ownership, collection-log,
follower or insurance service. This repairs delivery; RNG/rates/combat are unchanged.

## Evidence

- [Wiki: Lil' zik](https://oldschool.runescape.wiki/w/Lil%27_zik) describes receipt when
  looting the monumental chests, normal follower/backpack delivery, and Probita recovery
  when both the backpack and follower slot are occupied.
- Local osrs-dumps6e5033af, revision241, matched against the active cache: itemverzikpet22473;
  normal followerverzik_pet8337, POHpoh_verzik_pet8336. Existing named LIL_ZIK_2 is8337.
  The canonical Pets row previously used the POH variant and is corrected here.
- Cache native reward paneltob_chests23 has Bank6/Inventory8/Discard10/Items12. Treasury
  closed/open objects33086/32994; outside reward root41437 displays41435 when loot waits.
- Local RSProx index has no olmpet/verzikpet recordings/actions. No recorded tick/animation,
  current rate-statistics or combat fidelity claim is made for this change.

## Production paths and shared state

- Native object input → ObjectActionPacketListener.executeAction → Shared.onObject →
  RewardsRoom.openChest owner/slot check → claimPetLoot → npc-drops:roll →
  Pets.awardDroppedPets/awardPet → recordOwnership/save, collection log and delivery.
- Receipt is synchronous after the valid owner-chest open, before its existing deferred
  animation/UI. Outside saved-reward open and item/Bank-all transfer paths also route pending
  pet entries through this service. Consumed entries leave persisted tob:loot; when Pets
  is unavailable the ordinary item fallback remains. Non-pet reward transfer stays unchanged.
- Reviewed unchanged foundations: Pets' earned-reward area bypass, duplicate/full-bag policy,
  raid disposal, MovementQueue pet private-area following, native pickup, Bank transfers and
  PlayerSave from/apply. No new raid-area override or one-off pet-award code in core.

## Checks

- Eight new tests use real Party/Raid/PrivateArea/RewardsRoom and shipped cache/maps, all
  plugins/startup, real Player/session/Inventory/Bank/PlayerSave and queued native inputs.
  Controlled RNG produces an existing pet roll. Covers owner/foreign chests, follower or
  backpack delivery, full bag with/without follower, ordinary Bank-all, actual deposit/
  withdraw, repeated claims and fresh login from a snapshot taken at the ownership-save
  boundary while pet loot was still pending. No synthetic replacement-container setup.
- Original six delivery tests failed on baseline; the cache-correct follower assertion also
  failed8336vs8337 before its row correction. Final focused delivery/Theatre/Pets72/72 pass.
- Independent reviewer traced unchanged systems and chose an additional scenario: receipt →
  real raid leave/disposal → actual follow/private-area update → native Pick-up → real Bank
  deposit → save/fresh-player login → native outside reward reopening. Passed1/1 with one
  banked pet and no inventory/follower/chest duplicate. Underlying Pets/Theatre64/64 also pass.
  Initial scratch harness omissions (follow processing, nullable bank tabs) were corrected
  through actual APIs; no gameplay change was needed for them.
- Exact review build: HEADb93e1af6e987e832358b6cd53609f612f23ff2a1; `node node_modules/typescript/bin/tsc --build`.
  Tracked production diff SHA2564AF0734080692F36F8ADC5C5A94E8C8849D73C5D7167B322B47CE067079AA122;
  new-test SHA256E2A369E1ADDD15956F35E7380033A4226239B00678FE76CED817D692AE31F2DA.
  Reviewer scratch SHA256F008FCF3C67DBBEC1AF3172531598E276E68D5D4E29850DF5D550E57A573E189.
- Native isolated slot2 QA used a prepared pending pet+1200coins in one disposable SQLite
  profile. The real Ver Sinhaza Rewards Chest3650,3217 opened23, spawned follower8337 and
  logged the pet. Bank-all moved only the coins; native Pick-up and a real bank booth then
  deposited the one pet. Logout/login retained exactly1200coins and oneLil'Zik in the bank.
  No native rare roll or live combat was forced/claimed; normal vault generation is covered
  in the real-object tests. No client-rendering changes or browser screenshot claim.

Full suite9,125/9,125 passes without failures/skips (468 seconds, concurrency4). The
native server saved/stopped and ports3102/43702/49802 closed; slot2 is backed up and cleared.
No live-game,
Claude, clue, League, raid-combat or generated-data changes. Olmlet delivery and Lil' Zik's
dust/metamorphosis support remain separate work; this does not complete the Pets category.
