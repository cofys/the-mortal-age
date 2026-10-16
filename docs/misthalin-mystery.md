# Misthalin Mystery

Behavior comes from the [OSRS Wiki walkthrough](https://oldschool.runescape.wiki/w/Misthalin_Mystery), the supplied live rev240 recording `20260814T112547-59bcb26`, and this worktree's rev241 cache. The complete quest section was read. Raw packets and account details are deliberately excluded from the repository.

The saved quest stages retain their existing meaning. The client stage is **varbit3468**, bits0–7 of varp1535; writing the entire varp erased the candle and puzzle bits. The capture progresses5/10/15/20/25/30/35/40/45/50/55/60/65/70/75/80/85/90/95/100/105/110/**111**/115/120/125/130/135. In particular111 is the mirror fight,115 the defeated killer,120 Hewey's death,125 the player's apparent victory,130 Mandy waiting outside, and135 completion. No door advances past the mirror encounter.

The island uses an owner-only `PrivateArea` over the actual manor source map. Its local actors include the cache's stage-dependent Sid, Tayten, Lacey, Mandy and mirror forms. Murder scenes, the confrontation, unmasking and rescue use their full transcript conversations, camera positions and relevant animations. Each murder advances after the last continued player observation. All four answers to Lacey's question reach her death and the second note; three imported `below` links are now explicit canonical continuations. The unavailable markers in Mandy's imported kitchen directions are skipped because the scene now performs those actions.

## Objects and riddles

The manor key21052 comes from the drained rain barrel. A bucket, knife and tinderbox are available on the island. Reading each note is required before its associated puzzle. Each consumed colored key belongs to the actual door being opened, even if an earlier key was recovered. Four candle bits4039–4042 are persisted independently in `misthalin-mystery:candles`; the fuse remains damp until all four are lit, and the explosion follows leaving the room (including the door tile1640,4828): fade after1tick, shake after2, stage65/sound1487 after4 and control restored after5. Wall crossing uses840 with30/100cycle exact movement and sound2453.

The notes21056–21058 use parchment interface70, text children3 onward and close104. The piano is the real interface554: fourteen white keys20–33, close34, and the cache's individual key sounds. It waits for four inputs before testing **D–E–A–D**, resets a wrong attempt and unlocks at stage80. Progress flags4044–4047 and count4049 follow the capture. Solving the puzzle does not put a key into inventory: searching the piano afterward gives emerald key21054 in objectbox193.

The fireplace reveals native interface555. Its switch children are19 Sapphire,3 Diamond,11 Zenyte,23 Emerald,7 Onyx and15 Ruby. Six inputs are evaluated together; the answer is **Sapphire–Diamond–Zenyte–Emerald–Onyx–Ruby**. The capture uses sound2266, switch flags4051–4056 and count4050. Success writes105 and resets the panel flags. A subsequent search gives sapphire key21055, rather than granting it directly from the button handler.

## Mirror encounter and ending

The four wardrobes are north1622,4834; east1627,4831; south1624,4825; west1619,4828. Shadow graphic483(height1) precedes each knife by14ticks; the wardrobe opens for the throw and closes4ticks later, with the next warning1tick after that. Projectile214 uses the captured41/82cycle launch offsets. Its outward route crosses the room; a mirror in that row or column intercepts it. A wrongly facing mirror deflects it toward the wall. There is no invented player damage on those misses: the recording shows no player hit from them.

Pushing cache mirror7436/7641 plays3065, moves it one tile and moves the player into its old tile. The last push direction must face the warning wardrobe for a successful return. Its private scenery30143 is moved with it and30144 clears the old position. The room limits include the captured south rejection at y4828 and north/east limits4831/1624. Invisible cache actor7639 carries the killer's reaction overhead; sound2707 accompanies throwing and510 accompanies a successful reflection. Three successful returns are required; each deals the captured10damage to the canonical40HP invisible target. Wrong-facing returns cannot advance it. The mirror resets to its inert7640 form after the fight.

The reveal contains both killers, Abigale killing Hewey and the knife dropping on the ground at1624,4830. It is not silently inserted into inventory. The player must pick up **and wield**21059 to fight Abigale; an empty hand or another weapon selects the corresponding refusal. Leaving after the apparent victory triggers Mandy retrieving the godsword, changing to armed form7631 and performing special7642/graphic1212, then the full dextrocardia explanation. The knife is left behind, including when equipped. Mandy waits outside and requires three free inventory spaces before granting1QP,600CraftingXP and one uncut ruby/emerald/sapphire, with jingle153 and the knife shown on the completion scroll.

Logout destroys private actors, scenery and encounter tasks. Returning reconstructs the manor from the saved stage and candle mask. An interrupted stage111 fight restarts its introduction and puzzle safely; a missing dropped knife can be recovered after re-entering at stage120. Leaving and re-entering also replaces Mandy rather than retaining a removed actor.

## Verification and limits

After building, run from `server/`:

```sh
node --test tests/misthalin-mystery-parity.test.cjs
```

The15 focused tests load the actual cache and use the real quest runtime, dialogue manager, native transcripts and private area membership. They cover both puzzles (including wrong attempts and later key searches), the complete Sid/Tayten/Mandy scenes, every Lacey answer, three timed reflections and the full reveal/rescue/reward, wrong weapon/inventory handling, independent candle bits and cleanup.

The camera audit reads all seven scenes in the full decoded recording, including all12 move and13 look-at packets, their separate rate pairs, absolute terrain heights, shake clearing and pitch-lock resets. It restores Sid's asymmetric10/15 and20/20 rates and barrel pan; Tayten's1634,4841/1250 framing; Mandy's two kitchen pans and1400 height; the second killer and Hewey look-at transitions; and the rescue's1620,4826/1300 framing. Initial camera-to-dialogue gaps, the4/8/16-tick pan segments and2/3/11-tick ending resets use scene-owned tasks. Reading time waits for the relevant Continue rather than replaying the recorder's delay. Leaving cancels both pending shots and resets.

Presentation limits: other scene animations still occur at transcript continuation boundaries rather than reproducing every recorded animation pause; the wardrobe fight has its own captured tick schedule. The journal retains semantic wording. A visual client review remains useful for the mirror model's movement.

A fresh live replay through this worktree's own MCP49802 passed private manor creation, the actual554/555 widget button packets and their stage/loc transformations, mirror Push with moved private scenery, all three real timed reflections (111→115), full reveal/Hewey death→120, ground knife pickup and Wield, Fight→125, full rescue→130 with equipped knife removal, then Mandy's reward→135/600CraftingXP/all three gems. Stages75/100/110 were set only to arrange the individual test sections; the fight and ending progressed through actual interactions. Final reflection damage/scenery cleanup, Mandy's armed model and reward order were then tightened and rechecked by the focused regressions. No headless screenshot was claimed.
