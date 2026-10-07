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
        next: "complete",
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
        next: 6,
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
        next: "complete",
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
        next: "complete",
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
        next: "complete",
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
        next: "complete",
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
  // ------------------------------------------------------------------
  // MYSTERY: a locked stall emptied overnight, the lock unbroken.
  {
    id: "the-hollow-crate",
    name: "The Hollow Crate",
    blurb: "{merchant}'s locked stall was emptied overnight — and the lock was never broken.",
    requires: STARTER_IDS,
    bindCitizens: [
      { var: "merchant", role: "merchant", fallback: "Sella" },
      { var: "apprentice", role: "commoner", fallback: "Pip" },
    ],
    persistVars: ["merchant", "apprentice", "standing"],
    stages: [
      {
        objective: "Find {merchant} at the market — their stall was robbed overnight",
        arrive: { site: "market", r: 10 },
        dialogue: {
          speaker: "{merchant}",
          title: "Robbed trader",
          lines: [
            "{player}. Thank the gods — someone with a clear head. Look at this.",
            "My stall, emptied in the night. Every bolt of cloth, every ingot — gone. And the lock? Untouched. Not forced, not picked that I can see. Just... opened.",
            "The watch laughed at me. Said I probably forgot to lock up. I did not forget. Find out how they got in — please.",
          ],
        },
      },
      {
        objective: "Ask around the square — someone sees everything in this city",
        arrive: { site: "square", r: 10 },
        dialogue: {
          speaker: "Street Kid",
          title: "Sharp eyes",
          lines: [
            "The market, last night? Aye, I saw someone. Had a key, not a crowbar — turned it like they owned the place.",
            "Couldn't see the face, hood up. But they walked like someone trying not to be noticed, which is the most noticeable walk there is.",
            "Check the tavern. Everyone with a secret drinks it away eventually.",
          ],
        },
      },
      {
        objective: "Have a drink at the tavern and listen for loose tongues",
        arrive: { site: "tavern", r: 10 },
        dialogue: {
          speaker: "Drunk Sailor",
          title: "Loose tongue",
          lines: [
            "The hollow crate, eh? Heard about that. You know who I saw near the market after dark? Young {apprentice}. {merchant}'s own apprentice.",
            "Looked sick about something, they did. Kept checking over their shoulder like the night itself was following them.",
            "Don't tell them I told you. I was never here. I am never anywhere, that's my whole philosophy.",
          ],
        },
      },
      {
        objective: "Confront {apprentice} at the work site",
        arrive: { site: "work", r: 10 },
        dialogue: {
          speaker: "{apprentice}",
          title: "The apprentice",
          lines: [
            "No — please. Don't tell {merchant}. Not yet. Let me explain.",
            "I owed money. Dice, mostly — I'm an idiot, I know it. The lender said they'd take my sister's dowry instead of my fingers. So I... I took the key. I emptied the stall and sold it all before dawn.",
            "{merchant} took me in off the street. And I robbed them. Say what you want about me — just tell me what happens now.",
          ],
          choices: [
            { text: "Expose them — {merchant} deserves the truth.", goto: 4 },
            { text: "Cover for them — you'll help make it right quietly.", goto: 5 },
          ],
        },
      },
      {
        objective: "Tell {merchant} the truth at the market",
        next: "complete",
        arrive: { site: "market", r: 10 },
        dialogue: {
          speaker: "{merchant}",
          title: "Robbed trader",
          lines: [
            "{apprentice}? My {apprentice}? ...I wondered. They've been hollow-eyed for weeks.",
            "It hurts worse than the theft, {player} — knowing they didn't trust me enough to ask for help. But thank you for the truth. A clean wound heals; a hidden one festers.",
            "The stall will be restocked by week's end. And {apprentice} will work off every coin — in daylight, where I can see them.",
          ],
        },
        rewards: {
          items: [["COINS", 150]],
          xp: [["THIEVING", 300]],
          message: "The truth hurt, but it healed.",
        },
      },
      {
        objective: "Help {apprentice} repay the debt quietly",
        next: "complete",
        task: { type: "item", item: "COINS", amount: 150, verb: "pay" },
        dialogue: {
          speaker: "{apprentice}",
          title: "The apprentice",
          lines: [
            "It's done. The lender's paid, the debt's dead, and {merchant} never has to know their apprentice is a thief.",
            "I'll restock that stall myself, crate by crate, and {merchant} will just think trade is good. You... you saved two people today, {player}. Me, and the person {merchant} thinks I am.",
          ],
        },
        rewards: {
          items: [["COINS", 60]],
          xp: [["THIEVING", 300]],
          message: "Some debts are paid in silence.",
        },
      },
    ],
    rewards: {
      items: [["COINS", 100]],
      xp: [["THIEVING", 200]],
      message: "The hollow crate is full again.",
    },
    onComplete: {
      standing: "truth-keeper",
      befriend: ["merchant", "apprentice"],
      journal: [
        {
          for: "merchant",
          text: "{player} solved the robbery of my stall. I can trust them with the truth — and with my livelihood.",
        },
        {
          for: "apprentice",
          text: "{player} knows what I did and chose mercy. I owe them my life, and I'll spend it earning that back.",
        },
      ],
    },
  },
  // ------------------------------------------------------------------
  // TRADE: impossibly cheap goods are ruining an honest crafter.
  {
    id: "coin-of-the-realm",
    name: "Coin of the Realm",
    blurb: "{crafter}'s livelihood is being undercut by goods that shouldn't exist at these prices.",
    requires: STARTER_IDS,
    bindCitizens: [{ var: "crafter", role: "merchant", fallback: "Dunna" }],
    persistVars: ["crafter", "standing"],
    stages: [
      {
        objective: "Find {crafter} at the market — they've asked for help",
        arrive: { site: "market", r: 10 },
        dialogue: {
          speaker: "{crafter}",
          title: "Struggling crafter",
          lines: [
            "{player}, look at this. A competitor two rows down is selling finished blades for less than my raw steel costs.",
            "That's not trade, that's sorcery — or theft. Nobody forges at those prices and eats. Someone is flooding this market with goods that shouldn't exist.",
            "Find out where they're coming from. My family has worked this market for three generations, and I won't watch it die to a cheat.",
          ],
        },
      },
      {
        objective: "Ask shoppers in the square about the cheap goods",
        arrive: { site: "square", r: 10 },
        dialogue: {
          speaker: "Old Shopper",
          title: "Market regular",
          lines: [
            "The cheap blades? Aye, everyone's buying them. Half the price, and they look fine — for now.",
            "Ask me in a year when they snap. But folk don't think in years when their purse is light today.",
            "The seller never talks about where they come from. Just smiles. I don't trust a smiling merchant, love — smiles are how they hide the counting.",
          ],
        },
      },
      {
        objective: "Have a drink at the tavern — sailors hear everything",
        arrive: { site: "tavern", r: 10 },
        dialogue: {
          speaker: "Drunk Sailor",
          title: "Loose tongue",
          lines: [
            "Cheap steel? Aye, I know that ship. Unloads at night, no manifest, no harbourmaster's stamp. Pays in coin that smells of fish and lies.",
            "They bring the crates to the old warehouse by the work yards. You didn't hear it from me — I was never here, I am never anywhere.",
          ],
        },
      },
      {
        objective: "Investigate the warehouse by the work site",
        arrive: { site: "work", r: 10 },
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "The warehouse. Crates stacked to the rafters — blades, tools, all unmarked. And there, half-hidden under canvas: the crown's own arsenal stamp, filed off but still readable.",
            "This isn't undercutting. It's fencing. Someone is selling off the {kingdom} armoury, piece by piece, and {crafter}'s honest work is drowning in stolen steel.",
          ],
        },
      },
      {
        objective: "Decide what to do about the smuggled steel",
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "You know the truth now: the cheap goods are stolen from the {kingdom} armoury. The smuggler pays well and asks no questions. {crafter} is going under either way unless something changes.",
          ],
          choices: [
            { text: "Expose the smuggler to the market square.", goto: 5 },
            { text: "Demand a cut — a share of the profits for your silence.", goto: 6 },
            { text: "Help {crafter} compete — find them an honest supplier.", goto: 7 },
          ],
        },
      },
      {
        objective: "Expose the smuggler in the square",
        next: "complete",
        arrive: { site: "square", r: 10 },
        dialogue: {
          speaker: "{crafter}",
          title: "Struggling crafter",
          lines: [
            "You stood up in the square and said it plain — stolen from the armoury itself. The crowd went silent, then angry. The smuggler's stall was empty by dusk.",
            "Prices are already recovering. My hands can compete with any honest forge in {kingdom} — they just couldn't compete with thieves.",
            "You didn't just save my stall, {player}. You saved what this market is supposed to be.",
          ],
        },
        rewards: {
          items: [["STEEL_SWORD", 1], ["COINS", 100]],
          xp: [["SMITHING", 300]],
          message: "Honest work wins — this time.",
        },
      },
      {
        objective: "Take the smuggler's coin",
        next: "complete",
        dialogue: {
          speaker: "Smuggler",
          title: "Unmarked crates",
          lines: [
            "Smart. Very smart. Fifty coins a week, and you never saw a warehouse, never heard a name.",
            "{crafter} will go under by winter. That's the market, friend — the big fish eat, and the clever fish get paid to watch.",
          ],
        },
        rewards: {
          items: [["COINS", 400]],
          xp: [["THIEVING", 300]],
          message: "The market has a new silent partner.",
        },
      },
      {
        objective: "Find {crafter} an honest supplier at the bank",
        next: "complete",
        arrive: { site: "bank", r: 10 },
        dialogue: {
          speaker: "{crafter}",
          title: "Struggling crafter",
          lines: [
            "A direct line to the northern mines — honest steel at honest prices, and you talked them into it. I can match the smuggler's prices now and still sleep at night.",
            "You could have burned the whole market down, {player}. Instead you built something. That's rarer than any blade.",
          ],
        },
        rewards: {
          items: [["COINS", 150]],
          xp: [["CRAFTING", 300]],
          message: "Build, don't burn.",
        },
      },
    ],
    rewards: {
      items: [["COINS", 100]],
      xp: [["CRAFTING", 200]],
      message: "The market remembers.",
    },
    onComplete: {
      standing: "market-player",
      befriend: ["crafter"],
      journal: [
        {
          for: "crafter",
          text: "{player} traced the smuggled steel that was ruining me. Whatever they chose to do about it, they fought for honest trade.",
        },
      ],
    },
  },
  // ------------------------------------------------------------------
  // HUNT: livestock dead at the work site — track the beast.
  {
    id: "the-beast-below",
    name: "The Beast Below",
    blurb: "Something is killing livestock by the work site. {guard} needs a tracker.",
    requires: STARTER_IDS,
    bindCitizens: [{ var: "guard", role: "guard", fallback: "Sergeant Kess" }],
    persistVars: ["guard", "standing"],
    stages: [
      {
        objective: "Find {guard} at the town square",
        arrive: { site: "square", r: 10 },
        dialogue: {
          speaker: "{guard}",
          title: "Worried guard",
          lines: [
            "{player}. Three nights, four dead sheep, and tracks the size of dinner plates by the work yards.",
            "My patrols are stretched thin and the herders are talking about moving their flocks — which means the market goes hungry by winter.",
            "I need someone with good eyes and a steady nerve to track it. That's you, if you'll have it.",
          ],
        },
      },
      {
        objective: "Follow the tracks along the patrol road",
        arrive: { site: "patrol", r: 12 },
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "The tracks. Deep claw marks, a dragging left hind leg — it's hurt. Whatever this beast is, it's hunting because it can't hunt properly anymore.",
            "The trail leads toward the work site. It dens somewhere in the rubble and old foundations.",
          ],
        },
      },
      {
        objective: "Search the rubble at the work site",
        arrive: { site: "work", r: 10 },
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "There — in the shadows between the fallen beams. A dire wolf, ribs showing, one leg mangled in an old poacher's trap. It bares its teeth, but it's too weak to lunge.",
            "And around its neck: a collar. Silverworked, with a noble's crest. This isn't a wild beast. It's someone's escaped hunting hound — starving, in pain, and terrified.",
          ],
        },
      },
      {
        objective: "Decide the beast's fate",
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "The wolf watches you, trembling. {guard} wants it dead — 'a danger to the flocks.' But that collar means someone lost it, and it's suffering more than it's threatening.",
          ],
          choices: [
            { text: "Put it down cleanly — the guard's way.", goto: 4 },
            { text: "Free it from the trap and let it go.", goto: 5 },
            { text: "Find its owner — that crest means a reward.", goto: 6 },
          ],
        },
      },
      {
        objective: "End it cleanly",
        next: "complete",
        dialogue: {
          speaker: "{guard}",
          title: "Worried guard",
          lines: [
            "Done, then. Quick and clean — kinder than the trap was, kinder than starvation would have been.",
            "The herders can sleep tonight. It wasn't the ending anyone wanted, but it was the ending the job needed.",
            "You did the hard thing, {player}. Most people only do the easy ones.",
          ],
        },
        rewards: {
          items: [["WOLF_BONE", 1], ["COINS", 120]],
          xp: [["SLAYER", 300]],
          message: "The hard thing, done well.",
        },
      },
      {
        objective: "Free the wolf",
        next: "complete",
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "You work the trap open slowly, talking low the whole time. The wolf limps free, stares at you for one long moment — and vanishes into the dark.",
            "It might not survive the week. But it will die free, on its own terms, instead of in a cage of pain.",
            "{guard} will call you soft. The herders will call you a fool. You'll know better.",
          ],
        },
        rewards: {
          items: [["COINS", 60]],
          xp: [["HUNTER", 300]],
          message: "Free, on its own terms.",
        },
      },
      {
        objective: "Ask at the tavern about the silver crest",
        next: "complete",
        arrive: { site: "tavern", r: 10 },
        dialogue: {
          speaker: "Noble's Huntsman",
          title: "Crested hunter",
          lines: [
            "The silver crest — that's Lord Corvin's mark! His favourite hound, lost a fortnight ago in the hills. He's offered a hundred coins for its return, no questions.",
            "You found her? Alive? The old lord will weep, {player} — that dog was his late wife's. Take the reward, and take my thanks too.",
          ],
        },
        rewards: {
          items: [["COINS", 250]],
          xp: [["HUNTER", 300]],
          message: "Someone's grief, answered.",
        },
      },
    ],
    rewards: {
      items: [["COINS", 100]],
      xp: [["HUNTER", 200]],
      message: "The flocks are safe.",
    },
    onComplete: {
      standing: "tracker",
      befriend: ["guard"],
      journal: [
        {
          for: "guard",
          text: "{player} tracked the beast that was killing livestock. Steady nerves and good eyes — I'd patrol beside them any night.",
        },
      ],
    },
  },
  // ------------------------------------------------------------------
  // SOCIAL: two old friends, one dead friendship — mediate or pick a side.
  {
    id: "two-chairs-one-table",
    name: "Two Chairs, One Table",
    blurb: "{keeper} watches two empty chairs every night. Two old friends, one silence.",
    requires: STARTER_IDS,
    bindCitizens: [
      { var: "keeper", role: "merchant", fallback: "Bess" },
      { var: "friend1", role: "commoner", fallback: "Tam" },
      { var: "friend2", role: "commoner", fallback: "Wren" },
    ],
    persistVars: ["keeper", "friend1", "friend2", "standing"],
    stages: [
      {
        objective: "Talk to {keeper} at the tavern",
        arrive: { site: "tavern", r: 10 },
        dialogue: {
          speaker: "{keeper}",
          title: "Tavern keeper",
          lines: [
            "See those two chairs? Every night for twenty years, {friend1} and {friend2} sat there. Laughed loud enough to shake the rafters.",
            "Now? Silence. Six months of it. Some business deal went bad — or that's what they tell everyone. Truth is, I think they're both just too proud to say sorry first.",
            "You're new enough to be neutral and trusted enough to be heard. Talk to them. Please.",
          ],
        },
      },
      {
        objective: "Hear {friend1}'s side at the market",
        arrive: { site: "market", r: 10 },
        dialogue: {
          speaker: "{friend1}",
          title: "One half of the silence",
          lines: [
            "{friend2}? After what they did? We pooled everything for a trading venture — my savings, their contacts. Then they pulled out at the last moment without a word.",
            "Left me holding debts I couldn't pay alone. I lost a year of my life to that. And they never even apologized — just acted like it was business.",
            "Twenty years of friendship, {player}. Gone over coin. Tell me I'm wrong to still be angry.",
          ],
        },
      },
      {
        objective: "Hear {friend2}'s side at the bank",
        arrive: { site: "bank", r: 10 },
        dialogue: {
          speaker: "{friend2}",
          title: "The other half",
          lines: [
            "So {friend1} sent you. Of course they did — they've always needed an audience for their grievances.",
            "Here's what they won't tell you: I pulled out because the venture was a trap. My contact was skimming — I'd have lost us both everything. I took the loss quietly to protect them, and they called it betrayal.",
            "I couldn't explain without ruining a man's name on suspicion alone. So I said nothing. And lost my oldest friend for it.",
          ],
        },
      },
      {
        objective: "Decide how to mend — or end — this",
        dialogue: {
          speaker: "You",
          title: "",
          lines: [
            "Two stories, both true from the inside. {friend1} was left holding debts. {friend2} took a silent loss to protect them both. Pride did the rest.",
            "{keeper} is waiting. The two chairs are still empty.",
          ],
          choices: [
            { text: "Bring them together at the tavern — tonight.", goto: 4 },
            { text: "Side with {friend1} — {friend2} should have spoken up.", goto: 5 },
            { text: "Tell them both to grow up — walk away.", goto: 6 },
          ],
        },
      },
      {
        objective: "The reunion at the tavern",
        next: "complete",
        arrive: { site: "tavern", r: 10 },
        dialogue: {
          speaker: "{keeper}",
          title: "Tavern keeper",
          lines: [
            "You did it. You actually did it. They talked until dawn — shouting at first, then laughing, then crying a bit, if I'm honest.",
            "The chairs aren't empty anymore, {player}. Twenty years of friendship, back from the dead. This tavern has its soul back.",
            "Drinks are on the house. Forever. I mean that.",
          ],
        },
        rewards: {
          items: [["BREAD", 5], ["COINS", 120]],
          xp: [["COOKING", 200]],
          message: "Two chairs, one table, whole again.",
        },
      },
      {
        objective: "Stand with {friend1}",
        next: "complete",
        dialogue: {
          speaker: "{friend1}",
          title: "One half of the silence",
          lines: [
            "Thank you. For believing me. {friend2} made their choice six months ago — now I've made mine.",
            "It hurts less than I thought it would, having someone finally say I was right to be angry. The chairs stay empty, but at least one of us can sleep.",
          ],
        },
        rewards: {
          items: [["COINS", 150]],
          xp: [["STRENGTH", 200]],
          message: "Loyalty has its price.",
        },
      },
      {
        objective: "Leave them to it",
        next: "complete",
        dialogue: {
          speaker: "{keeper}",
          title: "Tavern keeper",
          lines: [
            "You told them both to grow up? Ha! Maybe you're right. Maybe some silences have to break on their own.",
            "The chairs are still empty, {player}. But you know what? You were honest, and that's rarer than peacemakers in this city.",
          ],
        },
        rewards: {
          items: [["COINS", 80]],
          xp: [["AGILITY", 200]],
          message: "Not every silence is yours to break.",
        },
      },
    ],
    rewards: {
      items: [["COINS", 100]],
      xp: [["COOKING", 150]],
      message: "The tavern keeps its counsel.",
    },
    onComplete: {
      standing: "peacemaker",
      befriend: ["keeper", "friend1", "friend2"],
      journal: [
        {
          for: "keeper",
          text: "{player} tried to mend {friend1} and {friend2}. Whatever happened, this tavern owes them a debt.",
        },
        {
          for: "friend1",
          text: "{player} listened to my side of the feud with {friend2}. Finally, someone heard me out.",
        },
        {
          for: "friend2",
          text: "{player} heard my side of things. Maybe the silence can end.",
        },
      ],
    },
  },
];

const BY_ID = new Map(FOLLOW_UP_QUESTS.map((q) => [q.id, q]));

module.exports = { FOLLOW_UP_QUESTS, BY_ID, STARTER_IDS };
