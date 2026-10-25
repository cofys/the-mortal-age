const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { Player } = require('../dist/game/entity/impl/player/Player');
const { Skill } = require('../dist/game/model/Skill');
const { PluginManager } = require('../dist/plugins/PluginManager');

function fixture(t) {
  const player = new Player(null), events = [];
  const sender = new Proxy({}, { get: () => () => sender });
  player.getPacketSender = () => sender;
  t.mock.method(PluginManager, 'emitCustomEvent', (name, event) => {
    if (name === 'skills:current-level-changed') events.push({ ...event, observed: player.getSkillManager().getCurrentLevel(event.skill) });
  });
  return { player, skills: player.getSkillManager(), events };
}

test('both current-level setters emit one generic event after assignment, including refresh=false', t => {
  const { player, skills, events } = fixture(t);
  assert.equal(skills.setCurrentLevel(Skill.RANGED, 7, false), skills);
  assert.equal(skills.setCurrentLevels(Skill.RANGED, 8), skills);
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.player === player && event.skill === Skill.RANGED));
  assert.deepEqual(events.map(({ previous, current, observed }) => [previous, current, observed]), [[1, 7, 7], [7, 8, 8]]);
});

test('same effective values are silent, negative levels report clamped zero and immediate recovery is observed', t => {
  const { player, skills, events } = fixture(t);
  const maximum = skills.getMaxLevel(Skill.HITPOINTS), xp = skills.getExperience(Skill.HITPOINTS);
  skills.setCurrentLevel(Skill.HITPOINTS, -5, false);
  skills.setCurrentLevels(Skill.HITPOINTS, -2, false);
  skills.setCurrentLevel(Skill.HITPOINTS, 0, false);
  skills.setCurrentLevels(Skill.HITPOINTS, 10, false);
  assert.deepEqual(events.map(({ previous, current }) => [previous, current]), [[10, 0], [0, 10]]);
  assert.equal(player.getHitpoints(), 10);
  assert.equal(skills.getMaxLevel(Skill.HITPOINTS), maximum);
  assert.equal(skills.getExperience(Skill.HITPOINTS), xp);
});

test('actual Player healing and damage in the same tick expose both HP transitions exactly once', t => {
  const { player, skills, events } = fixture(t);
  skills.setMaxLevels(Skill.HITPOINTS, 99, false);
  player.setHitpoints(25);
  events.length = 0;
  player.heal(5);
  player.setHitpoints(25);
  assert.equal(player.getHitpoints(), 25);
  assert.deepEqual(events.map(({ previous, current, observed }) => [previous, current, observed]), [[25, 30, 30], [30, 25, 25]]);
});
