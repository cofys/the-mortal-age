# Community completion reports: manual testing exclusions

The user accepted [issue #1257](https://github.com/RSPSApp/tsps/issues/1257), reported
by **thehardcorenoobs1234**, as a reason to skip repeat full manual playthroughs of
its listed quests. This snapshot contains **21 quests**, from the issue revision
updated 2026-10-25T20:22:05Z. The report describes completion on one account/run,
with the limitations below; it is not a claim of complete Quest Helper, recovery,
multiplayer, dialogue, event or cutscene parity.

## Queue rule

- Skip full manual playthroughs for the exact quests listed below. Check this list
  before selecting a fresh actor or replaying a completed prefix.
- Retain the source review and known caveats. Fix reported bugs and use targeted
  regressions or bounded affected-step checks where necessary; do not restart the
  whole quest to reproduce facts already reported here.
- Do not extend this exemption to unlisted quests merely because the issue title
  says F2P. In particular, Imp Catcher and The Knight’s Sword are not in this snapshot.
- Keep community completion evidence separate from independently audited agent
  playthroughs. Do not count these as newly agent-verified or claim full parity.
- [Issue #1204](https://github.com/RSPSApp/tsps/issues/1204), the shared Velrak/key route
  needed for Scorpion Catcher, remains an active bug; Scorpion Catcher is not listed.

## Reported completions and retained caveats

| Quest — skip full manual replay | Reported caveat to retain |
| --- | --- |
| Below Ice Mountain | Training/other scenes can glitch; after the golem, relogging was needed to search the backpack. |
| Black Knights’ Fortress | Scenes can be shortened or glitchy; completion was reported after fixes. |
| Cook’s Assistant | No issue reported. |
| The Corsair Curse | Scene issues, duplicate Captain Tock and incorrect movement of sick NPCs were reported. |
| Demon Slayer | Scenes may be missing, shortened or glitchy. |
| Doric’s Quest | No issue reported. |
| Dragon Slayer I | Some optional dialogue was incomplete or missing; completion was possible. |
| Ernest the Chicken | Completion reported after earlier fixes. |
| Goblin Diplomacy | Scenes were missing; repeated NPC conversations could be needed to progress. |
| The Ides of Milk | Completion reported after earlier fixes. |
| Misthalin Mystery | Scene/table-prop issues and repeat dialogue on defeated villains; leaving the room allowed progress. |
| Pirate’s Treasure | No issue reported. |
| Prince Ali Rescue | Completion reported after earlier fixes. |
| The Restless Ghost | The skull skeleton did not attack in the reported run. |
| Romeo & Juliet | Scenes and optional dialogue were missing; completion was possible. |
| Rune Mysteries | No issue reported. |
| Sheep Shearer | The sheep escape animation was missing in the reported run. |
| Shield of Arrav | Completed with alternate accounts using item-on-player then drop/pickup; trading was unavailable. |
| Vampyre Slayer | The coffin-rise animation appeared missing; the fight was available. |
| Witch’s Potion | No issue reported. |
| X Marks the Spot | Veos’s Kourend demonstration/access remained unavailable after completion. |

## Relation to issue 728

The active issue-728 inventory remains 106 quests, with 22 deferred from the original 128.
Exact canonical-name matching against its preserved job inventory found **0 active
matches** and **0 deferred matches** for this F2P/supplemental list. These
reported quests were outside that original remaining-members inventory. Therefore do
not subtract 21 from 106 or inflate the independently audited main-route count.
The exemption still applies to F2P/supplemental testing and every future candidate queue.
See the [coverage tracker](quest-helper-728-coverage.md),
[agent evidence ledger](quest-helper-728-verification.md) and
[review process](agents/quest-testing.md).
