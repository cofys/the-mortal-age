# Probita native recovery screen

Verified against main2c8cf71af and cache241, 27 October2026. This addresses the Pets
tracker Storage & reclamation note that Probita returns items without opening her interface.

## Sources

- [Probita Wiki](https://oldschool.runescape.wiki/w/Probita): one-off pets are automatically
  insured, reclaims are free since10September2025, cats/dogs excluded.
- Local reference pinned6e5033af: `pet_insurance`148, init6126; enum985 gives72 pet indices,
  enum169 gives Bank1/Inventory2/Follower3/Menagerie4. Native row children6+5*index; the held
  list starts366 if there are reclaimable rows. Confirm is148:37 child0; selected varbit13980
  is index+1. Three31-bit ownership/possession masks and nine4-bit location packs drive CS2.
- Confirmed against shipped cache in native tests and client VM. All reclaimable plugin
  families have a matching enum985 entry; no arbitrary pet or variant mapping was invented.
- Local RSProx facts for `pet_insurance_broker` find no player actions. Dialogue is existing
  generated source, not transcribed or invented here. No recording claim for packet timing.

## Behaviour

- Talk-to → lost-pet dialogue and Check both open the native screen. The dialogue route
  waits one player-keyed tick after its terminal close; this sequencing choice is verified
  natively, not asserted as an OSRS capture timing.
- Select a reclaimable row, then Confirm. Reclaim one pet for free, preserving its recorded
  item variant. Display held pet locations; Examine reads the item's cache description.
- Use canonical `pets.owned` and family definitions. Check every same-family item in follower,
  inventory, real bank tabs and existing external-storage hooks before reclaiming. A recolour
  elsewhere cannot authorize a duplicate of the stored colour.
- PIN checks protect opening and confirmation. Resume binds the same registered nearby
  Probita, player origin/plane/private area and selected family, then rechecks live ownership,
  possession and capacity. Closed/logout/dead/moved/detached input cannot reclaim.
- Full inventory retains the selection and ownership for retry. Double confirmation gives
  no extra pet. Empty and cat-only accounts see an empty screen; no fee or new saved state.

## Verification

- 15 new native-input real-object tests load shipped cache/maps/all plugins and startup hooks;
  real Player/session/Inventory/NPC/packet/dialogue-count/TaskManager and Bank PIN service.
  Network messages/scripts are captured. Covers selection/Confirm, Check, forged clicks,
  full/last slot, family-held colour, colour-preserving reclaim, stale/dead inputs, location
  packs, Examine, real initial PIN and confirmation-time PIN, and stale PIN resumes.
- Focused recovery/Pets/Bank PIN tests74/74; TypeScript build passes. Final full suite
 9,120/9,120, no failures/skips (413 seconds), concurrency4. Git diff whitespace check clear.
- Main integration10c75c689 retains merged Chompy acquisition alongside Recovery. Combined
  recovery/Pets/Bank PIN/Chompy focused85/85 and full9,131/9,131 pass with no skips
  (687 seconds, concurrency2); independent integration review clear. Production code unchanged
  after that run. Own slot2 reservation was backed up and cleared after native shutdown.
- Independent Codex review found a real confirmation-time PIN resume issue: keypad closure
  removed the old modal session. Reproduced, fixed with a pending identity-bound reopen,
  and covered through native PIN submission. Final source/delta re-reviews clear.
- Isolated slot2 native QA: prepared only two lost-pet ownership records in a disposable
  SQLite profile. Actual Probita Talk-to → lost-pet → Let's have a look opened148. Hellpuppy
  selection sent13980=23; Confirm returned one pet and held mask4194304. Repeat gave none.
  Actual Check then opened the screen; Squirrel selection13980=30/Confirm returned it and
  held mask541065216. Relog retained ownership and held mask; selection reset0.
- Client VM executing actual init6126: no errors,726 dynamic children, native Reclaim and
  Location rows plus correct Hellpuppy/Giant Squirrel/Bank text. This is a CS2/widget check,
  not a browser screenshot or visual-layout certification.
- Own server stopped via gameUpdate3s and player persistence completed. No live deployment,
  Claude source changes, generated-file edits or new gameplay commands.
