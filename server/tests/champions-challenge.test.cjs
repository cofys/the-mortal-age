// node --test tests/champions-challenge.test.cjs
// Champions' Challenge (Wiki: Champions' Challenge, Larxus, Champion's scroll): Larxus's transcript
// covers every champion, each champion's rule, the reward conditions, Leon d'Cour's challenge, the
// statue's carry rules and which kills drop a scroll.
const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const DIALOGUES = require("../data/definitions/npc-dialogues.json");
const Common = require("../plugins/minigames/championschallenge/Common.ChampionsChallenge");
const Rules = require("../plugins/minigames/championschallenge/Rules.ChampionsChallenge");
const Larxus = require("../plugins/minigames/championschallenge/Larxus.ChampionsChallenge");
const Rewards = require("../plugins/minigames/championschallenge/Rewards.ChampionsChallenge");
const { QUEST_POINTS_ATTRIBUTE } = require("../plugins/quests/QuestRuntime");

const WEAPON_SLOT = 3;
const CombatType = { MELEE: "melee", RANGED: "ranged", MAGIC: "magic" };
const LAMP = Common.DATA.items.lamp;
const champion = (key) => Common.byKey.get(key);
const bitsOf = (...keys) => keys.reduce((bits, key) => bits | (1 << champion(key).bit), 0);

before(() => {
  Common.init({ core: { CombatType, Equipment: { WEAPON_SLOT } }, emitCustomEvent: () => {} });
});

/** Items are { slot } for what they equip to (-1: nothing). */
const item = (slot) => ({ getDefinition: () => ({ getEquipmentType: () => ({ getSlot: () => slot }) }) });

function player({ defeated = 0, lamps = 0, inventory = [], worn = [], free = 28, questPoints = 32 } = {}) {
  const attributes = {
    [Common.DEFEATED_ATTRIBUTE]: defeated,
    [Common.LAMPS_ATTRIBUTE]: lamps,
    [QUEST_POINTS_ATTRIBUTE]: questPoints,
  };
  const messages = [];
  return {
    messages,
    sendMessage: (text) => messages.push(text),
    getAttribute: (key) => attributes[key],
    setAttribute: (key, value) => { attributes[key] = value; },
    getInventory: () => ({
      contains: (id) => inventory.includes(id),
      getFreeSlots: () => free,
      getValidItems: () => inventory.map((entry) => (typeof entry === "number" ? item(-1) : entry)),
    }),
    getEquipment: () => ({ getValidItems: () => worn }),
  };
}

const larxusVariants = () => Object.keys(DIALOGUES.Larxus.variants);

test("Larxus's transcript has every scroll's rules and every statue refusal the plugin plays", () => {
  const variants = larxusVariants();
  for (const entry of Common.SCROLL_CHAMPIONS) {
    assert.ok(variants.includes(Larxus.scrollVariant(entry)), Larxus.scrollVariant(entry));
  }
  for (const key of ["ghoul", "lesserdemon", "leon"]) {
    const refusal = Rules.entryRefusal(champion(key), player({ inventory: [item(4)] }));
    assert.ok(variants.includes(refusal), `${key}: ${refusal}`);
  }
});

test("each scroll's rule sentence matches the style the plugin enforces", () => {
  const variants = DIALOGUES.Larxus.variants;
  for (const entry of Common.SCROLL_CHAMPIONS) {
    const line = variants[Larxus.scrollVariant(entry)][0].npc;
    const { only, not } = entry.rule;
    if (only) assert.match(line, new RegExp(`only allowed to use ${only} attacks`), entry.key);
    if (not) assert.match(line, new RegExp(`not allowed to use any ${not} attacks`), entry.key);
  }
});

test("style rules refuse the styles a champion forbids, with the captured wording", () => {
  assert.equal(Rules.styleRefusal(champion("giant"), CombatType.MELEE), null);
  assert.equal(Rules.styleRefusal(champion("giant"), CombatType.RANGED), "only allowed to use Melee");
  assert.equal(Rules.styleRefusal(champion("skeleton"), CombatType.MAGIC), "only allowed to use Ranged");
  assert.equal(Rules.styleRefusal(champion("zombie"), CombatType.MAGIC), "not allowed to use Magic");
  assert.equal(Rules.styleRefusal(champion("zombie"), CombatType.RANGED), null);
  assert.equal(Rules.styleRefusal(champion("hobgoblin"), CombatType.MELEE), "not allowed to use Melee");
  assert.equal(Rules.styleRefusal(champion("jogre"), CombatType.RANGED), "not allowed to use Ranged");
  assert.equal(Rules.styleRefusal(champion("imp"), CombatType.MAGIC), null);
});

