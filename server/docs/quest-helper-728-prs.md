# Quest Helper issue 728: independent PR index

**Opening a PR is not completing a quest.** This split contains 103 quest PRs and
five shared-code, regression and documentation PRs. The owner authorized a merge batch
for all 108; the per-quest PR links below show live publication state. The accepted
natural main-route count at this checkpoint is **26/106 active quests (24.53%)**;
22 long quests remain deferred. No full branch, recovery or Java overlay parity is implied.

The split supersedes [PR753](https://github.com/RSPSApp/tsps/pull/753). Existing
committed changes are preserved; unpublished quest/dumper work remains in the original
worktree. Test accounts, saves and raw evidence were not reset.

## Merge status

All 108 original split PRs have merged, including the three shared foundation PRs.
Their links below preserve scope and review history. Merged code is not proof that
all branches have passed natural verification; use the evidence column and docs/quests.
Further fixes target current `main` in new quest/shared follow-up PRs. Do not push
new work to the closed split PRs or superseded PR753.

## Evidence and ongoing verification

Use the per-quest pages in [docs/quests](../../docs/quests/README.md),
[the coverage overview](quest-helper-728-coverage.md), and
[quest review process](agents/quest-testing.md). Resume saved checkpoints and test changed
steps rather than replaying completed routes. Record the exact candidate source/runtime
hash and preserve per-quest raw evidence outside Git. A PR split does not invalidate a
saved quest state; a behavior change requires a focused delta check.

The earlier split checkpoint passed **1,405/1,412** automated checks. Its seven Another
Slice of H.A.M. failures are repaired in [#1192](https://github.com/RSPSApp/tsps/pull/1192):
13 focused checks and 58 combined adjacent checks pass. The runtime repair preserves
item transfers and restores the tunnel encounter; its native stage-9 checkpoint reached
stage 10 and survived relog, without establishing a fresh complete quest route.

The batch also repairs valid item-0 pickup/capacity, widget-test syntax, Temple of the
Eye registration, Dragon Slayer II's cache completion threshold and Veldaban ownership.
The repaired pre-concurrent-merge snapshot based on
`5a184baa6d7699c603c82c80cc11168eacaaf957` passes the full server suite:
**7,453/7,453 checks in 583 files, zero skips**. The full client suite on that base passes
**260 files, zero failures/skips**, with typecheck and production build also passing.

Concurrent main changes were checked separately on merged commit
`833e05ec9bec9a73dde44c5d7398debdbd67097b` (tree
`4c538771c21567b5af729761166305ff63ad83ad`): server build and **713/713 checks in
17 affected/transport/quest files** pass; **26 connected client test files**, including
both new report-abuse/CS2 trigger-op tests, pass alongside fresh client typecheck and
production build. These latest-main checks have zero failures/skips; they are delta
checks, not a rerun of either full suite on that later commit. Evidence is retained in
`/tmp/quests-oct25/combined-server-final-status.json`, `combined-client-status.json`,
`latest-main-merge-server-status.json` and `latest-main-client-status.json`.
These results do not validate every split branch in isolation or add natural-route
coverage. Generated dialogue/index blobs were preserved, never hand edited.

Verification was paused with all actors offline. Horror from the Deep is preserved at
stage 1 on its existing account; Murder Mystery is completed/offline with its Anna-route evidence independently accepted. Completed q090/q084 routes remain recorded.

After this split, put further quest fixes in that quest's PR and shared fixes in their
own support PR. Preserve newer main changes when moving a fix from the integration
worktree; never replace a branch's whole source file with an older working-tree copy.
Update this index and the quest's docs/quests page as evidence is accepted; do not infer
percentages from PR counts or source-only tests.

## PRs and verification status

| PR | Quest or support | Verification status |
| --- | --- | --- |
| [#1086](https://github.com/RSPSApp/tsps/pull/1086) | Preserve quest item, widget, actor and spell API contracts | Shared support / evidence; not a completed quest |
| [#1087](https://github.com/RSPSApp/tsps/pull/1087) | Import canonical quest dialogues and repair shared dispatch | Shared support / evidence; not a completed quest |
| [#1088](https://github.com/RSPSApp/tsps/pull/1088) | Repair shared quest doors, Entrana admission and world services | Shared support / evidence; not a completed quest |
| [#1089](https://github.com/RSPSApp/tsps/pull/1089) | A Kingdom Divided | Shared appearance fix only; full implementation unpublished |
| [#1090](https://github.com/RSPSApp/tsps/pull/1090) | ANight At The Theatre | Deferred quest; existing committed work preserved |
| [#1091](https://github.com/RSPSApp/tsps/pull/1091) | A Ruff Situation | Scoped main-route evidence recorded; paid-fur branch verified separately under epoch27 |
| [#1092](https://github.com/RSPSApp/tsps/pull/1092) | Animal Magnetism | Pending natural verification |
| [#1093](https://github.com/RSPSApp/tsps/pull/1093) | The Ascent of Arceuus | Scoped main-route evidence recorded; full parity pending |
| [#1094](https://github.com/RSPSApp/tsps/pull/1094) | At First Light | Pending natural verification |
| [#1095](https://github.com/RSPSApp/tsps/pull/1095) | Below Ice Mountain | Pending natural verification |
| [#1096](https://github.com/RSPSApp/tsps/pull/1096) | Beneath Cursed Sands | Pending natural verification |
| [#1097](https://github.com/RSPSApp/tsps/pull/1097) | Big Chompy Bird Hunting | Scoped main-route evidence recorded; full parity pending |
| [#1098](https://github.com/RSPSApp/tsps/pull/1098) | Biohazard | Pending natural verification |
| [#1099](https://github.com/RSPSApp/tsps/pull/1099) | Bone Voyage | Scoped main-route evidence recorded; full parity pending |
| [#1100](https://github.com/RSPSApp/tsps/pull/1100) | Cabin Fever | Pending natural verification |
| [#1101](https://github.com/RSPSApp/tsps/pull/1101) | Client of Kourend | Scoped main-route evidence recorded; full parity pending |
| [#1102](https://github.com/RSPSApp/tsps/pull/1102) | Clock Tower | Scoped main-route evidence recorded; full parity pending |
| [#1103](https://github.com/RSPSApp/tsps/pull/1103) | Contact! | Pending natural verification |
| [#1104](https://github.com/RSPSApp/tsps/pull/1104) | Current Affairs | Pending natural verification |
| [#1105](https://github.com/RSPSApp/tsps/pull/1105) | Darkness of Hallowvale | Deferred quest; existing committed work preserved |
| [#1106](https://github.com/RSPSApp/tsps/pull/1106) | Death on the Isle | Pending natural verification |
| [#1107](https://github.com/RSPSApp/tsps/pull/1107) | Death Plateau | Scoped main-route evidence recorded; full parity pending |
| [#1108](https://github.com/RSPSApp/tsps/pull/1108) | Death to the Dorgeshuun | Pending natural verification |
| [#1109](https://github.com/RSPSApp/tsps/pull/1109) | The Depths of Despair | Scoped main-route evidence recorded; full parity pending |
| [#1110](https://github.com/RSPSApp/tsps/pull/1110) | Desert Treasure I | Deferred quest; existing committed work preserved |
| [#1111](https://github.com/RSPSApp/tsps/pull/1111) | Devious Minds | Pending natural verification |
| [#1112](https://github.com/RSPSApp/tsps/pull/1112) | Dragon Slayer I | Pending natural verification |
| [#1113](https://github.com/RSPSApp/tsps/pull/1113) | Druidic Ritual | Completion used an alternate dungeon entrance; intended prison-gate failure and follow-up recorded in [#1080](https://github.com/RSPSApp/tsps/issues/1080) and the verification ledger. Full parity pending. |
| [#1114](https://github.com/RSPSApp/tsps/pull/1114) | Dwarf Cannon | Pending natural verification |
| [#1115](https://github.com/RSPSApp/tsps/pull/1115) | Eadgar's Ruse | Pending natural verification |
| [#1116](https://github.com/RSPSApp/tsps/pull/1116) | Elemental Workshop I | Scoped main-route evidence recorded; full parity pending |
| [#1117](https://github.com/RSPSApp/tsps/pull/1117) | Elemental Workshop II | Pending natural verification |
| [#1118](https://github.com/RSPSApp/tsps/pull/1118) | Enakhra's Lament | Pending natural verification |
| [#1119](https://github.com/RSPSApp/tsps/pull/1119) | Ethically Acquired Antiquities | Pending natural verification |
| [#1120](https://github.com/RSPSApp/tsps/pull/1120) | Fairytale II - Cure a Queen | Pending natural verification |
| [#1121](https://github.com/RSPSApp/tsps/pull/1121) | Fight Arena | Scoped main-route evidence recorded; full parity pending |
| [#1122](https://github.com/RSPSApp/tsps/pull/1122) | Fishing Contest | Scoped main-route evidence recorded; full parity pending |
| [#1123](https://github.com/RSPSApp/tsps/pull/1123) | Garden of Tranquillity | Pending natural verification |
| [#1124](https://github.com/RSPSApp/tsps/pull/1124) | Gertrude's Cat | Scoped main-route evidence recorded; full parity pending |
| [#1125](https://github.com/RSPSApp/tsps/pull/1125) | Getting Ahead | Pending natural verification |
| [#1126](https://github.com/RSPSApp/tsps/pull/1126) | The Grand Tree | Pending natural verification |
| [#1127](https://github.com/RSPSApp/tsps/pull/1127) | The Great Brain Robbery | Pending natural verification |
| [#1128](https://github.com/RSPSApp/tsps/pull/1128) | Grim Tales | Pending natural verification |
| [#1129](https://github.com/RSPSApp/tsps/pull/1129) | The Hand in the Sand | Pending natural verification |
| [#1130](https://github.com/RSPSApp/tsps/pull/1130) | Hazeel Cult | Scoped main-route evidence recorded; full parity pending |
| [#1131](https://github.com/RSPSApp/tsps/pull/1131) | His Faithful Servants | Pending natural verification |
| [#1132](https://github.com/RSPSApp/tsps/pull/1132) | Horror from the Deep | Pending natural verification |
| [#1133](https://github.com/RSPSApp/tsps/pull/1133) | In Aid of the Myreque | Pending natural verification |
| [#1134](https://github.com/RSPSApp/tsps/pull/1134) | In Search of the Myreque | Pending natural verification |
| [#1135](https://github.com/RSPSApp/tsps/pull/1135) | Jungle Potion | Scoped main-route evidence recorded; full parity pending |
| [#1136](https://github.com/RSPSApp/tsps/pull/1136) | King's Ransom | Shared guard fix only; full implementation unpublished |
| [#1137](https://github.com/RSPSApp/tsps/pull/1137) | Learning the Ropes | Pending natural verification |
| [#1138](https://github.com/RSPSApp/tsps/pull/1138) | Lost City | Scoped main-route evidence recorded; full parity pending |
| [#1139](https://github.com/RSPSApp/tsps/pull/1139) | Making History | Pending natural verification |
| [#1140](https://github.com/RSPSApp/tsps/pull/1140) | Meat and Greet | Scoped main-route evidence recorded; full parity pending |
| [#1141](https://github.com/RSPSApp/tsps/pull/1141) | Merlin's Crystal | Pending natural verification |
| [#1142](https://github.com/RSPSApp/tsps/pull/1142) | Monkey Madness I | Deferred quest; existing committed work preserved |
| [#1143](https://github.com/RSPSApp/tsps/pull/1143) | Monkey Madness II | Deferred quest; existing committed work preserved |
| [#1144](https://github.com/RSPSApp/tsps/pull/1144) | Monk's Friend | Scoped main-route evidence recorded; full parity pending |
| [#1145](https://github.com/RSPSApp/tsps/pull/1145) | Mourning's End Part I | Deferred quest; existing committed work preserved |
| [#1146](https://github.com/RSPSApp/tsps/pull/1146) | Murder Mystery | Scoped Anna main-route evidence recorded; full parity pending |
| [#1147](https://github.com/RSPSApp/tsps/pull/1147) | Nature Spirit | Pending natural verification |
| [#1148](https://github.com/RSPSApp/tsps/pull/1148) | Observatory Quest | Scoped main-route evidence recorded; full parity pending |
| [#1149](https://github.com/RSPSApp/tsps/pull/1149) | Olaf's Quest | Scoped main-route evidence recorded; full parity pending |
| [#1150](https://github.com/RSPSApp/tsps/pull/1150) | The Path of Glouphrie | Pending natural verification |
| [#1151](https://github.com/RSPSApp/tsps/pull/1151) | A Porcine of Interest | Scoped main-route evidence recorded; full parity pending |
| [#1152](https://github.com/RSPSApp/tsps/pull/1152) | Prince Ali Rescue | Pending natural verification |
| [#1153](https://github.com/RSPSApp/tsps/pull/1153) | Prying Times | Pending natural verification |
| [#1154](https://github.com/RSPSApp/tsps/pull/1154) | The Queen of Thieves | Scoped main-route evidence recorded; full parity pending |
| [#1155](https://github.com/RSPSApp/tsps/pull/1155) | Rag and Bone Man I | Pending natural verification |
| [#1156](https://github.com/RSPSApp/tsps/pull/1156) | Rag and Bone Man II | Deferred quest; existing committed work preserved |
| [#1157](https://github.com/RSPSApp/tsps/pull/1157) | Ratcatchers | Deferred quest; existing committed work preserved |
| [#1158](https://github.com/RSPSApp/tsps/pull/1158) | Recipe for Disaster | Deferred quest; existing committed work preserved |
| [#1159](https://github.com/RSPSApp/tsps/pull/1159) | The Ribbiting Tale of a Lily Pad Labour Dispute | Pending natural verification |
| [#1160](https://github.com/RSPSApp/tsps/pull/1160) | Roving Elves | Pending natural verification |
| [#1161](https://github.com/RSPSApp/tsps/pull/1161) | Rum Deal | Pending natural verification |
| [#1162](https://github.com/RSPSApp/tsps/pull/1162) | Scorpion Catcher | Pending natural verification |
| [#1163](https://github.com/RSPSApp/tsps/pull/1163) | Sea Slug | Pending natural verification |
| [#1164](https://github.com/RSPSApp/tsps/pull/1164) | Secrets of the North | Pending natural verification |
| [#1165](https://github.com/RSPSApp/tsps/pull/1165) | Sheep Herder | Pending natural verification |
| [#1166](https://github.com/RSPSApp/tsps/pull/1166) | Sins of the Father | Pending natural verification |
| [#1167](https://github.com/RSPSApp/tsps/pull/1167) | Sleeping Giants | Scoped main-route evidence recorded; full parity pending |
| [#1168](https://github.com/RSPSApp/tsps/pull/1168) | The Slug Menace | Pending natural verification |
| [#1169](https://github.com/RSPSApp/tsps/pull/1169) | Song Of The Elves | Deferred quest; existing committed work preserved |
| [#1170](https://github.com/RSPSApp/tsps/pull/1170) | Spirits of the Elid | Pending natural verification |
| [#1171](https://github.com/RSPSApp/tsps/pull/1171) | A Tail of Two Cats | Pending natural verification |
| [#1172](https://github.com/RSPSApp/tsps/pull/1172) | Tale of the Righteous | Pending natural verification |
| [#1173](https://github.com/RSPSApp/tsps/pull/1173) | A Taste of Hope | Pending natural verification |
| [#1174](https://github.com/RSPSApp/tsps/pull/1174) | Tears of Guthix | Pending natural verification |
| [#1175](https://github.com/RSPSApp/tsps/pull/1175) | Temple of the Eye | Pending natural verification |
| [#1176](https://github.com/RSPSApp/tsps/pull/1176) | The Blood Moon Rises | Pending natural verification |
| [#1177](https://github.com/RSPSApp/tsps/pull/1177) | The Feud | Pending natural verification |
| [#1178](https://github.com/RSPSApp/tsps/pull/1178) | The Final Dawn | Pending natural verification |
| [#1179](https://github.com/RSPSApp/tsps/pull/1179) | The Heart of Darkness | Pending natural verification |
| [#1180](https://github.com/RSPSApp/tsps/pull/1180) | The Tourist Trap | Pending natural verification |
| [#1181](https://github.com/RSPSApp/tsps/pull/1181) | Tower of Life | Pending natural verification |
| [#1182](https://github.com/RSPSApp/tsps/pull/1182) | Tree Gnome Village | Scoped main-route evidence recorded; full parity pending |
| [#1183](https://github.com/RSPSApp/tsps/pull/1183) | Tribal Totem | Pending natural verification |
| [#1184](https://github.com/RSPSApp/tsps/pull/1184) | Troll Stronghold | Pending natural verification |
| [#1185](https://github.com/RSPSApp/tsps/pull/1185) | Twilight's Promise | Pending natural verification |
| [#1186](https://github.com/RSPSApp/tsps/pull/1186) | Wanted! | Pending natural verification |
| [#1187](https://github.com/RSPSApp/tsps/pull/1187) | Waterfall Quest | Pending natural verification |
| [#1188](https://github.com/RSPSApp/tsps/pull/1188) | What Lies Below | Pending natural verification |
| [#1189](https://github.com/RSPSApp/tsps/pull/1189) | While Guthix Sleeps | Deferred quest; existing committed work preserved |
| [#1190](https://github.com/RSPSApp/tsps/pull/1190) | Witch's House | Pending natural verification |
| [#1191](https://github.com/RSPSApp/tsps/pull/1191) | Zogre Flesh Eaters | Pending natural verification |
| [#1192](https://github.com/RSPSApp/tsps/pull/1192) | Preserve cross-quest dialogue and ownership regressions | Shared support / evidence; not a completed quest |
| [#1193](https://github.com/RSPSApp/tsps/pull/1193) | Document quest review evidence and independent PR tracking | Shared support / evidence; not a completed quest |

## Follow-up fixes

- [tribal-totem-lock #1237](https://github.com/RSPSApp/tsps/pull/1237) — merged after source review and a bounded native checkpoint: wrong/correct combination, ordinary crossing and persisted unlock after relog. No full natural route is claimed.
- [baraek-fur-sale #1238](https://github.com/RSPSApp/tsps/pull/1238) — open, ready for review. The epoch27 completed-account 20-coin purchase delta is verified; no additional quest completion is counted.
- [making-history-progress #1239](https://github.com/RSPSApp/tsps/pull/1239) — merged after source review, actual transcript-runner checks and bounded native payment/cancel/full-bag/banked-key/relog checks. Full natural main-route completion remains pending.
- [horror-lighthouse-entry #1242](https://github.com/RSPSApp/tsps/pull/1242) — merged after source review and a bounded native checkpoint of the key/bridge gates, bridge crossings, lighthouse entry/exit and repeat access after relog. Full natural quest completion remains pending.
- [dwarf-cannon-helper-recovery #1246](https://github.com/RSPSApp/tsps/pull/1246) — merged after source review and bounded native helper replay, legacy saved-stage repair, completed Nulodion purchase and relog checks. This is not a full natural route or current-source quest-reward proof.- [tourist-trap-shared-object-owners #1250](https://github.com/RSPSApp/tsps/pull/1250) — draft; live delta verification pending.

## Community-tested replay exclusions

Follow the user-approved community completion exclusions (`tester: community` in [docs/quests](../../docs/quests/README.md)) from issue #1257 before starting any new manual actor. The 21 listed completions skip full replay; caveats and targeted bug checks remain. None overlaps the original 106 active jobs.
