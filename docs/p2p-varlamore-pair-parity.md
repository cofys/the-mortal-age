# Group 1: Ribbiting Tale and A Ruff Situation

## The Ribbiting Tale of a Lily Pad Labour Dispute

Source: [RSProx recording 1695](https://rsprox.net/download/1695), revision 226,
quest route ticks 8893–9360. Raw recordings/transcripts remain outside the repository.
Cache revision 241 supplies current identifiers and interface scripts.

The recorded quest progression is varp 4152 / varbit 9844:
`0 → 2 → 4 → 6 → 8 → 10 → 12 → 14 → 16 → 18 → 20 → 22 → 24 → 26 → 28 → 30 → 32`.
The old plugin omitted the chest-unlocked stage and completed at 30. The chest now
opens native interface 809 and accepts the captured NALIA response `334490`;
knowing or holding the letter does not bypass the combination. Wrong responses,
full inventory and moving away do not grant the plushy. The current cache's CS2
6963 takes a sixth initial-value argument (`-1`), added since the recording's
five-argument version.

The hop-off starts when the invitation dialogue is continued. It uses a private
oasis with nine captured actors, not public NPC edits. At the equivalent of tick
9105 the camera moves to `(1685,2989)` at height 550 and looks at `(1697,2981)` at
height 350; both packets carry rates `232/100`. Fade-out precedes placement,
then the scene resumes Gary's dialogue. Sue's hop uses animation 10957 with exact
movement cycles `7–24`; Cuthbert uses animation 1797 with cycles `13–30`, splash
68 and the captured sounds. The two pauses take three and seven ticks. The ending
fades out, restores the player, resets the camera after two ticks, fades in after
four and starts the peace talks after six. Leaving/logging out cancels scene tasks
and releases movement/camera controls. Chest animations are sent to their owner.

The tree takes four ticks from the chop animation to Jane's orange reaction. The
lily-pad action uses pickup 827, throw 385, sound 2708 and four ticks to stage 14.
Cuthbert starts combat and shouts his recorded threat when the plushy is planted.
Old saves migrate their late quest stages without granting rewards again.
The final reward occurs after Sue's final reply: one quest point, 2,000
Woodcutting XP. The patch unlock is granted and persisted when Marcellus gives
his first postquest permission, matching the captured completion value32 rather
than eagerly adding bit128 to it. The existing Farming patch is used.

Validation: `server/tests/p2p-varlamore-pair-parity.test.cjs` exercises the native
combination, wrong/full inventory cases, every late stage through the final reward,
native start/Frog conversation, private scene/camera/forced hops/reset, old-save
migration and interrupted-scene cleanup using the
actual quest and dialogue runtime.

Remaining evidence gaps: this capture enters the combination without reading the
love letter. Its contents retain the Wiki transcript, and its native paper layout
has not been established. Unrecorded dialogue alternatives, player-death dialogue,
and precise ambient wandering/random behaviour are not certified by this route.
A complete visual comparison with live OSRS is still required.

## A Ruff Situation

Sources: Discord recordings `A_Ruff_Situation.bin` and
`Obtain_Interact_Abandon_puppy.bin` from the
[quest recordings thread](https://discord.com/channels/1445802914156249241/1541197127189921963/threads/1551940022922641519),
revision 241. Raw binaries and full transcripts stay outside the repository;
the plugin data contains canonical dialogue metadata and quest NPC route tiles.
The separate puppy follow-up is documented in `docs/p2p-ruff-puppies-parity.md`.

The main quest now uses varp5742 / varbit15889 and the captured stages:
`5 → 10 → 15 → 20 → 25 → 30 → 35 → 40 → 45 → 50 → 55 → 60 → 65 → 66 → 70 → 75 → 80 → 85 → 90 → 95 → 100 → 105 → 110 → 115 → 120`.
Its former stages1–10 migrate without granting rewards again. Accepting starts at5;
Chase's Gertrude suggestion advances10, Gertrude's stray-dog lead15, and the
player's agreement to follow20. The three dog routes follow recorded tiles.
Den inspections preserve their separate bedding/newspaper/crate flags and delays
(two/four/two ticks). Native parent locs62483/62486/62489 already exist in cache
region12597; the plugin adds no replacement world objects. Gertrude3500 is the
existing canonical NPC.

All four recorded camera scenes are private, with owner-only actors. Their initial
move/look targets and heights are:

| Scene | Camera position | Look target | Rates |
| --- | --- | --- | --- |
| First puppy |3152,3451,400|3148,3456,250|232/100|
| Outlaws |3132,3470,600|3137,3476,600|232/100|
| Third puppy rescue |3131,3476,500|3137,3476,600|232/100|
| Shelter |3044,3461,500|3038,3458,350|232/100|

The first scene pans to3152,3454,400/look3145,3456,380 at3/30. The outlaw
scene uses the native cycle motions:210 cycles with sine easing to3128,3476,400;
60 then90 cycles with cubic easing to3129,3476,450 and3131,3476,500; the run-in
moves to3130,3481,700 over90 cycles and looks at3136,3469,300 over150 cycles.
The shelter pans to3044,3455,480/look3038,3459,330 when the puppies are placed,
then3034,3450,400/look3039,3458,350 before the dog's refusal. Scene entry,
fade/reset, automatic continuations and the recorded pauses replace manual
teleports. The two outlaw combat actors16527/16528 must both die before rescue.

Each rescued puppy is a distinct inventory item34598/34599/34600. Pickup uses
animation827 and a two-tick delay; dropped/lost puppies return to the den and
can be recovered. Full inventory does not advance the rescue. Crafting uses
animation8839, consumes the captured grain/fur, retains needle/thread, and makes
34602. The goblin trade consumes that dog at66, fades before their departure at70,
and grants the second puppy at75. The shelter consumes all three puppies.
The quest completes only after continuing Chase's final “Business is business.”
line, granting one quest point and1,000 Crafting XP; the arriving guard does not
complete it early. Logout/disconnect cancels pending choreography, releases
controls, and preserves a recoverable quest state.

Dialogue uses recorded expressions, named transform-parent heads and native
right-side NPC chatboxes for paired speakers. Puppy barks are actor overheads,
not extra chatboxes. Dialogue events carry their transcript page so this quest's
metadata cannot affect another quest.

Validation: nine Ruff runtime tests cover the native start/den/flags, all four
camera scenes and continuations, both outlaw deaths, all real puppy items,
goblin crafting/trade/fade, completion timing, drop recovery, migration, full
inventory and interrupted-scene recovery. Seven Ribbiting tests and the shared
NPC-dialogue regressions also pass.

Remaining evidence gaps: the recording does not expose the dog script's exact
follow-distance pause threshold (currently10 tiles), every refusal/alternate
quest-history branch, death recovery, or puppy feeding/adulthood. Ambient sound
and every individual actor facing/footstep are not exhaustively replayed; the
main scene movements follow the captured actions. Full visual comparison with
live OSRS is still required before claiming frame-for-frame parity.

## Integrated client checks

The native client set all five809 letter wheels to NALIA, clicked Confirm, received the plushy and advanced22→24 through the real count-dialog response. It also exercised the outlaw scene after the real Welcome Play action, including its cycle-based pans, named actors, later approach/run-in view and return to combat. Desktop recovery waits for that root bootstrap; mobile/new/bot/wilderness accounts resume after the existing bootstrap-complete event. The actual WelcomeScreen plugin is included in the recovery regression. Native puppy adoption and follower checks are described in the separate follow-up notes.

Ruff's NPCs exceed the old14-bit spawn type field. Server and client now both transmit16-bit type ids while keeping the index/sentinel unchanged; native Labrador16433 no longer becomes NPC49. Boundary tests cover low/high ids, small/large offsets, replacements, removal and update-block alignment. Client and server must be deployed together for this wire-format change.

Holding the first outlaw line beyond the recording's quick continuation lets its210-cycle pan reach an endpoint absent from the capture, where scenery can occlude the view. The recorded later approach/run-in renders correctly; the long-hold case remains unverified against OSRS.