test("the statue lets in only what each fight allows", () => {
  const weapon = item(WEAPON_SLOT);
  const armour = item(4);
  assert.equal(Rules.entryRefusal(champion("ghoul"), player({ worn: [weapon], inventory: [weapon] })), null);
  assert.ok(Rules.entryRefusal(champion("ghoul"), player({ worn: [weapon, armour] })));
  assert.ok(Rules.entryRefusal(champion("ghoul"), player({ inventory: [6799] })), "the scroll itself is not a weapon");
  assert.equal(Rules.entryRefusal(champion("lesserdemon"), player({ inventory: [item(-1)] })), null);
  assert.ok(Rules.entryRefusal(champion("lesserdemon"), player({ worn: [armour] })));
  assert.ok(Rules.entryRefusal(champion("lesserdemon"), player({ inventory: [weapon] })));
  assert.equal(Rules.entryRefusal(champion("leon"), player({ worn: [weapon, armour] })), null);
  assert.ok(Rules.entryRefusal(champion("leon"), player({ inventory: [item(-1)] })));
  assert.equal(Rules.entryRefusal(champion("giant"), player({ inventory: [6800] })), null);
});

test("'Have you any rewards for me?' follows the defeats, the lamp and what was claimed", () => {
  const ask = (state, text) => Larxus.answerCondition({ player: player(state), npcId: Common.LARXUS, text });
  assert.equal(ask({}, "Before defeating any champions:"), true);
  const giant = bitsOf("giant");
  assert.equal(ask({ defeated: giant }, "Before defeating any champions:"), false);
  assert.equal(ask({ defeated: giant }, "Before claiming a reward:"), true);
  assert.equal(ask({ defeated: giant, inventory: [LAMP] }, "Before claiming a reward:"), false);
  assert.equal(ask({ defeated: giant, inventory: [LAMP] }, "While holding a Champion's lamp:"), true);
  assert.equal(ask({ defeated: giant, lamps: giant }, "Before claiming a reward:"), false);
  assert.equal(ask({ defeated: giant, lamps: giant }, "While holding a Champion's lamp:"), false);
  assert.equal(ask({ inventory: [6800] }, "If the player has a Champion's scroll in their inventory:"), true);
  assert.equal(ask({}, "If the player has a Champion's scroll in their inventory:"), false);
  assert.equal(ask({ free: 0 }, "If the player has no inventory space:"), true);
});

test("Leon d'Cour challenges only once all ten champions are beaten, and gives his cape after", () => {
  const ten = Common.SCROLL_CHAMPIONS.reduce((bits, entry) => bits | (1 << entry.bit), 0);
  const nine = ten & ~bitsOf("lesserdemon");
  assert.equal(Common.leonUnlocked(player({ defeated: nine })), false);
  assert.equal(Common.leonUnlocked(player({ defeated: ten })), true);
  const variants = larxusVariants();
  const leonDefeated = Larxus.pickVariant({ player: player({ defeated: ten | bitsOf("leon") }), npcId: Common.LARXUS });
  assert.ok(variants.includes(leonDefeated));
  assert.match(leonDefeated, /after-defeating-leon/);
});

test("the lamp claims the first champion beaten and not yet rubbed for", () => {
  const state = { defeated: bitsOf("giant", "imp"), lamps: bitsOf("giant") };
  assert.equal(Common.unclaimed(player(state)), champion("imp"));
  assert.equal(Common.unclaimed(player({ defeated: bitsOf("giant"), lamps: bitsOf("giant") })), null);
});

test("scrolls drop only with 32 Quest Points, and never for a champion already beaten", () => {
  const drops = () => [{ itemId: 6800, amount: 1 }, { itemId: 995, amount: 10 }];
  const fresh = player();
  const kept = drops();
  Rewards.gateScrollDrops({ player: fresh, drops: kept });
  assert.equal(kept.length, 2);
  assert.match(fresh.messages[0], /A Champion's scroll falls to the ground/);

  const beaten = player({ defeated: bitsOf("giant") });
  const withheld = drops();
  Rewards.gateScrollDrops({ player: beaten, drops: withheld });
  assert.deepEqual(withheld.map((drop) => drop.itemId), [995]);
  assert.match(beaten.messages[0], /You have a funny feeling that you would have received a Champion's scroll/);

  const newcomer = player({ questPoints: 31 });
  const none = drops();
  Rewards.gateScrollDrops({ player: newcomer, drops: none });
  assert.deepEqual(none.map((drop) => drop.itemId), [995]);
  assert.equal(newcomer.messages.length, 0);
});
