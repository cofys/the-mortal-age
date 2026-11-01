// Run after `yarn build`: node --test tests/bladed-staff-autocast.test.cjs
// Bladed staves (Staff of the Dead, its toxic form, Staff of Light/Balance) autocast like staves
// (wiki: Autocast); powered staves and polestaves don't. Regression for issue #1670.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { Autocasting } = require("../dist/game/content/combat/magic/Autocasting");
const { FightType } = require("../dist/game/content/combat/FightType");
const { WeaponInterfaces } = require("../dist/game/content/combat/WeaponInterfaces");
const { Equipment } = require("../dist/game/model/container/impl/Equipment");
const { ItemDefinition } = require("../dist/game/definition/ItemDefinition");
const { MagicSpellbook } = require("../dist/game/model/MagicSpellbook");
const { ItemIdentifiers } = require("../dist/util/ItemIdentifiers");

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
});

/** A player on the standard spellbook wielding `weaponId`, recording what the selector sends. */
function wielding(weaponId, spellbook = MagicSpellbook.NORMAL) {
  const weapon = { getId: () => weaponId, getDefinition: () => ItemDefinition.forId(weaponId) };
  const equipment = Object.create(Equipment.prototype);
  equipment.get = (slot) => (slot === Equipment.WEAPON_SLOT ? weapon : null);
  equipment.getWeapon = () => weapon;
  const sent = { messages: [], subInterfaces: [] };
  const sender = {
    sendConfig: () => sender,
    sendSubInterface: (_, id) => (sent.subInterfaces.push(id), sender),
    sendInterfaceFlagsRange: () => sender,
    sendMessage: (message) => (sent.messages.push(message), sender),
  };
  const player = {
    sent,
    fightType: null,
    getSpellbook: () => spellbook,
    getEquipment: () => equipment,
    getWeapon: () => null,
    setFightType(type) { this.fightType = type; },
    getPacketSender: () => sender,
    sendMessage: (message) => sent.messages.push(message),
  };
  equipment.player = player;
  return player;
}

const BLADED_STAVES = [
  ItemIdentifiers.STAFF_OF_THE_DEAD, ItemIdentifiers.TOXIC_STAFF_OF_THE_DEAD,
  ItemIdentifiers.STAFF_OF_LIGHT, ItemIdentifiers.STAFF_OF_BALANCE,
];

test("bladed staves count as staves for autocasting", () => {
  for (const id of BLADED_STAVES) {
    assert.equal(ItemDefinition.forId(id).getWeaponInterface(), WeaponInterfaces.BLADED_STAFF, `${id}`);
    assert.equal(wielding(id).getEquipment().hasStaffEquipped(), true, `${id}`);
  }
  assert.equal(Equipment.canAutocastWith(WeaponInterfaces.STAFF), true);
  assert.equal(Equipment.canAutocastWith(WeaponInterfaces.POWERED_STAFF), false);
  assert.equal(Equipment.canAutocastWith(WeaponInterfaces.POLESTAFF), false);
});

test("the toxic staff of the dead opens the autocast selector on the bladed staff's own styles", () => {
  for (const [childId, expected] of [[23, FightType.BLADED_STAFF_FEND], [28, FightType.BLADED_STAFF_SWIPE]]) {
    const player = wielding(ItemIdentifiers.TOXIC_STAFF_OF_THE_DEAD);
    assert.equal(Autocasting.handleWidgetAction(player, 593, childId), true);
    assert.deepEqual(player.sent.subInterfaces, [201]);
    assert.ok(!player.sent.messages.includes("You need to equip a staff to autocast spells."));
    assert.equal(player.fightType, expected);
  }
});

test("a plain staff still uses Focus and Pound", () => {
  const player = wielding(ItemIdentifiers.STAFF_OF_AIR);
  Autocasting.handleWidgetAction(player, 593, 23);
  assert.equal(player.fightType, FightType.STAFF_FOCUS);
});

// Review of #1672: switching from an Ancient staff to a bladed staff mustn't keep autocasting Ice
// Barrage (wiki: Staff of the Dead can't autocast Ancient Magicks), while compatible spells carry over.
const { Player } = require("../dist/game/entity/impl/player/Player");
const { Item } = require("../dist/game/model/Item");
const { Inventory } = require("../dist/game/model/container/impl/Inventory");
const { EquipPacketListener } = require("../dist/net/packet/impl/EquipPacketListener");
const { CombatFactory } = require("../dist/game/content/combat/CombatFactory");
const { CombatSpells } = require("../dist/game/content/combat/magic/CombatSpells");
const { Skill } = require("../dist/game/model/Skill");

/** A real player on `spellbook`, carrying `first` and `second`, wielding `first` with `spell` autocast. */
function switching(spellbook, first, second, spell) {
  const p = new Player(null);
  p.getPacketSender = () => new Proxy({}, { get: () => () => p.getPacketSender() });
  p.setSpellbook(spellbook);
  for (const skill of [Skill.ATTACK, Skill.MAGIC]) p.getSkillManager().setLevel(skill, 99);
  p.getInventory().setItem(0, new Item(first, 1));
  p.getInventory().setItem(1, new Item(second, 1));
  EquipPacketListener.equip(p, first, 0, Inventory.INTERFACE_ID);
  Autocasting.setAutocast(p, spell);
  assert.equal(p.getCombat().getAutocastSpell(), spell, "the first weapon autocasts the spell");
  EquipPacketListener.equip(p, second, 1, Inventory.INTERFACE_ID);
  assert.equal(p.getEquipment().getWeapon().getId(), second);
  return p;
}

test("switching from an Ancient staff to a Staff of the Dead drops an ancient autocast", () => {
  for (const id of BLADED_STAVES) {
    const p = switching(MagicSpellbook.ANCIENT, ItemIdentifiers.ANCIENT_STAFF, id, CombatSpells.ICE_BARRAGE);
    assert.equal(p.getCombat().getAutocastSpell(), null, `${id}`);
    assert.notEqual(CombatFactory.getMethod(p), CombatFactory.MAGIC_COMBAT, `${id}`);
  }
});

test("bladed staves refuse the ancient selector but keep standard and Arceuus autocasts", () => {
  for (const id of BLADED_STAVES) {
    const player = wielding(id, MagicSpellbook.ANCIENT);
    Autocasting.handleWidgetAction(player, 593, 28);
    assert.deepEqual(player.sent.subInterfaces, [], `${id}`);
  }

  const standard = switching(MagicSpellbook.NORMAL, ItemIdentifiers.STAFF_OF_FIRE,
    ItemIdentifiers.STAFF_OF_THE_DEAD, CombatSpells.FIRE_WAVE);
  assert.equal(standard.getCombat().getAutocastSpell(), CombatSpells.FIRE_WAVE);
  assert.equal(CombatFactory.getMethod(standard), CombatFactory.MAGIC_COMBAT);

  const arceuus = switching(MagicSpellbook.ARCEUUS, ItemIdentifiers.KODAI_WAND,
    ItemIdentifiers.TOXIC_STAFF_OF_THE_DEAD, CombatSpells.SKELETAL_GRASP);
  assert.equal(arceuus.getCombat().getAutocastSpell(), CombatSpells.SKELETAL_GRASP);
});
