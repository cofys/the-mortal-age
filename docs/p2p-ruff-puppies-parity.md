# Ruff puppy follow-up parity

The complete `Obtain_Interact_Abandon_puppy` recording is revision 240.1. The relevant post-quest route spans ticks 160–248: adoption, dropping the puppy, Pet, Guess age, pickup, another drop, and Release. The source recording and account metadata remain local.

`Puppies.Quests.js` attaches to A Ruff Situation's existing quest handle. Chase only opens adoption after completion. It uses native interface 227, enum 5845, breed table 132, selection varps 5732/5733 and unlock varp 5734. The cache owns breed order, preview models, colours, and which breeds need rescuing; locked breeds can be previewed but cannot be adopted through a forged confirmation. Labrador, Pug and Spaniel are free unlocks. Colour models map to the actual follower and item, including colours whose NPC order differs from their preview order.

The recorded Labrador adoption uses Chase's two opening lines, the 200-coin quote, objectbox 193 with No/Yes, then the item handover. Payment and inventory capacity are checked again when Yes is chosen. Closing the window, declining, replaying a button, or replacing the question cannot charge coins or award another puppy.

The shared Pets registry now recognises all 36 real puppy forms without bank placeholders or Probita insurance. Drop, pickup, owner checks, logout and login use the existing pet lifecycle. Native follower varp 447 packs the NPC id and index; 448 carries its inventory item. An absent follower clears both to -1, whose low 16 bits remain 65535 for the client's existing index reader.

The captured follower actions are represented as follows:

- Interact opens the native `Pet. / Guess age. / Release.` menu.
- Pet plays animation 827 and, one tick later, sounds 652 and 12122. Choosing Pet through the menu adds the captured tick before the animation.
- Guess age uses player expression 554, then objectbox 193 with the recorded zero-minute, three-hour message and puppy item.
- Pickup uses animation 827 and sound 2582 delayed 20 cycles. Drop uses sound 2739 and clears the player animation.
- Release requires the No/Yes objectbox and all three recorded conversation lines, using expression 610 and the puppy's real chathead. The following tick removes the same owned follower, clears its saved follower state, plays sound 652 and reports that the puppy ran away. A stale release cannot remove a replacement pet.

`server/tests/p2p-ruff-puppies.test.cjs` tests native widget flags and selections, unlock and forged-button guards, exact payment timing, capacity, real colour mappings, duplicate pickup, relog restoration, timed Pet and age interfaces, and the full release path. It runs alongside the existing pet tests.

Feeding, hunger, growth beyond the captured age zero, and adult dog behaviour are not implemented by this follow-up; the recording does not cover them. The age message currently retains the recorded zero-minute value. The shelter's additional stray-dog rescue activities are also outside this recorded route. Integrated native client checks exercised Chase's Talk-to and Adopt actions, all-breed selector, native Confirm and No/Yes payment, the exact200-coin exchange, drop, pickup, Pet, interaction menu and three-line Release. Closing the preceding chatbox uses PacketSender's current-cache mount rather than the older recording's child567. The native world Labrador now renders correctly after widening the shared NPC spawn type field from14 to16bits. Full OSRS visual comparison remains outstanding.
