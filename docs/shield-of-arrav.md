# Shield of Arrav

Behavior sources: [OSRS Wiki](https://oldschool.runescape.wiki/w/Shield_of_Arrav), its [Black Arm Gang walkthrough](https://oldschool.runescape.wiki/w/Shield_of_Arrav/Black_Arm_Gang), the repository's Wiki transcript, and rsprox captures [1705](https://rsprox.net/download/1705) and [1710](https://rsprox.net/download/1710). Capture 1705 is linked from [issue 600](https://github.com/RSPSApp/tsps/issues/600); searching the quest identified its continuation, 1710. Both are revision 227.1 Leagues recordings. This page retains sanitized gameplay facts, excluding player information and raw recordings.

## Captured facts

The player starts with Reldo, finds book 757 by searching bookcase 2402, reads all four pages, asks Reldo about the gangs, pays Baraek 20 coins, then accepts Katrine's task. **Paying Baraek does not commit the player to the Phoenix Gang.** Simply opening either gang leader's conversation does not accept their task.

| Event | Phoenix varp 145 | Black Arm varp 146 |
| --- | --- | --- |
| Reldo starts the quest | 1 | 0 |
| Read the book | 2 | 0 |
| Reldo explains both gangs | 3 | 1 |
| Pay Baraek | 4 | 1 |
| Accept Katrine's crossbow task | 4 | 2 |
| Give Katrine two crossbows | 4 | 3 |
| Collect shield and certificate halves | 4 | 3 |
| King Roald completes the quest | 4 | 4 |

The book uses interface 392, title component 6, page numbers 9/10, text lines 44–58 and 60–74, and next-page pause button 77. Revision 241 widget definitions confirm this layout. Its four captured pages are stored in `server/plugins/quests/data/shield-of-arrav-book.json` and use the shared quest book reader.

Capture 1710 enters the weapons store with key 759, kills the weaponsmaster, then picks up the two existing floor crossbows: item 767 at (3243,3383,1) and (3245,3385,1). They are floor spawns rather than a death reward. Katrine takes two crossbows. Searching the upstairs cupboard gives shield half 765 once. The curator accepts it and gives two Black Arm half-certificates, item 11174, in an item statement.

Using a certificate half on another player offers a Yes/No drop prompt. Accepting drops it for that player, with a notice to each participant. Combining opposite halves opens `You combine the two halves to make a complete certificate.` Reading full certificate 769 opens interface 526, text child 3, close child 4. King Roald takes the full certificate and awards 600 coins once.

The captured Shield of Arrav route has no scripted camera movement or look-at packets. Recording 1710's later camera sequence belongs to other content, after this quest completes.

## Cache checks and implementation

Revision 241 client script 1969 recognizes Phoenix varp 145 at 10 or Black Arm varp 146 at 4 as completed. NPC 5213 transforms into attackable Jonny 14139 at Phoenix state 8, with membership at state 9. These cache states are mapped separately from the plugin's existing saved internal stages. The old private Jonny copy is removed; the canonical NPC supplies the transformation and 8 Hitpoints.

Independent task attributes let the player investigate both gangs. Membership is committed only when handing in the report or crossbows. The weaponsmaster protects the canonical floor crossbows while alive; Phoenix recruits cannot attack him before completing the quest. Report-for-key admission and certificate combining work with a full inventory. Banked intelligence reports select the appropriate dialogue branch. The curator's actual single message event now performs the shield exchange and displays the captured two-item statement. Door-unlock and cupboard messages match the ending recording.

## Verification and remaining limits

Run from `server/` after building:

```sh
node --test tests/demon-shield-parity.test.cjs
QUEST_FILTER=DemonSlayer,ShieldOfArrav node --test tests/quest-dialogue.test.cjs
```

Focused tests cover investigating both gangs, task acceptance, full-inventory report admission and certificate combining, curator hand-in, partner drops, both book spreads, certificate reading, and both completion states. Canonical crossbow floor coordinates are checked.

The captures establish the Black Arm route through completion. Phoenix task and completion client states are cache-confirmed; its complete dialogue and presentation sequence still lacks a matching capture. Door/cupboard scenery animations and exact floor respawn timing have not received live visual comparison. Reward scroll presentation uses the shared quest runtime. These limitations remain before claiming complete visual and packet-timing parity.
