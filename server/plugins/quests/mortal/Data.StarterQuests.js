"use strict";

/**
 * Data.StarterQuests — the six Mortal Age starter quests, one per origin.
 *
 * Data-driven: each quest is a list of stages. A stage is:
 *   objective  — short journal line shown in the overlay banner
 *   arrive?    — { x, y, r } tile the player must reach before the stage
 *                content unlocks. Before arrival the overlay shows the
 *                objective with a "make your way there" hint.
 *   dialogue?  — { speaker, title, lines[], choices?[] } shown in the
 *                overlay when the stage is unlocked. "Continue" advances.
 *                choices: [{ text, goto }] jump to a stage index.
 *   task?      — { type: "item", item: "<ItemIdentifiers key>", amount,
 *                verb } — auto-completes when the condition is met.
 *
 * Coordinates are near the verified origin spawns in Data.Origins; radii
 * are generous (6-10) so tutorial players can't get stuck.
 *
 * Rewards: { items: [[key, amount]...], xp: [[skillName, amount]...],
 *            message } — skillName must exist on api.core.Skill.
 */

const STARTER_QUESTS = [
  // ------------------------------------------------------------------
  {
    id: "misthalin-starter",
    originId: "misthalin",
    name: "Debts in the Market",
    blurb: "A merchant is being shaken down in the grand market. Varrock teaches its lessons fast.",
    stages: [
      {
        objective: "Find Merchant Tull at the Varrock market",
        arrive: { x: 3215, y: 3430, r: 10 },
        dialogue: {
          speaker: "Merchant Tull",
          title: "Spice merchant",
          lines: [
            "You there! A Varrockian face — thank the gods. Perhaps you can help an old trader.",
            "That Black Arm thug has been demanding 'protection' coin from every stall this week. He'll be back any moment, and I will not pay thieves to let me sell my own pepper.",
            "When he comes, I need someone to stand with me. Will you?",
          ],
        },
      },
      {
        objective: "Decide how to handle the thug",
        dialogue: {
          speaker: "Black Arm Thug",
          title: "Protection racketeer",
          lines: [
            "Well well. Tull found himself a little friend. The price just went up — ten coins, from the both of you, or I start breaking stalls.",
          ],
          choices: [
            { text: "Pay the ten coins to avoid trouble", goto: 2 },
            { text: "Refuse. 'Not from us. Not today.'", goto: 3 },
          ],
        },
      },
      {
        objective: "Tull is grateful — hear him out",
        next: 4,
        dialogue: {
          speaker: "Merchant Tull",
          title: "Spice merchant",
          lines: [
            "You didn't have to do that. Most folk look the other way — it's the Varrock way, they say.",
            "Here — for your trouble. And a word of advice from a man who has sold in this market forty years: the gangs own the alleys, but the palace guard still owns the square. If you're ever in real trouble, run toward the white marble, not away from it.",
            "Welcome home, Varrockian. The market remembers its friends.",
          ],
        },
      },
      {
        objective: "The guard intervenes — speak with her",
        dialogue: {
          speaker: "Guard Captain Rika",
          title: "Varrock palace guard",
          lines: [
            "Hold it right there! Black Arm filth, out of my market — NOW.",
            "Hmph. He'll be back, they always come back. But you — you stood your ground when Tull's own neighbours wouldn't.",
            "Listen well, newcomer. Varrock's crown may be heirless and its church may shout, but the guard still keeps the peace where it matters. Stay near the square, keep your coin pouch tied, and you'll do fine here.",
            "The market remembers its friends. So do we.",
          ],
        },
      },
      {
        objective: "Quest complete",
        dialogue: {
          speaker: "Merchant Tull",
          title: "Spice merchant",
          lines: [
            "You've learned Varrock's first lesson faster than most: everything here has a price — including doing the right thing.",
            "Walk these streets with your eyes open, and they'll start to feel like home.",
          ],
        },
      },
    ],
    rewards: {
      items: [["COINS", 75]],
      xp: [["THIEVING", 150]],
      message: "You feel at home in the grand market.",
    },
  },
  // ------------------------------------------------------------------
  {
    id: "asgarnia-starter",
    originId: "asgarnia",
    name: "The White Wall",
    blurb: "The White Knights need eyes on the wall. Falador rewards those who serve.",
    stages: [
      {
        objective: "Report to the White Knight by the wall",
        arrive: { x: 2968, y: 3382, r: 10 },
        dialogue: {
          speaker: "Sir Theodore",
          title: "White Knight",
          lines: [
            "Hail, traveller. You walk like one looking for purpose — Falador has purpose to spare.",
            "With no king on the throne, the Kinshra grow bold and the roads grow dangerous. We keep the wall watched, but we are stretched thin.",
            "Walk the patrol for me: the south gate, the west corner, then the north postern. See anything strange, you come straight back. Understood?",
          ],
        },
      },
      {
        objective: "Patrol: reach the south gate",
        arrive: { x: 2964, y: 3328, r: 8 },
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "The south gate. Merchants stream in from Port Sarim, guards checking carts. All quiet — but you notice fresh bootprints veering off the road toward the wilderness.",
          ],
        },
      },
      {
        objective: "Patrol: reach the west corner",
        arrive: { x: 2932, y: 3378, r: 8 },
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "The west corner. Below, the rooftops of Falador gleam white in the sun. A crow watches you from the parapet — then startles skyward at something moving in the treeline far below.",
          ],
        },
      },
      {
        objective: "Patrol: reach the north postern, then return to Sir Theodore",
        arrive: { x: 2968, y: 3382, r: 10 },
        dialogue: {
          speaker: "Sir Theodore",
          title: "White Knight",
          lines: [
            "Back in one piece. Report?",
            "Bootprints off the south road and movement in the western treeline... Yes. That matches what our scouts have whispered — the Kinshra are probing, testing our watch.",
            "You did well. Falador's walls have stood a thousand years because ordinary folk walk them with their eyes open.",
            "Sir Amik may steward the city and the prince may hold Burthorpe, but it is people like you who hold the wall. Remember that.",
          ],
        },
      },
      {
        objective: "Quest complete",
        dialogue: {
          speaker: "Sir Theodore",
          title: "White Knight",
          lines: [
            "Take this, with the thanks of the White Knights. If the Kinshra come, you'll want steel that holds an edge.",
            "The white walls raised you now. Make them proud.",
          ],
        },
      },
    ],
    rewards: {
      items: [["COINS", 40]],
      xp: [["DEFENCE", 150]],
      message: "The White Knights nod to you as one of their own.",
    },
  },
  // ------------------------------------------------------------------
  {
    id: "kandarin-starter",
    originId: "kandarin",
    name: "The Market and the Lie",
    blurb: "A trader's errand to the west wall — and a whisper that changes everything.",
    stages: [
      {
        objective: "Meet Trader Elena at the East Ardougne market",
        arrive: { x: 2663, y: 3305, r: 10 },
        dialogue: {
          speaker: "Trader Elena",
          title: "Silk trader",
          lines: [
            "Psst. You look like someone who can walk without being noticed. I have a proposition.",
            "Two bolts of silk, delivered to my contact by the west wall. No questions at the gate, no names spoken aloud. The palace watches the market these days — King Lathas's men, you understand.",
            "Twenty coins for the run. What do you say?",
          ],
        },
      },
      {
        objective: "Deliver the silk to the contact by the west wall",
        arrive: { x: 2545, y: 3305, r: 12 },
        dialogue: {
          speaker: "Hooded Contact",
          title: "???",
          lines: [
            "Elena's silk. Good. You're new — so I'll tell you what no one in the east dares say aloud.",
            "There is no plague in West Ardougne. There never was. The wall isn't holding sickness in — it's holding the truth out. My sister lives behind that wall. She's healthier than you.",
            "The palace lies, and the city starves for the truth. Remember who told you first.",
          ],
        },
      },
      {
        objective: "Decide what to do with what you heard",
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "Back in the east market, a palace guard is questioning traders about 'seditious whispers'. You could tell him what the contact said — or keep the secret.",
          ],
          choices: [
            { text: "Report the contact to the palace guard", goto: 3 },
            { text: "Keep the secret. Some truths aren't yours to trade.", goto: 4 },
          ],
        },
      },
      {
        objective: "Speak with the palace guard",
        next: "complete",
        dialogue: {
          speaker: "Palace Guard",
          title: "King Lathas's guard",
          lines: [
            "A hooded figure by the west wall, spreading lies about the plague? We'll look into it. The crown rewards loyalty, citizen.",
            "Still... between you and me? I've stood that wall ten years. Never seen a single plague cart come out of it. Curious, that.",
            "Forget I said anything.",
          ],
        },
      },
      {
        objective: "Return to Trader Elena",
        arrive: { x: 2663, y: 3305, r: 10 },
        dialogue: {
          speaker: "Trader Elena",
          title: "Silk trader",
          lines: [
            "Delivered, and discreet. You're a natural, friend.",
            "Ardougne runs on two currencies: coin, and knowing which truths to carry and which to bury. You've just made your first deposit of the second kind.",
            "The market is loud and the palace is quiet, and both are lying about something. Walk carefully — and profitably.",
          ],
        },
      },
    ],
    rewards: {
      items: [["COINS", 60]],
      xp: [["AGILITY", 150]],
      message: "You understand Ardougne a little better now.",
    },
  },
  // ------------------------------------------------------------------
  {
    id: "morytania-starter",
    originId: "morytania",
    name: "Keep Your Head Down",
    blurb: "A night errand through Darkmeyer. The vyres watch from the spires.",
    stages: [
      {
        objective: "Speak with Elder Vas in Darkmeyer",
        arrive: { x: 3605, y: 3368, r: 8 },
        dialogue: {
          speaker: "Elder Vas",
          title: "Keeper of the tithe rolls",
          lines: [
            "Another mouth the vyres haven't counted yet. Good — the uncounted are useful.",
            "My sister keeps the garlic stores on the far side of the district. The tithe collectors took her escort, and she cannot cross alone after dark. You will carry this garlic to her.",
            "Rules: stay to the shadows, do not run — running draws the eye — and if a vyre looks at you, you bow your head and keep walking. Understand?",
          ],
        },
      },
      {
        objective: "Carry the garlic across the district — stay calm, don't run",
        arrive: { x: 3618, y: 3352, r: 8 },
        dialogue: {
          speaker: "Sister Maren",
          title: "Keeper of the garlic stores",
          lines: [
            "Vas sent you? Then Vas is a fool — but a kind one. Come inside, quickly.",
            "You walked well. Most newcomers panic at the first shadow on the spires.",
            "Listen: the Myreque whispers in cellars like this one. If the tithe ever takes someone you love, remember that name. Now take the back way home — and keep your garlic close.",
          ],
        },
      },
      {
        objective: "Return to Elder Vas by the back ways",
        arrive: { x: 3605, y: 3368, r: 8 },
        dialogue: {
          speaker: "Elder Vas",
          title: "Keeper of the tithe rolls",
          lines: [
            "Back with a whole skin. You have the makings of a survivor, child of Darkmeyer.",
            "This is our life under the vyre heel: small errands, bowed heads, and the quiet knowledge that we endure. The tithe grows heavier every season — but so does the whisper network.",
            "Keep your head down. Keep your garlic close. And remember who your people are.",
          ],
        },
      },
    ],
    rewards: {
      items: [["COINS", 30], ["GARLIC", 3]],
      xp: [["HITPOINTS", 150]],
      message: "You survived your first night errand in Darkmeyer.",
    },
  },
  // ------------------------------------------------------------------
  {
    id: "keldagrim-starter",
    originId: "keldagrim",
    name: "The Company's Price",
    blurb: "The forge needs coal. The Consortium wants your loyalty. Choose.",
    stages: [
      {
        objective: "Speak with Forge-master Donal",
        arrive: { x: 2860, y: 10170, r: 10 },
        dialogue: {
          speaker: "Forge-master Donal",
          title: "Master of the east forge",
          lines: [
            "You! Aye, you with the unscarred hands. The forge eats coal faster than the carts bring it, and my haulers are down with the tunnel cough.",
            "The coal carts are staged just up by the forge. Walk up, load what you can carry, walk back. Simple work — the mountain respects simple work.",
            "Mind the Consortium men sniffing about. They own the shafts, they think they own the smiths too.",
          ],
        },
      },
      {
        objective: "Fetch coal from the carts by the forge",
        arrive: { x: 2862, y: 10173, r: 8 },
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "The coal carts groan under black rock. You load your arms with as much as you can carry. Your hands will remember this day.",
          ],
        },
      },
      {
        objective: "A Consortium agent stops you on the way back",
        dialogue: {
          speaker: "Agent Forgl",
          title: "Consortium factor",
          lines: [
            "Strong back, newcomer. The Consortium always has work for strong backs — and pays in real coin, not forge-master's promises.",
            "One small thing: when Donal asks who delayed his coal, you never saw me. Do that, and there's twenty coins in it for you right now. Refuse, and... well. The mountain is cold to the ungrateful.",
          ],
          choices: [
            { text: "Refuse. 'Donal's coal is Donal's.'", goto: 3 },
            { text: "Take the twenty coins and lie to Donal", goto: 4 },
          ],
        },
      },
      {
        objective: "Return the coal to Forge-master Donal",
        next: "complete",
        arrive: { x: 2860, y: 10170, r: 10 },
        dialogue: {
          speaker: "Forge-master Donal",
          title: "Master of the east forge",
          lines: [
            "Coal, and honest. Forgl's been buying backs all month — I can always tell which ones he got to. They don't meet my eye.",
            "You did. That means something down here, where eight companies play at kings and the forges never cool.",
            "The mountain respects simple work and straight spines. You'll do, lad. You'll do.",
          ],
        },
      },
      {
        objective: "Return to Forge-master Donal",
        arrive: { x: 2860, y: 10170, r: 10 },
        dialogue: {
          speaker: "Forge-master Donal",
          title: "Master of the east forge",
          lines: [
            "Back at last — and what's this? You won't meet my eye either.",
            "Aye. Forgl got to you. Twenty coins for a lie. The Consortium counts its coins while the mountain counts its dead — and now you're in their ledger.",
            "The coal's here, so the work's done. But lad... the forges remember who stands straight. Think on that.",
          ],
        },
      },
    ],
    rewards: {
      items: [["COINS", 45]],
      xp: [["SMITHING", 150]],
      message: "The forges of Keldagrim know your name now.",
    },
  },
  // ------------------------------------------------------------------
  {
    id: "wanderer-starter",
    originId: "wanderer",
    name: "The Road Itself",
    blurb: "No walls raised you. Prove the road provides.",
    stages: [
      {
        objective: "Speak with Old Marla at Edgeville",
        arrive: { x: 3092, y: 3528, r: 10 },
        dialogue: {
          speaker: "Old Marla",
          title: "Keeper of the edge",
          lines: [
            "Another stray washed up at the edge of the wild. Sit, sit — Marla's seen a thousand like you.",
            "No walls raised you, no banner claims you. That means no one feeds you either. The road provides — but only to those who work it.",
            "Prove it to me, and prove it to yourself: chop a log from the trees nearby, and catch a shrimp from the river. Hands, not hope. Go on.",
          ],
        },
      },
      {
        objective: "Chop a log from a nearby tree (check your inventory)",
        task: { type: "item", item: "LOGS", amount: 1, verb: "chop" },
        dialogue: null,
      },
      {
        objective: "Catch a shrimp from the river (check your inventory)",
        task: { type: "item", item: "RAW_SHRIMPS", amount: 1, verb: "catch" },
        dialogue: null,
      },
      {
        objective: "Return to Old Marla",
        arrive: { x: 3092, y: 3528, r: 10 },
        dialogue: {
          speaker: "Old Marla",
          title: "Keeper of the edge",
          lines: [
            "Log and shrimp. Hands, not hope — just as I said.",
            "You see? The road provides. Gielinor doesn't care where you're from, and neither do I. What matters is what you do with the next sunrise.",
            "Go on, then. The wild is waiting, and it's kinder to those who've already fed themselves once.",
          ],
        },
      },
    ],
    rewards: {
      items: [["COINS", 25], ["COOKED_MEAT", 2]],
      xp: [["WOODCUTTING", 100], ["FISHING", 100]],
      message: "The road is yours. Make it count.",
    },
  },
];

const BY_ID = new Map(STARTER_QUESTS.map((q) => [q.id, q]));
const BY_ORIGIN = new Map(STARTER_QUESTS.map((q) => [q.originId, q]));

module.exports = { STARTER_QUESTS, BY_ID, BY_ORIGIN };
