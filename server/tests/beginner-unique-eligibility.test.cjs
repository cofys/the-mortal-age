const assert = require("node:assert/strict");
const {test} = require("node:test");
const {Server} = require("../dist/Server");
Server.installProductionPathResolver();
require("../dist/game/cache/CachePipeline").CachePipeline.initialize();
const {Player} = require("../dist/game/entity/impl/player/Player");
const {PlayerSave} = require("../dist/game/entity/impl/player/persistence/PlayerSave");
const JsonPersistence = require("../plugins/persistence/JsonPlayerPersistence.plugin");
const Rewards = require("../plugins/treasuretrails/beginner/Rewards.BeginnerTreasureTrails");
const TEN_HOURS = 36_000_000;
let codec;
JsonPersistence.register({
  getSkillManager: () => require("../dist/game/content/skill/SkillManager").SkillManager,
  setPlayerPersistence: backend => { codec = backend; }, log() {},
});
function snapshot(player) {
  return JSON.parse(JSON.stringify(PlayerSave.fromPlayer(player), codec.replacer.bind(codec)), codec.reviver.bind(codec));
}

test("beginner uniques unlock at the exact ten-hour account-age boundary", () => {
  const now = Date.now(), player = new Player(null);
  for (const [age, expected] of [[0, false], [TEN_HOURS - 1, false], [TEN_HOURS, true], [TEN_HOURS + 1, true]]) {
    player.getCreationDate().setTime(now - age);
    assert.equal(Rewards.uniqueEligible(player, now), expected, String(age));
  }
});

test("account creation survives serialized saves and repeated login loads", () => {
  const player = new Player(null), created = Date.now() - TEN_HOURS - 1;
  player.getCreationDate().setTime(created);
  const saved = snapshot(player);
  assert.equal(saved.creationDate, created);
  const restored = new Player(null);
  codec.hydratePlayerSave(saved).applyToPlayer(restored);
  assert.equal(restored.getCreationDate().getTime(), created);
  assert.equal(Rewards.uniqueEligible(restored), true);
  const reloaded = new Player(null);
  codec.hydratePlayerSave(snapshot(restored)).applyToPlayer(reloaded);
  assert.equal(reloaded.getCreationDate().getTime(), created);
});

test("missing or corrupt account dates never grant early uniques and migrate on the next save", () => {
  for (const value of [undefined, null, 0, -1, NaN, "2000-01-01", Date.now() + TEN_HOURS]) {
    const loaded = new Player(null), original = loaded.getCreationDate().getTime();
    Object.assign(PlayerSave.fromPlayer(loaded), {creationDate: value}).applyToPlayer(loaded);
    assert.equal(loaded.getCreationDate().getTime(), original);
    assert.equal(Rewards.uniqueEligible(loaded), false);
    assert.equal(PlayerSave.fromPlayer(loaded).creationDate, original);
  }
});

test("ineligible rolls cover every ordinary reward with its conditional canonical weight", () => {
  const entries = Rewards.TABLE.entries.filter(row => !row.unique);
  const total = entries.reduce((sum, row) => sum + row.weight, 0);
  let before = 0;
  for (const entry of entries) {
    const values = [0, (before + entry.weight / 2) / total, 0];
    const rolled = Rewards.roll(() => values.shift() ?? 0, false);
    assert.deepEqual(rolled, [{itemId: entry.item_id, amount: entry.quantity[0], noted: entry.noted}]);
    before += entry.weight;
  }
});

test("eligible rolls retain every published reward and its original weight", () => {
  let before = 0;
  for (const entry of Rewards.TABLE.entries) {
    const values = [0, (before + entry.weight / 2) / Rewards.TABLE.out_of, 0];
    assert.equal(Rewards.roll(() => values.shift() ?? 0, true)[0].itemId, entry.item_id);
    before += entry.weight;
  }
});
