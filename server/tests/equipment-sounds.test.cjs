// Run after `yarn build`: node --test tests/equipment-sounds.test.cjs
// The sound for wearing and removing an item: its recorded equipSound, else the rules for its kind
// in equipment-sounds.json (docs/equipment-sounds.md).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { ItemDefinition } = require("../dist/game/definition/ItemDefinition");
const { EquipmentSounds } = require("../dist/game/definition/EquipmentSounds");

const rows = new Map(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../data/definitions/item-gameplay.json"), "utf8")).map((row) => [row.id, row]));
const sound = (id) => EquipmentSounds.soundIdFor(ItemDefinition.forId(id));

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
});

test("a recorded item plays its own sound", () => {
  for (const [id, expected] of [[4151, 2249], [1127, 2239], [1079, 2242], [1163, 2240], [1704, 2238], [1201, 2245], [2503, 2241], [1381, 2247]]) {
    assert.equal(rows.get(id).equipSound, expected, `${rows.get(id).name} is recorded`);
    assert.equal(sound(id), expected, rows.get(id).name);
  }
});

test("an unrecorded item plays its kind's: weapon type, then slot, then the default", () => {
  const cases = [
    [1333, 2248, "Rune scimitar: scimitars"],
    [861, 2244, "Magic shortbow: bows"],
    [11283, 2245, "Dragonfire shield: shields"],
    [4720, 2239, "Dharok's platebody: platebodies"],
    [1712, 2238, "Amulet of glory(4): the default"],
  ];
  for (const [id, expected, why] of cases) {
    assert.equal(rows.get(id)?.equipSound, undefined, `${why} has no recording`);
    assert.equal(sound(id), expected, why);
  }
});

test("name rules pick the material within a slot or weapon type", () => {
  // Crystal bows and wands sound unlike other bows and staves; vambraces like leather.
  const rules = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../data/definitions/equipment-sounds.json"), "utf8"));
  const pick = (list, name) => list.find((rule) => !rule.name || new RegExp(rule.name, "i").test(name)).sound;
  assert.equal(pick(rules.weaponTypes.SHORTBOW, "Crystal bow"), 2238);
  assert.equal(pick(rules.weaponTypes.STAFF, "Kodai wand"), 2238);
  assert.equal(pick(rules.weaponTypes.STAFF, "Staff of fire"), 2247);
  assert.equal(pick(rules.slots.hands, "Blue d'hide vambraces"), 2241);
  assert.equal(pick(rules.slots.legs, "Granite legs"), 2238);
  assert.equal(pick(rules.slots.legs, "Bronze plateskirt"), 2242);
});
