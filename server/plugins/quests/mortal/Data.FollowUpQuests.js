"use strict";

/**
 * Data.FollowUpQuests — second-tier Mortal Age quests.
 *
 * These give players something to do after their starter quest. Each is
 * 6-8 stages (~20-30 minutes), tied to the living world: real citizens
 * (bound at quest start to online bots), active wars, the market economy.
 *
 * Extensions over the starter-quest schema:
 *   requires      — array of quest ids; ANY of them complete unlocks this.
 *   requiresWar   — only startable while the player's kingdom is in an
 *                   active war (checked via KingdomStore.getActiveWars).
 *   bindCitizens  — [{ var, role, fallback }]; at quest start each var is
 *                   bound to the username of an online citizen of the
 *                   player's kingdom with that role (random pick), or the
 *                   fallback name when none is online. Use {var} in any
 *                   objective / speaker / title / line / choice text.
 *   arrive.site   — symbolic kingdom site ("square", "market", "tavern",
 *                   "bank", "court", "work", "patrol") resolved per-player
 *                   through CitizenSites, so one quest def works for every
 *                   kingdom. (Patrol resolves to the first patrol point.)
 *   persistVars   — attribute vars persisted for this quest
 *                   (quest.<id>.var.<name>).
 *   choices[].set — { varName: value } written when the choice is picked.
 *   stage.rewards — overrides quest-level rewards when the quest completes
 *                   from this stage (for branching endings).
 *   onComplete    — { standing, befriend: [vars], journal: [{ for, text }] }
 *                   applied at completion. {player} is also substitutable.
 *
 * Built-in substitution vars (resolved at display/effect time, not stored):
 *   {player}   — the player's username
 *   {kingdom}  — the player's kingdom display name
 *   {enemy}    — the opposing kingdom's name (war quests; "" otherwise)
 */

const STARTER_IDS = [
  "misthalin-starter",
  "asgarnia-starter",
  "kandarin-starter",
  "morytania-starter",
  "keldagrim-starter",
  "wanderer-starter",
];

