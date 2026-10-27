# Pets progress audit

27 October 2026; checked against main2c8cf71af. The rendered progress page loads its tracker from
[osrs-progress.json](https://rsps.app/assets/extensions/rsps-world-auth/osrs-progress.json).
Its historical notes need comparison with current sources before implementation.

## Verified existing sources

The generated `npc-drops.json` has these pet rows in `tertiary`: Nexling26348 (`nex`,1/500),
Muphin27590 (`phantom_muspah`,1/2500), Kalphite princess12647 (`kalphite_queen`,1/3000),
Vorki21992 (`vorkath`,1/3000), Scurry28801 (`scurrius`,1/3000) and TzRek-Jad13225
(`tz_tok_jad`,1/200; Fight Caves separately adjusts Slayer-task odds). Their older
missing-source notes do not justify adding duplicate rolls. These are source-presence
checks, not a fresh encounter-by-encounter probability certification.

Olmlet has its 1/53 unique-reward roll in `minigames/cox/Rewards.ChambersOfXeric.js`;
Lil' zik has a standing-weighted roll in `minigames/tob/Rewards.TheatreOfBlood.js`;
Tumeken's guardian uses the raid pet-winner and shared pet award event in
`minigames/toa/Loot.TombsOfAmascut.js`; Jal-Nib-Rek uses the completion award in
`minigames/inferno/Run.Inferno.js`. Absence from NPC drop JSON is expected for scripted
sources. Chest delivery, ownership and exact rate modifiers need their own audit.

## Verified change in this branch

Chompy chick already has a generated1/500 entry, but the award gate used a never-set
diary flag and plucking did not request its roll. See `chompy-pet-acquisition.md`.

## Remaining work and ownership

- Bloodhound's master-clue source needs checking with the clue owner. Claude owns Treasure
  Trails; this branch makes no clue changes. Coordination handoff posted locally.
- Penance queen/princess acquisition needs Barbarian Assault, which is absent from this
  baseline. Adding an unconditional pet award would not implement the missing activity.
- Probita already reclaims recorded missing pets freely. The current
  [Probita Wiki page](https://oldschool.runescape.wiki/w/Probita) dates free reclaim to
  10 September2025. Do not add the obsolete one-million-coin fee. A native recovery screen
  is a separate interface gap, rather than a reason to change the current price.
- Followers already have teleport/plane catch-up; obstacle/door pathing remains a separate
  investigation. Generic pet interaction transcript gaps require canonical dialogue data.
- Existing skilling and metamorphosis tracker tasks are marked done. That status is not a
  claim that every individual variant or acquisition path has been retested here.

This audit does not mark the entire Pets category complete.
