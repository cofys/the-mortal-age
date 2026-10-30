# Lost schematics

Twelve recipes now require reading their physical schematics. Login no longer grants eleven recipes automatically. Existing built parts remain installed; replacing them requires the applicable learned recipe. Learned recipes and opened lockboxes are separate saved player state.

## Sources

- [Lost schematics](https://oldschool.runescape.wiki/w/Lost_schematics): twelve sources, ten matched key/lockbox pairs, directions, reading, quest requirements and destroy warnings.
- [Small key (The Pandemonium)](https://oldschool.runescape.wiki/w/Small_key_(The_Pandemonium)): directions need not be carried to dig.
- Detailed Buccaneers key directions place the dig underground at 2054,10092; the overview's surface coordinate disagrees.
- RSProx235/03792: native spade Dig at3050,2995, human_dig, sound1470 and key/objectbox; lockbox consumes key and sets opened bit at+1, animation/sounds at+2, schematic/log/objectbox at+3, closed visual at+5. Read consumes and sets learned bit immediately, sound2655.
- RSProx235/00936,00960,01029 corroborate other lockboxes and reading. RSProx238/04152 shows Red Reef awarding the bosun schematic before its later Read.
- Pinned rev241 dump6e5033af6215963581a51b348f452320ff18f0f6: clientscript9078 maps all twelve learned bits to build rows. IDs and option names resolve against active osrs-241_2026-10-20. Lockboxes use existing map placements, which differ from some Wiki map pins.

## Production paths and state owners

- Native inventory packet -> ClientConnection.inventoryAction -> item-action dispatcher -> Acquisition.Dig / Unlocks.Read -> real inventory and player-indexed LockboxTask -> collection-log owner, persisted sailing:schematics and client varbits/objectbox.
- Mapped Lockbox Open -> named object-action dispatcher -> Acquisition -> exact live key slot, capacity recheck and per-player object packets. Interrupted first opening retains opened state for reclaim; other players' map objects are unchanged.
- Ava's canonical NPC dialogue -> existing condition/action hooks -> Sources -> quest:is-complete owner and real inventory. Animal Magnetism and Pandemonium must both be complete. The original canonical message prints only when a physical item was added.
- Red Reef's existing QuestRuntime reward grants the original bosun schematic. Postquest Elder Raley interaction reclaims a missing unread copy. Collection-log recording uses its existing ensure semantics.
- Native shipyard build trigger -> existing part/facility validation -> sailing:schematic-can-build -> saved learned state -> existing requirements, inventory consumption and boat update. Client flags cannot authorize a build.
- PlayerSave serializes the registered attribute; login and bootstrap restore learned/opened varbits individually, preserving sibling bits.

## Shared-system checks

All inventory and bank tabs count toward ownership. Delayed tasks retain the exact clicked key and validate it before consumption; real bank deposit/withdraw transitions are tested. Capacity is checked again before delivery, preserving unrelated items. Movement, interface replacement, death and logout invalidate pending actions. Metadata-bearing keys are accepted and only the clicked copy is consumed. Reading consumes one clicked schematic and leaves other copies intact. Schematics do not store or withdraw bank items, so no additional bank PIN operation is introduced.

## Evidence limits

Wiki supplies directions and refusal/destroy text where captures are absent. Directions use the existing item statement interface; its precise official interface was not captured. Duplicate-owned key/directions suppression, duplicate Read refusal, build refusal wording, keyless reclaim timing and Elder Raley postquest reclaim presentation are local policies without matching recordings. No Sailing-level gate is added to digging or reading. Ava's existing canonical transcript owns her conversation; no generated dialogue data is edited.

Automated checks use real Player, Inventory, Bank, NPC, TaskManager, DialogueManager, PacketSender and PlayerSave with production plugin startup. Controlled fixtures seed quest state/items; only network output/dialogue capture is stubbed. Pinned server build and affected tests pass121/121.

Independent review reproduced and fixed two issues: NPC handouts now send inventory container updates, and the full-inventory Red Reef reward is collection logged even when QuestRuntime places it on owned ground. Its unchanged adversarial tests also verified real bank deposit/withdraw invalidates the waiting key and a fresh Open succeeds (27/27 independent plus focused tests).

Rendered native checks used a fresh account and the worktree client. Native Spade Dig at3050,2995 awarded32411 with the key objectbox. The existing Chinchompa lockbox59989 accepted that key and awarded32401; opened19554 became1 while learned19544 remained0. Native Read consumed32401 and set19544=1. Full canonical Ava conversation through More options and saving cannonballs awarded33143 and collection-log credit; prerequisite quest completion was a disclosed fixture.

Native shipwright boat selection, mapped schematics Modify, scrolling, closing and reopening showed the locked rosewood row, then a Build row after native Read of a seeded32407. With separately seeded skill levels/materials, the native Build consumed exactly10rosewood hull parts32059,300dragon nails31406,20swamp tar1939 and5cupronickel bars32892, updated the boat hull to tier6 and showed the workers' rebuild dialogue. Network logout/relogin restored19544=1,19550=1,19554=1 and the built boat. Existing customisation rows render some names/icons blank in this client; this branch does not change those shared renderers. No claim of complete visual parity is made.
