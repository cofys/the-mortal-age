# Issue 728: Quest Helper quest coverage

Tracks [issue #728](https://github.com/RSPSApp/tsps/issues/728). Follow
[the full quest testing process](agents/quest-testing.md).

Quest Helper is the progression reference, pinned at
`06da90f982518a093f2fe1c9cfac5547fa7053d3` (upstream HEAD verified at kickoff).
Cache: `osrs-241_2026-10-20`. Initial server revision: `be4be8d31d83ded906bd6fd1140a719ba5e45e84`.

This inventory is a backlog, not a claim that every quest is broken. Source comparison,
regression tests, natural MCP completion and visual overlay checks are separate evidence.
No Java Quest Helper overlay is installed here. A natural completion requires the real
mandatory routes, exact reward deltas once, repeat checks, relog, offline persistence,
post-quest behaviour and applicable canonical recovery. Target quest-state/item injection
and transport/scene bypasses do not count.

Implementation began in parallel OpenCode sessions with one owner per quest/test file.
The initial free DeepSeek endpoint exhausted its quota; work later continued on the
user-approved paid DeepSeek V4.1 Flash 1017 endpoint. After that quota was exhausted, the
root selected MiniMax M3.1 Flash Free for continued source and peer work. Provider pauses
preserve the original sessions, reports, tests and changes; no paid fallback is used after
the MiniMax switch. The integration owner reviews changes, handles shared files and
generated-source fixes, freezes batches, tests and reloads. Generated JSON is never
hand-edited or repaired through copied output overrides. Publication follows the
owner-authorized reviewed batches. Unverified cases stay explicit.

## Current checkpoint — 2026-10-25

### Community-tested quests: skip full manual replay

The user accepted the 21 completion reports in [issue #1257](https://github.com/RSPSApp/tsps/issues/1257)
for queue decisions. Read the [community completion exclusions](quest-helper-728-community-completions.md) before selecting any new full
playthrough. Preserve the report’s caveats and use targeted checks for known bugs;
these passes do not certify complete Quest Helper or recovery/cutscene parity.
None of the 21 names belongs to the original 106 active job roster, so that scope
and its independently audited count are unchanged by this exemption. Unlisted quests
remain eligible; Scorpion Catcher/Velrak issue #1204 is still being fixed.


The owner authorized the 108-PR split merge batch. The [independent PR index](quest-helper-728-prs.md)
links live publication state and integration repairs; merging changes does not accept
additional natural routes or certify deferred, recovery, alternate or visual branches.
Another Slice of H.A.M.'s seven earlier integration failures are repaired in #1192,
with 13 focused checks and a bounded native stage-9-to-10 checkpoint. It remains pending
natural main-route verification. The repaired earlier snapshot passes all 7,453 server
checks and 260 client test files; subsequent main changes pass separate affected-file
checks (713 server checks and 26 client files), builds and client typecheck. Exact
snapshots and the distinction between full suites and later delta checks are recorded
in the PR index.

Native route work used three parallel Codex workers: two native route workers and one source
implementation/review worker, with integration review and publication alongside them.
Each native worker may interleave two independently logged accounts. Eligible workers
handle routine setup, focused tests and checkpoint administration without waiting for
integration approval. Ordinary commodities may be supplied as declared setup aids;
mandatory quest interactions, quest items, puzzles and transports are played naturally.
MCP `plan_route` reuses the existing long-distance collision planner to identify walking
waypoints and closed doors. Internal timed dialogue actions must finish automatically.

The [native verification ledger](quest-helper-728-verification.md) is the current source
of accepted route counts: **26/106 active scoped main routes (24.53%)**. The count
is 26/128 against the original inventory; the increase in percentage comes only
from the approved scope reduction plus the newly accepted Depths of Despair, Death Plateau, Client of Kourend, Lost City, Tree Gnome Village, Hazeel Cult, Elemental Workshop I, Observatory Quest and Queen of Thieves routes. Supplemental issue-809 evidence
is recorded separately. Source fixes and passing regression tests do not count as native
completion. The [independent PRs](quest-helper-728-prs.md) are updated in reviewed batches; historical figures below remain
checkpoints rather than current totals.

Reviewed publications after the scope reduction include the scoped Secrets of the
North actor cleanup (`98953eca7`), earned Horror/Zogre helper state (`19361d7b8`),
Zanik's real follower (`ca2374379`), and the Tree Gnome Village warlord encounter
and required maze railing (`fc5d81024`). Their combined lifecycle/quest checks pass
493/493. Later integration checks pass 461/461, including the real ceremony
runner, shared mansion startup/collision, both quests' wall ownership, and the full
wall/ladder/chest leg. The duplicate SOTN wall and relocated global chest were removed;
its Inspect chest uses a personal visual over the actual cache footprint (`b4f889846`).
Queen of Thieves now uses the actual transformed NPCs, a personal lock/search menu,
canonical delayed page recovery and overflow-safe coins (`af9ceaf8e`); 16 focused checks
pass against both the isolated published AKD dependency and the current worktree. Only
AKD's seven-line shared appearance fix was published; its deferred implementation
remains preserved. Queen of Thieves has a scoped natural route plus epoch26 reward-flag
relog audit; memoir charges/teleports, graceful recolour and letter-reading remain unimplemented.
Elemental Workshop I corrects entered-wall
state, slashed-book requirements, valves, recoverable supplies and the real elemental's
normal floor loot (`7685ba52c`; 20 combined EW1/EW2 checks).

The Hand in the Sand also corrects its canonical varbit, shares the bell/Zavistic with
Zogre and consumes sandpit supplies once (`f1b93eef0`; 27 combined checks, including
both registered quests). Its earned serum/counter/teleport auxiliaries now mirror the actual cache fields and
replay after bootstrap, while preserving WGS's proven counter ownership (28 combined
checks). Scene visuals and natural completion remain unverified. These are source publications,
with no additional accepted natural-route count.

Tree Gnome Village and the Hazeel Cult Hazeel-side route now have accepted
reward/repeat/relog/offline evidence. Alomone and Jones's post-Hazeel availability fix is separately natively verified; this
does not add an alternate-branch/recovery claim.
Lost City, Observatory Quest, Queen of Thieves and Murder Mystery are now accepted within their scoped
main-route evidence. Queen of Thieves includes a completed-account epoch26 reward-flag
replay check. Murder Mystery completed its Anna route under epoch26 after the shared door fix, with independently checked reward/repeat/relog/offline evidence. All raw evidence and prior checkpoints are retained.

## Historical cumulative status checkpoint — 2026-10-22

The original issue scope is **128 quests**. All 128 have source reports and scoped test
files; 127 quest plugin files differ from the task baseline (q046 is test-only). Source
reports are labeled 71 `done`, 54 `partial`, and three other/nonterminal statuses; these
labels describe source work and do not certify route parity. Thirteen plugin deltas are
committed on the draft branch; the rest remain in the shared worktree for review and
integration.

Peer review is cumulative across sessions. **98/128 quests (76.6%) have at least one
final peer report** at some hash. At the current source/test/dialogue-data hashes, 55/128
(43.0%) have final reviews: four clean and 51 with findings. Another 38 have older final
reports that need focused rechecks; eight reviews are active, and 27 quests have no final
review history. A stale-hash report remains useful evidence but does not validate current
source.

Four original quests have accepted natural completion evidence across saved-checkpoint
runs: The Ascent of Arceuus, Bone Voyage, Fishing Contest and Monk's Friend. At First
Light has accepted bounded pickup evidence, not a full completion. The supplemental
Waterfall route has accepted natural evidence outside the original 128. Other native
runs remain incomplete or pending; the separate native ledger records their route,
reward, persistence and recovery limits. No visual Quest Helper overlay is installed.

Initial baseline: server build passed; 4,238 tests, 4,232 passed, six existing failures,
zero skipped. The failure names are: bot activity tier allocation; deployed bot-site
configuration; hint-arrow and packet-sender QuickPrayers import-cycle failures;
Mortimer static Wyrmscraig spawn expectation; Tumeken's shadow walk animation.

Shared foundation: actors now expose their known eight-way heading across idle ticks,
explicit facing and moving interaction targets. This supports Animal Magnetism's
north-facing magnet step without quest-specific core logic. The build and four focused
tests pass; the tests fail against the original compiled implementation. This is source
evidence, and no native quest completion is claimed. A separate six-quest source-check
batch passed 36 focused tests; independent route review remains in progress.

Canonical dialogue regeneration comes from
[osrsreboxed-db PR #9](https://github.com/RSPSApp/osrsreboxed-db/pull/9), commit
`abadb2f4a5`. All 121 dialogue regressions pass. Two fresh offline exports with real
corrections and bindings produced identical sets and bytes for 3,291 generated files;
the tracked outputs match them. The TSPS import copies the minified dialogue export
exactly; its NPC index is unchanged. Consumer compatibility and overhead playback are
separate checks in progress, so this does not certify any quest route.

The shared overhead runtime has now passed root review and 48 focused dialogue tests,
including real task/manager scheduling, actor lookup and cancellation, imported overhead
speech and ordinary chatheads. Its generic two-tick cadence is not capture-proven OSRS
timing. Frozen natural playthroughs may run alongside read-only peer reviews; their
evidence remains provisional until the review passes for the same revision.

Five quests have reached the native playthrough phase. At First Light and The Ascent of
Arceuus entered playthroughs on frozen loaded revisions. At First Light's nine focused
tests and independent source review pass. It reached stage 12, paid the exact quest
rewards once and retained them after relogging. Its two jerboa catches separately
awarded 274 Hunter XP; repairing the bed awarded 10 Crafting XP. Missing ground tools
were bought from ordinary shops, and an optional upstairs detour needed a teleport
recovery. The missing needle and hammer spawns now match the pinned helper and Wiki
tiles in hand-maintained world data; this file is not a dumper export. The fresh follow-up
confirmed a settled needle pickup and persistence after relog. The hammer remained on
the ground after two adjacent approaches; the generic pickup path is under investigation.
Post-quest history did not duplicate rewards. Remaining recovery checks keep the run
provisional. Respawn uses the Wiki's 100-tick value without a new capture.

Ascent stopped at its opening: an unscoped Sins of the Father condition handler overrode
Mori's requirements check. The reviewed fix answers only Sins' nine canonical condition
IDs, leaving foreign conditions to their own quests. Nine focused tests pass, including
real registration-order dispatch and existing Sins actions. Ascent's memoir-page and
ordered-tracking corrections pass root review and eight focused tests. These include
the actual Karuulm elevator/return dispatch; landing tiles and timing are inferred
from the helper/cache, without captures. Current-revision peer review, full-bag checks
and a new natural run remain pending. Biohazard stopped at stage 1 and logged out. Its owner has
corrected Elena/Chemist recovery, canonical receipts and Guidor's transition at the actual
revelation dialogue. A further root regression found a courier who disposed of the wrong
vial could not accept a replacement; that recovery repair is in progress. Bone Voyage
also needs a guard preventing the onboard Junior Navigator from completing the quest
before arrival. No whole quest is certified yet.

Monk's Friend completed naturally, paid its rewards once and persisted through logout and
relogin. That run exposed late normal-rune payment and unreachable named Monk variants.
The corrected source now passes independent root review and 11 focused tests, including
normal payment before the party, a full-bag drop after all twelve overhead lines, once-only
settlement before completion observers, and named Monk dialogue selection. A fresh
current-revision run completed naturally: eight law runes arrived before the party at
stage 70; twelve overhead lines then completed stage 80, awarding one quest point and
2,000 Woodcutting XP. Repeat dialogue and relog preserved exact rewards without
duplication, and final logout was confirmed. Full-bag delivery and interruption after
the item box remain untested live; a reported wait beyond twenty minutes lacks an
independent timestamp. Whole-quest certification remains provisional.

Clock Tower crossed the cellar door naturally, placed the red cog, obtained a bucket of
water from the actual well and placed a second cog upstairs, reaching varp 10 = 3.
Real-cache door replay passes 51 focused tests and did not establish a geometry defect;
the driver must wait for opening before crossing in the same script. Completion is
unproven.

Clock Tower's reviewed source checkpoint fixes cog handling, lever transforms, the shared
world-lever condition, the scoped poison trough, the white-cog ladder's surface exit and
the native completion wire. Thirteen focused tests pass. Its affected natural route still
needs validation on the edited revision.

Death on the Isle has a reviewed source checkpoint for captured uniform and party-tray
IDs, the accusation-intro bit, evidence hand-in artwork and recovery after evidence loss.
Eight focused dispatch tests pass. This is separate from a full quest parity review and
natural completion, which remain pending.

The six affected consumers outside this issue's quest list now use the regenerated node
types and IDs, preserving their message text and removing obsolete fixture-only aliases.
The final four focused suites pass 99 tests, including real transcript-runner checks for
Hazelmere's lamp handover and the Khazard barman's once-only bribe. This checks compatibility
with the import; it does not certify those six complete quest routes.

Companion dumper commit `bae28c17eb` discovers official miniquest transcripts, adds the
full His Faithful Servants page, preserves explicit inline anchors, removes only verified
navigation footers, orders terminal quest-complete actions correctly and parses quoted
speaker labels. All 143 dialogue tests pass independently; two complete fresh exports
match for 3,292 generated files. The new export is not imported while the native batch
uses the previous frozen data. Generic NPC identity extraction and Icthlarin's malformed
source structure remain under review. Consumers must use corrected canonical nodes;
skipping real dialogue or copying missing lines into quest code is not accepted.

Big Chompy Bird Hunting has a reviewed source checkpoint for the hunting route, item
capacity and recovery, scoped dialogue conditions, and cancellation of the first hunt
on logout. Its combat hook now restricts its own tracked birds and leaves other quests'
owned NPCs alone. Fourteen focused tests pass, including the real combat policy and
plugin dispatch path. Natural completion and recovery remain pending.

His Faithful Servants and Museum Kudos are supporting work discovered through mandatory
Desert Treasure II and Bone Voyage prerequisites. They are tracked separately from the
128 issue quests and tutorial below.

Museum support now has a reviewed 100-Kudos source route through five Dig Site displays
and ten Historian Minas reports. Six focused tests cover real cached transcripts, once-only
Kudos/lamps, capacity retry, saved attributes, fixed find probabilities and duplicate artefact
removal. The persisted count now mirrors to `VM_KUDOS` (varbit 3637) on awards, login and
bootstrap, preserving sibling bits in varp 1010. Tests cover the 99/100 prerequisite boundary
and replay at 0/99/100. Bone Voyage's owner is integrating the synchronous `museum:get-kudos`
contract. Natural Museum testing remains pending. The quiz, fossils, pendant teaching and other
Museum activities remain outside this bounded route; a missing Hazeel report transcript
branch remains blocked at its source.

Zogre Flesh Eaters needed no source change for the canonical dialogue import. The three
nodes the old dump marked `unavailable` — `6kbf4F`, `IOrqNS` and `YrmIgh` — are now real
message nodes with new ids: `luhaXl` ("Grish hands you some food and two potions."),
`uZirGH` ("Grish gives you a crudely crafted key.") and `_QKSlE` ("Zavistic hands you a
bottle of strange potion."). The plugin already references the new ids, every id it
references exists in the current page, and the eleven focused tests pass.

Its native run stopped at stage 3 with 25 identical "I can't reach that!" replies while
using the Dragon Inn tankard on NPC 1320 (the Dragon Inn bartender). The cause is core
reach, not the quest plugin: `MovementQueue.walkToEntity` (`MovementQueue.ts:1231,1287`)
never reached the NPC, so no plugin dispatch ran. A registered-dispatch repro confirms the
quest side is sound — the plugin's item-on-NPC handler fires for NPC 1320 with the tankard
and starts the generated variant
`investigating-b-vahn-using-the-dragon-inn-tankard-on-the-dragon-inn-bartender`, whose
message `OG1g5U` sets the tankard-shown flag. Two shared causes block the walk: NPC 1320's
spawn entry carries no `wanderRadius`, so the loader's default 5 applies
(`NpcSpawnDefinitionLoader.ts:31,123-125,151`) and `NPCMovementCoordinator.wander()` moves
the bartender up to five tiles — the raw log's observed positions
(2556,3077 / 2556,3078 / 2556,3079 / 2557,3080 / 2555,3077 / 2554,3077 / 2553,3079 /
2552,3081 / 2554,3082) all sit within that radius of the spawn (2556,3078) — and the
collision map splits the inn: the bar room is one 56-tile component (x 2549-2558,
y 3078-3083) holding both the spawn tile and the driver's tile 2553,3083, while every
counter-row tile (row 3077, e.g. 2556,3077 clipping `0x4020`, north-east corner blocked)
is an isolated two-tile pocket with no reachable neighbour, so `reachedAbsolute` fails
from every side and the entity route returns zero waypoints. Request to the shared owners:
give the Dragon Inn bartender a bounded (zero) wander radius, or derive the radius from the
cache walk sequence instead of the blanket default. The plugin is left unchanged and no
quest shim was added. The tankard step is proven by dispatch and cache repro plus
collision analysis only, not by a live interaction; natural completion stays pending.

## Active quest status — 106 quests

On 23 October 2026 the user deferred the 22 long or complex quests listed below. Their
existing fixes, reports and checkpoints are preserved. Remaining completion work for
PR #753 targets these 106 active quests; shared dependency fixes may still affect a
deferred quest. No deferred quest is counted as complete.

“Pending” means no accepted evidence yet. Source review does not imply native completion.

| Quest | Module | Source / fixes | Regression | Natural completion / recovery |
| --- | --- | --- | --- | --- |
| Animal Magnetism | `AnimalMagnetism` | Pending | Pending | Pending |
| Another Slice of H.A.M. | `AnotherSliceOfHAM` | Pending | Pending | Pending |
| The Ascent of Arceuus | `AscentOfArceuus` | Sins scope, memoir, ordered trail and Karuulm route reviewed by root; fresh peer pending | 8 quest and 9 shared focused tests pass | Accepted captured main route; later edits and uncovered recovery still need rechecks ([ledger](quest-helper-728-verification.md)) |
| At First Light | `AtFirstLight` | Mandatory route, hammer tools, report recovery, Fox cleanup and leaf guards reviewed; canonical ground spawns added | 9 focused tests pass; spawn JSON/uniqueness/cache placements checked | Stage 12, rewards once and relog observed; a separate south-side hammer pickup/relog contract was accepted, while the latest peer review found three interruption/recovery defects still needing source repair |
| Between a Rock... | `BetweenARock` | Pending | Pending | Pending |
| Big Chompy Bird Hunting | `BigChompyBirdHunting` | Hunting, recovery, condition scope and combat/timer fixes reviewed | 14 focused tests pass | Accepted captured main route; later edits and uncovered recovery still need rechecks ([ledger](quest-helper-728-verification.md)) |
| Biohazard | `Biohazard` | Recovery and canonical receipts corrected; premature Guidor advancement returned to owner | Scoped source evidence; correction pending | Incomplete at stage 1; logged out |
| Bone Voyage | `BoneVoyage` | Pending | Pending | Accepted captured main route; later edits and uncovered recovery still need rechecks ([ledger](quest-helper-728-verification.md)) |
| Cabin Fever | `CabinFever` | Pending | Pending | Pending |
| Client of Kourend | `ClientOfKourend` | Veos ownership/travel, orb handover and wire mapping, memoir recovery fixes pushed; independent review ongoing; lamp recovery remains under investigation | 9 focused handler tests pass | Accepted linked natural main route, actual Munty door, five houses/altar, rewards/repeat/relog/offline ([ledger](quest-helper-728-verification.md)); destroyed unused-lamp recovery/overlay unchecked |
| Clock Tower | `ClockTower` | Cog handling, shared lever, trough scope, surface exit and completion wire reviewed | 13 focused tests pass | Accepted captured main route; later edits and uncovered recovery still need rechecks ([ledger](quest-helper-728-verification.md)) |
| Cold War | `ColdWar` | Pending | Pending | Pending |
| Creature of Fenkenstrain | `CreatureOfFenkenstrain` | Pending | Pending | Pending |
| The Curse of Arrav | `CurseOfArrav` | Pending | Pending | Pending |
| Death on the Isle | `DeathOnTheIsle` | Captured item IDs, accusation bit and evidence recovery checkpoint reviewed; full parity review pending | 8 focused dispatch tests pass | Pending |
| Death Plateau | `DeathPlateau` | Harold’s IOU recovery, ordered condition checks and missing-item handouts use the imported transcript; shared runner now continues explicitly true linear sibling conditions | 47 shared/runtime and quest regressions pass | Accepted linked natural main route, rewards/repeat/relog/offline; certificate full-bag retry exercised ([ledger](quest-helper-728-verification.md)); other recovery/overlay unchecked |
| Death to the Dorgeshuun | `DeathToTheDorgeshuun` | Earned helper state and actual Zanik follower reviewed/pushed; optional tour gaps remain | 16 focused checks pass | Pending natural route |
| The Depths of Despair | `DepthsOfDespair` | Recovery/dialogue review and cache-backed stepping-stone approach fixed | 14 focused checks pass, including normal movement to the bank | Accepted checkpoint-linked main route, rewards/repeat/relog/offline independently checked; recovery and overlay remain unchecked ([ledger](quest-helper-728-verification.md)) |
| Devious Minds | `DeviousMinds` | Pending | Pending | Pending |
| The Dig Site | `DigSite` | Pending | Pending | Pending |
| Dream Mentor | `DreamMentor` | Pending | Pending | Pending |
| Druidic Ritual | `DruidicRitual` | Prison-door interaction name repaired for #1080 | Real-map gate opening, passage and closing regressions | Earlier completion used an alternate dungeon entrance after both prison leaves failed. A separate bounded gate checkpoint now verifies both leaves, passage, all four meat dips and relog; it is not a new full quest route. See the corrected [ledger](quest-helper-728-verification.md). |
| Dwarf Cannon | `DwarfCannon` | Pending | Pending | Pending |
| Eadgar's Ruse | `EadgarsRuse` | Pending | Pending | Pending |
| Eagles' Peak | `EaglesPeak` | Pending | Pending | Pending |
| Elemental Workshop I | `ElementalWorkshopI` | Wire, entered wall, slashed book, valves, recoverable supplies and actual elemental floor loot reviewed/pushed | 10 focused; 20 combined EW1/EW2 checks pass | Accepted fresh natural main route, rewards/legitimate postcraft/relog/offline ([ledger](quest-helper-728-verification.md)); optional recovery/visuals/base crafting XP unchecked |
| Elemental Workshop II | `ElementalWorkshopII` | Pending | Pending | Pending |
| Enakhra's Lament | `EnakhrasLament` | Pending | Pending | Pending |
| Enlightened Journey | `EnlightenedJourney` | Pending | Pending | Pending |
| Ethically Acquired Antiquities | `EthicallyAcquiredAntiquities` | Pending | Pending | Pending |
| The Eyes of Glouphrie | `EyesOfGlouphrie` | Pending | Pending | Pending |
| Fairytale I - Growing Pains | `FairytaleIGrowingPains` | Pending | Pending | Pending |
| Fairytale II - Cure a Queen | `FairytaleIICureAQueen` | Pending | Pending | Pending |
| Family Crest | `FamilyCrest` | Pending | Pending | Pending |
| The Feud | `TheFeud` | Pending | Pending | Pending |
| Fight Arena | `FightArena` | Pending | Pending | Accepted captured main route; later edits and uncovered recovery still need rechecks ([ledger](quest-helper-728-verification.md)) |
| Fishing Contest | `FishingContest` | Pass/trophy recovery, Morris pass ownership, scoped pass gates and post-quest dialogue | 12 scoped tests pass; current-hash peer review clean | Accepted captured main route; later edits and uncovered recovery still need rechecks ([ledger](quest-helper-728-verification.md)) |
| Forgettable Tale... | `ForgettableTale` | Pending | Pending | Pending |
| The Forsaken Tower | `ForsakenTower` | Pending | Pending | Pending |
| The Fremennik Isles | `TheFremennikIsles` | Pending | Pending | Pending |
| The Garden of Death | `GardenOfDeath` | Pending | Pending | Pending |
| Garden of Tranquillity | `GardenOfTranquillity` | Pending | Pending | Pending |
| Gertrude's Cat | `GertrudesCat` | Pending | Pending | Accepted captured main route; later edits and uncovered recovery still need rechecks ([ledger](quest-helper-728-verification.md)) |
| Getting Ahead | `GettingAhead` | Lost-head recrafting and interrupted flour-pour recovery reviewed | 9 focused tests pass, including registered sink filling | Pending |
| Ghosts Ahoy | `GhostsAhoy` | Pending | Pending | Pending |
| The Grand Tree | `GrandTree` | Pending | Pending | Pending |
| The Great Brain Robbery | `GreatBrainRobbery` | Pending | Pending | Pending |
| Grim Tales | `GrimTales` | Pending | Pending | Pending |
| The Hand in the Sand | `HandInTheSand` | Shared bell/Zavistic, canonical wire, single sandpit payment and earned helper auxiliaries reviewed/pushed | 28 combined Hand/Zogre checks pass | Pending natural route; scene/interface gaps remain |
| Hazeel Cult | `HazeelCult` | Canonical cave/mansion/hidden-room path, helper state and shared ownership reviewed/pushed; postquest Alomone/Jones fix natively verified | 16 focused; 55 shared Hazeel/North checks pass | Accepted Hazeel-side main route, rewards/Clivet repeat/relog/offline ([ledger](quest-helper-728-verification.md)); Carnillean/recovery unchecked; living postquest Alomone/Jones delta verified |
| The Heart of Darkness | `TheHeartOfDarkness` | Pending | Pending | Pending |
| Holy Grail | `HolyGrail` | Pending | Pending | Pending |
| Horror from the Deep | `HorrorFromTheDeep` | Earned bridge/lighthouse/basement helper state and bootstrap replay reviewed/pushed | 8 focused checks pass | Pending natural route |
| Icthlarin's Little Helper | `IcthlarinsLittleHelper` | Pending | Pending | Pending |
| In Aid of the Myreque | `InAidOfTheMyreque` | Pending | Pending | Pending |
| In Search of the Myreque | `InSearchOfTheMyreque` | Pending | Pending | Pending |
| Jungle Potion | `JunglePotion` | Bounded natural stage 9→12 route, including lost-herb re-search; no full-quest completion claim | QP, quest Herb XP and cleaning XP, repeat/relog and save snapshot verified | Accepted captured main route; later edits and uncovered recovery still need rechecks ([ledger](quest-helper-728-verification.md)) |
| King's Ransom | `KingsRansom` | Pending | Pending | Pending |
| Lost City | `LostCity` | Reviewed/published stage and Entrana source; loaded epoch25 matches `ab9560ef0a5981e366dc2a21dd6493e5a8f801eef011ba23df422db02c862efd` | Focused test `edc102da6e9999e7fa9416fe7a3953597f6255863538574dd7b578b26e31b571` | Accepted checkpoint-linked stage0→6 route, QP3, repeat/relog/offline; explicitly combat-assisted, with aids and limits in the ledger ([ledger](quest-helper-728-verification.md)) |
| The Lost Tribe | `LostTribe` | Pending | Pending | Pending |
| Making Friends with My Arm | `MakingFriendsWithMyArm` | Pending | Pending | Pending |
| Making History | `MakingHistory` | Pending | Pending | Pending |
| Meat and Greet | `MeatAndGreet` | Pending | Pending | Accepted captured main route; later edits and uncovered recovery still need rechecks ([ledger](quest-helper-728-verification.md)) |
| Merlin's Crystal | `MerlinsCrystal` | Pending | Pending | Pending |
| Monk's Friend | `MonksFriend` | Rune timing, deferred reward settlement and named Monk variants corrected and reviewed | 11 focused tests pass, including real final transcript | Accepted captured main route; later edits and uncovered recovery still need rechecks ([ledger](quest-helper-728-verification.md)) |
| Mountain Daughter | `MountainDaughter` | Pending | Pending | Pending |
| Murder Mystery | `MurderMystery` | Shared guard and Salesman ownership, actual culprit alibi, native suspect replay, receipts and evidence hand-in reviewed/published | 9 focused checks pass; shared guard regression fails against old published King's Ransom and passes with its minimal prerequisite fix | Accepted Anna main route: normal front doors, alibi/untouched heap, Guard hand-in, exact rewards, repeat/relog/offline; alternate suspects/recovery remain unverified |
| My Arm's Big Adventure | `MyArmsBigAdventure` | Pending | Pending | Pending |
| Nature Spirit | `NatureSpirit` | Pending | Pending | Pending |
| Observatory Quest | `ObservatoryQuest` | Earned gate/mould/view helper state and assistant-name condition reviewed; full-bag mould retry, consumed-key reopening and actual destruction/death refresh repaired | 12 focused checks pass | Accepted scoped natural stage0→7 route, QP+2, Crafting+2250, observed Taurus reward/repeat/relog/offline; optional Assistant wine, duplicate guard cleanup, other branches, recovery and overlay unverified ([ledger](quest-helper-728-verification.md)) |
| Olaf's Quest | `OlafsQuest` | Pending | Pending | Accepted captured main route; later edits and uncovered recovery still need rechecks ([ledger](quest-helper-728-verification.md)) |
| Plague City | `PlagueCity` | Pending | Pending | Pending |
| A Porcine of Interest | `PorcineOfInterest` | Pending | Pending | Accepted captured main route; later edits and uncovered recovery still need rechecks ([ledger](quest-helper-728-verification.md)) |
| Priest in Peril | `PriestInPeril` | Pending | Pending | Pending |
| The Queen of Thieves | `QueenOfThieves` | Actual transformed NPCs, owner chest and delayed reward recovery reviewed/pushed | 16 focused checks pass with isolated AKD dependency and actual worktree | Accepted scoped natural stage0→13 route and epoch26 reward-flag relog persistence check; memoir functionality/recolour/letter interface absent ([ledger](quest-helper-728-verification.md)) |
| Rag and Bone Man I | `RagAndBoneManI` | Pending | Pending | Pending |
| Recruitment Drive | `RecruitmentDrive` | Pending | Pending | Pending |
| The Ribbiting Tale of a Lily Pad Labour Dispute | `RibbitingTale` | Pending | Pending | Pending |
| Roving Elves | `RovingElves` | Pending | Pending | Pending |
| A Ruff Situation | `ARuffSituation` | Reviewed dog/puppy/transcript route; Baraek sale tracked separately | Focused current hash retained; actual transcript sale regression in follow-up | Accepted combat-assisted main route: real fur drop/crafting, three puppies, reward/repeat/relog/offline; paid-fur branch and full recovery remain pending |
| Rum Deal | `RumDeal` | Pending | Pending | Pending |
| Scorpion Catcher | `ScorpionCatcher` | Pending | Pending | Pending |
| Sea Slug | `SeaSlug` | Stage-aware wall menu, crane reach, Holgart and canonical torch/sticks recovery reviewed | 15 focused cache/handler checks pass | Pending |
| Sheep Herder | `SheepHerder` | Pending | Pending | Pending |
| Shilo Village | `ShiloVillage` | Pending | Pending | Pending |
| Sleeping Giants | `SleepingGiants` | Pending | Pending | Accepted captured main route; later edits and uncovered recovery still need rechecks ([ledger](quest-helper-728-verification.md)) |
| The Slug Menace | `SlugMenace` | Pending | Pending | Pending |
| A Soul's Bane | `SoulsBane` | Pending | Pending | Pending |
| Swan Song | `SwanSong` | Pending | Pending | Pending |
| A Tail of Two Cats | `TailOfTwoCats` | Pending | Pending | Pending |
| Tale of the Righteous | `TaleOfTheRighteous` | Pending | Pending | Pending |
| A Taste of Hope | `TasteOfHope` | Pending | Pending | Pending |
| Tears of Guthix | `TearsOfGuthix` | Pending | Pending | Pending |
| Temple of Ikov | `TempleOfIkov` | Pending | Pending | Pending |
| The Tourist Trap | `TouristTrap` | Cache transform parents, worn disguise, lost supplies, XP interruption and saved-stage migration reviewed | 21 focused checks pass | Pending |
| Tower of Life | `TowerOfLife` | Pressure plug rule, pipe piece model/position mirroring, renewable costume pieces, the basement wire step 17 and the mind-meter threshold repaired against the cache and the Quest Helper solver | 22 focused source-contract tests pass | No native playthrough; no completion claimed |
| Tree Gnome Village | `TreeGnomeVillage` | Lowercase interactions, real owned warlord, correct guide/railing and actual ceremony groups reviewed/pushed | 13 focused; 24 combined Hazeel/Tree checks pass | Accepted linked natural main route, real chorus/rewards/repeat/relog/offline ([ledger](quest-helper-728-verification.md)); optional recovery/scene timing unverified |
| Tribal Totem | `TribalTotem` | Pending | Pending | Pending |
| Troll Romance | `TrollRomance` | Pending | Pending | Pending |
| Troll Stronghold | `TrollStronghold` | Pending | Pending | Pending |
| Twilight's Promise | `TwilightPromise` | Pending | Pending | Pending |
| Wanted! | `Wanted` | Helper state, canonical mage discovery and random trail reviewed/pushed; unsupported Abyss substitute removed | 14 focused checks pass | Pending natural route; exact scan boundaries/damage/optional behavior unverified |
| Watchtower | `Watchtower` | Pending | Pending | Pending |
| What Lies Below | `WhatLiesBelow` | Pending | Pending | Pending |
| Witch's House | `WitchsHouse` | Grounded basement/gloves, key item-use, owned mouse, capacity/retry and reward fixes reviewed/published | 11 focused checks pass | Natural route pending; canonical Nora detection remains unimplemented; guessed proximity rule removed and archived |
| Zogre Flesh Eaters | `ZogreFleshEaters` | Earned helper/evidence state, recipient distinction and bootstrap replay reviewed/pushed | 14 focused checks pass | Pending natural route; legacy ambiguous evidence not fabricated |

## Deferred — 22 long or complex quests

These quests remain part of the original issue inventory, outside this PR's remaining
completion requirements. Existing evidence and unfinished changes are retained for
follow-up; their historical statuses below are not acceptance claims.

| Quest | Module | Source / fixes | Regression | Natural completion / recovery |
| --- | --- | --- | --- | --- |
| Darkness of Hallowvale | `DarknessOfHallowvale` | Pending | Pending | Pending |
| Desert Treasure I | `DesertTreasureI` | Pending | Pending | Pending |
| Desert Treasure II - The Fallen Empire | `DesertTreasureII` | Pending | Pending | Pending |
| Dragon Slayer II | `DragonSlayerII` | Pending | Pending | Pending |
| The Fremennik Trials | `FremennikTrials` | Pending | Pending | Pending |
| Heroes' Quest | `HeroesQuest` | Pending | Pending | Pending |
| A Kingdom Divided | `AKingdomDivided` | Pending | Pending | Pending |
| Legends' Quest | `LegendsQuest` | Pending | Pending | Pending |
| Lunar Diplomacy | `LunarDiplomacy` | Pending | Pending | Pending |
| Monkey Madness I | `MonkeyMadnessI` | Pending | Pending | Pending |
| Monkey Madness II | `MonkeyMadnessII` | Pending | Pending | Pending |
| Mourning's End Part I | `MourningsEndPartI` | Pending | Pending | Pending |
| Mourning's End Part II | `MourningsEndPartII` | Pending | Pending | Pending |
| A Night at the Theatre | `ANightAtTheTheatre` | Pending | Pending | Pending |
| One Small Favour | `OneSmallFavour` | Pending | Pending | Pending |
| Rag and Bone Man II | `RagAndBoneManII` | Pending | Pending | Pending |
| Ratcatchers | `Ratcatchers` | Pending | Pending | Pending |
| Recipe for Disaster | `RecipeForDisaster` | Pending | Pending | Pending |
| Regicide | `Regicide` | Pending | Pending | Pending |
| Song of the Elves | `SongOfTheElves` | Pending | Pending | Pending |
| Underground Pass | `UndergroundPass` | Pending | Pending | Pending |
| While Guthix Sleeps | `WhileGuthixSleeps` | Pending | Pending | Pending |

## Separate tutorial

Learning the Ropes has no helper in the pinned Quest Helper source. Review its canonical
behaviour against the Wiki/cache and test its natural tutorial route separately; do not
claim Quest Helper parity for it. Source, regression and native checks: pending.

## Supplemental Waterfall route

The user-reported raft and rope crossing is covered separately from the 128 Quest Helper
issue quests. Source and focused peer review pass for the real raft-to-island route, rope
on the crossing rock, and rope on the dead tree to reach the waterfall ledge. A resumed
native run also confirmed the ordinary River Swim sends the player downstream and leaves
quest stage, QP, XP and inventory unchanged; the same account relogged and remained saved.
At the ledge, the no-amulet door refusal was observed, so this evidence establishes the
reported crossing and cave entrance, not cave entry or whole-quest completion. The native
artifacts are `/tmp/tsps-728/native/jobs/q131-epoch3.report.json` and
`/tmp/tsps-728/native/jobs/q131-riverswim.report.json`; source-only tests do not substitute
for this route evidence.

Issue #1262 adds a source-level regression for the upstairs south-east bookcase and book-read
step at varp 65 stages 2→3. It covers the full-bag refusal and retry, cancelling the item
message, recovery after book loss, and the production dispatch handoff from Tourist Trap's
generic `Bookcase → Search` hook to Waterfall's object-specific handler. This is separate from
the prior raft/rope/River Swim proof. A bounded native review on the isolated worktree now
confirms the real upstairs bookcase Search and inventory Read packets, stage-1 refusal, full-bag
refusal/retry, cancellation, lost-book recovery by Drop/Search, and varp 65 changing from 2 to 3
and surviving logout/relogin. Quest stages, starting position and inventory were arranged with
developer commands; this does not claim a whole-quest route, completion, or reward evidence.

## Evidence and limits

Worker raw logs, captures, accounts and temporary drivers stay outside Git. Accepted
source facts, reproduced bugs, focused tests and native outcomes are recorded here as
batches are reviewed. Never mark a quest fully passed while mandatory legs or required
persistence/recovery checks remain unverified.
