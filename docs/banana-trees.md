# Wild banana trees

The [OSRS Wiki](https://oldschool.runescape.wiki/w/Money_making_guide/Picking_bananas)
describes picking five bananas from each tree at Musa Point, with no skill or quest
requirement. This concerns wild trees, not Farming patches.

## Capture evidence

[rsprox captures](https://rsprox.net/database), recording **4287**, revision **239**,
show sound **2581** alongside each successful pick's banana reward, tree depletion
and “You pick a banana.” message. Across the five tree stages, 30 completed picks
have that sound; four further attempts were interrupted by another click.
The `bananatreefour` traces clicked at ticks **311**, **321** and **329** put the
sound, message, tree change and inventory addition at relative tick **0**.
Leagues/event/beta attempts are excluded.

The active revision **241** cache confirms wild tree ids **2073–2077** have `Pick`,
**2078** has `Search`, and sound archive **2581** exists. The existing `Sound.PICK`
constant selects that sound. A normally placed full tree is at **2930, 3161, 0**.

## Fix and checks

The object interaction packet resolves the real tree and routes the player before
calling the `BananaTree` name-based handler. That handler already awards the banana
and depletes the tree, but omitted the pick sound. It now sends `Sound.PICK` with
the successful reward through `api.core.Sounds`.

`server/tests/pickables.test.cjs` exercises the registered handler for all five
fruit-bearing stages: one banana, one pick sound and the next tree stage. It also
checks that a full inventory and an empty-tree search produce no pick sound or
reward. The success test fails before the fix and passes afterwards.

Live agent-MCP verification used a fresh test account, an admin teleport to the
plantation, and ordinary `object_option` packets on cache-placed trees. Before the
fix, a pick at 2930,3161 awarded one banana and changed 2073 to 2074 without a sound.
After the fix, all five stages at 2924,3161 awarded one banana and sent sound 2581
with zero delay. Searching the depleted tree sent only the empty-tree message.
With an inventory filled using the item command, picking the full tree at
2924,3158 left the tree and inventory unchanged and sent no pick sound.

Sound calls were observed with temporary PacketSender logging, removed after the
check; the normal MCP response does not expose sounds. The wire encoder converts
`Sound.PICK`'s legacy loop-type 0 to one playback. Audible client playback was not
checked. No generated data changed.