const FOLLOW_UP_QUESTS = [
  // ------------------------------------------------------------------
  {
    id: "a-debt-of-honour",
    name: "A Debt of Honour",
    blurb: "{citizen} needs help — a lender's collector is coming at dusk.",
    requires: STARTER_IDS,
    bindCitizens: [
      { var: "citizen", role: "commoner", fallback: "Mira" },
      { var: "sibling", role: "commoner", fallback: "Jor" },
    ],
    persistVars: ["citizen", "sibling", "standing"],
    stages: [
      {
        objective: "Find {citizen} in the town square — they sent word they need help",
        arrive: { site: "square", r: 10 },
        dialogue: {
          speaker: "{citizen}",
          title: "Worried commoner",
          lines: [
            "{player}, thank the gods. I didn't know who else to ask.",
            "My {sibling} — fool that they are — borrowed two hundred coins from Vex the lender. The collector comes at dusk, and we don't have it.",
            "Please. You're the only one in this city who's ever lifted a finger for the likes of us.",
          ],
        },
      },
      {
        objective: "Confront Vex's collector at the market",
        arrive: { site: "market", r: 10 },
        dialogue: {
          speaker: "Vex's Collector",
          title: "Debt collector",
          lines: [
            "Two hundred coins. By dusk. Vex doesn't do extensions, and Vex doesn't do excuses.",
            "You vouching for these gutter rats? Then the debt's yours to answer for. What's it going to be?",
          ],
          choices: [
            { text: "I'll pay the two hundred myself.", goto: 2 },
            { text: "'They owe you nothing. Walk away.'", goto: 4 },
          ],
        },
      },
      {
        objective: "Pay Vex's collector 200 coins (check your inventory)",
        task: { type: "item", item: "COINS", amount: 200, verb: "pay" },
        dialogue: null,
      },
      {
        objective: "Return to {citizen} in the square",
        arrive: { site: "square", r: 10 },
        dialogue: {
          speaker: "{citizen}",
          title: "Worried commoner",
          lines: [
            "You paid it. All of it. I... I don't know what to say.",
            "{sibling} is already packing to leave the city for a while — shame does that. But they'll come back, and they'll remember who saved this family.",
            "If you ever need anything — anything at all — you come to us first.",
          ],
        },
      },
      {
        objective: "Face the collector at the tavern at dusk",
        arrive: { site: "tavern", r: 10 },
        dialogue: {
          speaker: "Vex's Collector",
          title: "Debt collector",
          lines: [
            "The tavern. How cozy. Come to beg after all?",
            "Dusk is coming, friend. The coins, or I start collecting in other ways.",
          ],
          choices: [
            { text: "Stand your ground. 'The debt dies tonight.'", goto: 5 },
            { text: "Back down — you'll find the coins.", goto: 2, set: { standing: "reluctant" } },
          ],
        },
      },
      {
        objective: "The standoff — hold your nerve",
        dialogue: {
          speaker: "Vex's Collector",
          title: "Debt collector",
          lines: [
            "...You've got iron in you, I'll give you that. And a name people are starting to know.",
            "Vex doesn't want a war over two hundred coins. Tell the rats the debt is forgiven — this once. If I see them near a lender again, I take the fingers first.",
          ],
        },
      },
      {
        objective: "Bring the good news to {citizen}",
        arrive: { site: "square", r: 10 },
        dialogue: {
          speaker: "{citizen}",
          title: "Worried commoner",
          lines: [
            "It's over? Just like that? {player}, you're either the bravest soul in {kingdom} or the maddest.",
            "{sibling} cried when I told them. Actual tears. You didn't just save our coins — you saved our name.",
          ],
        },
      },
    ],
    rewards: {
      items: [["COINS", 120]],
      xp: [["DEFENCE", 250]],
      message: "{citizen} and {sibling} will remember this.",
    },
    onComplete: {
      standing: "honour-bound",
      befriend: ["citizen", "sibling"],
      journal: [
        {
          for: "citizen",
          text: "{player} stood up to Vex's collector for my family. I owe them everything — they are a true friend.",
        },
        {
          for: "sibling",
          text: "{player} saved me from Vex's collector. I won't forget it.",
        },
      ],
    },
  },
  // ------------------------------------------------------------------
  {
    id: "for-the-kingdom",
    name: "For the Kingdom",
    blurb: "War has come to {kingdom}. The crown is calling.",
    requires: STARTER_IDS,
    requiresWar: true,
    bindCitizens: [],
    persistVars: ["enemy", "standing"],
    stages: [
      {
        objective: "Report to the Quartermaster in the town square",
        arrive: { site: "square", r: 10 },
        dialogue: {
          speaker: "Quartermaster",
          title: "Crown quartermaster",
          lines: [
            "War, {player}. {enemy} moves against us, and the muster rolls are thinner than I'd like.",
            "I need three things: coin for the war chest, eyes on the patrol road, and a strong arm to stand a watch. You're already here — that counts as volunteering.",
          ],
        },
      },
      {
        objective: "Donate 200 coins to the war chest (check your inventory)",
        task: { type: "item", item: "COINS", amount: 200, verb: "donate" },
        dialogue: null,
      },
      {
        objective: "Scout the patrol road",
        arrive: { site: "patrol", r: 12 },
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "The patrol road. Fresh tracks — too many boots, moving too fast for merchants. {enemy} scouts, or your name isn't {player}.",
            "You memorize the details: numbers, direction, the grey cloak one of them wore. The Quartermaster will want all of it.",
          ],
        },
      },
      {
        objective: "Report to the Muster Sergeant",
        arrive: { site: "court", r: 10 },
        dialogue: {
          speaker: "Muster Sergeant",
          title: "Muster sergeant",
          lines: [
            "So you're the volunteer. The road needs swords on patrol, and the gate needs shields that don't flinch. Choose.",
          ],
          choices: [
            { text: "Join the road patrol.", goto: 4 },
            { text: "Hold the gate.", goto: 5 },
          ],
        },
      },
      {
        objective: "Walk the road patrol",
        arrive: { site: "patrol", r: 12 },
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "Four hours on the road. Cold, quiet — and twice you were sure you saw movement that wasn't there.",
            "The third time, it was there: a scout, who saw you seeing them and melted back into the trees. They know we're watching now. That's the whole point.",
          ],
        },
      },
      {
        objective: "Stand the gate watch",
        arrive: { site: "court", r: 10 },
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "The gate watch. Torchlight, boredom, and one false alarm when a merchant's cart lost a wheel.",
            "Boring is good. Boring means {enemy} didn't try the gate tonight.",
          ],
        },
      },
      {
        objective: "Return to the Quartermaster",
        arrive: { site: "square", r: 10 },
        dialogue: {
          speaker: "Quartermaster",
          title: "Crown quartermaster",
          lines: [
            "Coin, eyes, and a steady arm. The crown asked for three things and got all three.",
            "Take this badge. Wear it where people can see it. Let them know that when {kingdom} called, you answered.",
          ],
        },
      },
    ],
    rewards: {
      items: [["PALADINS_BADGE", 1], ["COINS", 150]],
      xp: [["ATTACK", 300], ["DEFENCE", 300]],
      message: "You answered when {kingdom} called.",
    },
    onComplete: {
      standing: "sworn-defender",
      befriend: [],
      journal: [],
    },
  },
  // ------------------------------------------------------------------
  {
    id: "rivals-in-trade",
    name: "Rivals in Trade",
    blurb: "{merchant} is being ruined by a rival's lies. They need someone discreet.",
    requires: STARTER_IDS,
    bindCitizens: [{ var: "merchant", role: "merchant", fallback: "Sella" }],
    persistVars: ["merchant", "standing"],
    stages: [
      {
        objective: "Find {merchant} at the market — they've asked for a discreet word",
        arrive: { site: "market", r: 10 },
        dialogue: {
          speaker: "{merchant}",
          title: "Market trader",
          lines: [
            "{player}. A word — quietly. You remember me? Good. I need someone with no stake in market gossip.",
            "Burr, two stalls down, is selling at a loss to starve me out. And now there's talk my goods are stolen. Cursed, even. My regulars are vanishing.",
            "Find out where the talk is coming from. Please — be discreet.",
          ],
        },
      },
      {
        objective: "Ask around the square about Burr's rumors",
        arrive: { site: "square", r: 10 },
        dialogue: {
          speaker: "Old Shopper",
          title: "Market regular",
          lines: [
            "Burr's lies? Oh, I've heard them. Everyone's heard them — that's rather the point, isn't it?",
            "Do I believe them? Love, I've bought {merchant}'s cloth for twenty years. But fear is cheaper than loyalty, and Burr's prices... well.",
          ],
        },
      },
      {
        objective: "Have a drink at the tavern and listen",
        arrive: { site: "tavern", r: 10 },
        dialogue: {
          speaker: "Drunk Sailor",
          title: "Loose tongue",
          lines: [
            "Burr? Aye, Burr paid me ten coins to tell the cursed-goods story in every tavern from here to the docks. Ten coins! For talking!",
            "You're not going to tell {merchant}, are you? ...You're going to tell {merchant}. Fair enough. Tell them Sal sends his regards and his apologies.",
          ],
        },
      },
      {
        objective: "Confront Burr at the market",
        arrive: { site: "market", r: 10 },
        dialogue: {
          speaker: "Burr",
          title: "Rival trader",
          lines: [
            "Well, well. {merchant}'s little errand-runner. Come to beg for mercy pricing?",
            "I've got nothing to hide. The market decides who thrives — and the market has decided.",
          ],
          choices: [
            { text: "Expose him — tell the market about Sal.", goto: 4 },
            { text: "Blackmail him — a cut of his profits, or Sal talks.", goto: 5 },
            { text: "Broker peace — there's room for two stalls.", goto: 6 },
          ],
        },
      },
      {
        objective: "The market hears the truth",
        dialogue: {
          speaker: "{merchant}",
          title: "Market trader",
          lines: [
            "You did it. You actually did it. Sal stood up in the square and told everyone — Burr's face, {player}, I will remember it forever.",
            "The market respects an honest trader who fights clean. Take this — it's been in my family for years, and I want you to have it.",
          ],
        },
        rewards: {
          items: [["AMULET_OF_GLORY", 1], ["COINS", 80]],
          xp: [["CRAFTING", 250]],
          message: "The market respects an honest trader who fights clean.",
        },
      },
      {
        objective: "Burr pays for silence",
        dialogue: {
          speaker: "{merchant}",
          title: "Market trader",
          lines: [
            "Fifty coins a week, Burr. Sal stays quiet, the rumors stop, and we all prosper. That's the deal you made — I just watched you make it.",
            "You're colder than I thought, {player}. I mean that as a compliment. Mostly.",
          ],
        },
        rewards: {
          items: [["COINS", 400]],
          xp: [["THIEVING", 250]],
          message: "Everyone prospers. Nobody asks how.",
        },
      },
      {
        objective: "Two stalls, one market",
        dialogue: {
          speaker: "{merchant}",
          title: "Market trader",
          lines: [
            "Two stalls, one market, no lies. Burr agreed — and I think he was relieved, honestly. The price war was bleeding him too.",
            "You could have ruined him, and instead you made us both richer. That's rarer than gold, {player}.",
          ],
        },
        rewards: {
          items: [["AMULET_OF_GLORY", 1], ["COINS", 150]],
          xp: [["CRAFTING", 250]],
          message: "Peace is rarer than gold.",
        },
      },
    ],
    rewards: {
      items: [["COINS", 100]],
      xp: [["CRAFTING", 150]],
      message: "The market will remember this.",
    },
    onComplete: {
      standing: "market-player",
      befriend: ["merchant"],
      journal: [
        {
          for: "merchant",
          text: "{player} dealt with Burr and saved my stall. I trust them with my livelihood — and my friendship.",
        },
      ],
    },
  },
  // ------------------------------------------------------------------
  {
    id: "the-empty-chair",
    name: "The Empty Chair",
    blurb: "{friend} hasn't seen {missing} in three days. Find them.",
    requires: STARTER_IDS,
    bindCitizens: [
      { var: "friend", role: "commoner", fallback: "Tilda" },
      { var: "missing", role: "commoner", fallback: "Bram" },
    ],
    persistVars: ["friend", "missing", "standing"],
    stages: [
      {
        objective: "Find {friend} at the tavern",
        arrive: { site: "tavern", r: 10 },
        dialogue: {
          speaker: "{friend}",
          title: "Worried friend",
          lines: [
            "{player}, I'm glad you're here. It's {missing} — three days, no word. Their chair's been empty every night since.",
            "They wouldn't just leave. Not without telling me. Something's wrong, I can feel it.",
          ],
        },
      },
      {
        objective: "Check the work site — ask the foreman",
        arrive: { site: "work", r: 10 },
        dialogue: {
          speaker: "Foreman",
          title: "Shift foreman",
          lines: [
            "{missing}? Walked off mid-shift three days back. Took their tools, took their pay satchel, headed toward the bank like the hounds were after them.",
            "Good worker. Whatever pulled them away, it pulled hard.",
          ],
        },
      },
      {
        objective: "Ask at the bank",
        arrive: { site: "bank", r: 10 },
        dialogue: {
          speaker: "Bank Clerk",
          title: "Counting-house clerk",
          lines: [
            "Three days ago, yes. Withdrew everything — every last coin. Said something about 'the road' and smiled like someone finally let out of a cage.",
            "Didn't look scared, friend. Looked... decided.",
          ],
        },
      },
      {
        objective: "Ask traders at the market",
        arrive: { site: "market", r: 10 },
        dialogue: {
          speaker: "Trader",
          title: "Travel outfitter",
          lines: [
            "Rations, a bedroll, a good knife — paid in full, no haggling. I asked where they were headed and they just said 'wherever the road goes.'",
            "They weren't running FROM something, if that's what you're thinking. They were running TO something.",
          ],
        },
      },
      {
        objective: "Search the square — someone must have seen",
        arrive: { site: "square", r: 10 },
        dialogue: {
          speaker: "Street Kid",
          title: "Sharp eyes",
          lines: [
            "Saw them! By the court steps, crying — then they wiped their face and walked out the gates like a whole new person.",
            "Like they'd been carrying something heavy for years and finally set it down.",
          ],
        },
      },
      {
        objective: "Find {missing} — check the patrol road",
        arrive: { site: "patrol", r: 12 },
        dialogue: {
          speaker: "{missing}",
          title: "Found, at last",
          lines: [
            "{player}? How did you— {friend} sent you. Of course they did.",
            "I'm not in trouble. I'm just... done. This city had my whole life planned — the marriage, the work, all of it. And I never got a say.",
            "There's a caravan leaving at dawn. Real work, far from here, nobody telling me who to be. Tell me honestly, {player} — do I go back?",
          ],
          choices: [
            { text: "Convince them to come home — {friend} is worried sick.", goto: 6 },
            { text: "Give them your blessing for the road.", goto: 7 },
          ],
        },
      },
      {
        objective: "Walk {missing} home",
        arrive: { site: "tavern", r: 10 },
        dialogue: {
          speaker: "{friend}",
          title: "Worried friend",
          lines: [
            "They're home. They're actually home. {missing} walked through that door an hour ago and I cried like a child.",
            "They say you talked sense into them. I say you reminded them what home means. Either way — thank you, {player}. Thank you.",
          ],
        },
        rewards: {
          items: [["COINS", 100]],
          xp: [["HITPOINTS", 250]],
          message: "Home is where someone waits up for you.",
        },
      },
      {
        objective: "Say farewell on the patrol road",
        dialogue: {
          speaker: "{missing}",
          title: "Found, at last",
          lines: [
            "Your blessing. That's all I wanted, {player} — someone to say it's alright to choose.",
            "{friend} will understand. Eventually. Tell them I love them — and tell them I'm finally going to be someone I chose.",
          ],
        },
        rewards: {
          items: [["COINS", 75]],
          xp: [["AGILITY", 250]],
          message: "Some roads only go one way.",
        },
      },
    ],
    rewards: {
      items: [["COINS", 50]],
      xp: [["HITPOINTS", 150]],
      message: "You found {missing}.",
    },
    onComplete: {
      standing: "truth-keeper",
      befriend: ["friend", "missing"],
      journal: [
        {
          for: "friend",
          text: "{player} helped me find {missing}. I won't forget it — not ever.",
        },
        {
          for: "missing",
          text: "{player} found me on the patrol road and listened. I trust them.",
        },
      ],
    },
  },
];

const BY_ID = new Map(FOLLOW_UP_QUESTS.map((q) => [q.id, q]));

module.exports = { FOLLOW_UP_QUESTS, BY_ID, STARTER_IDS };
