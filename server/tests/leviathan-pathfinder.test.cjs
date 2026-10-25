const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const H = require("./helpers/leviathan.cjs");
before(H.initialize);

function origin(h, npc) { return h.session.sourceTile(npc.getLocation()).slice(0, 2); }

function walk(h, ticks = 1) {
  for (let tick = 0; tick < ticks; tick++) {
    h.step();
    const npc = h.fight.hazards.pathfinder;
    if (npc?.isRegistered()) npc.getMovementQueue().process();
  }
}

test('registered pathfinder aura refreshes the recorded one-tick player tint through the native packet encoder', t => {
  const h = H.harness(t), hazards = h.fight.hazards;
  h.fight.nextAttack = Infinity;
  hazards.process();
  assert.equal(h.p.getTint(), null);
  hazards.spawnPathfinder();
  h.move([2075,6378]);
  hazards.pathfinder.__testRemoved = true;
  hazards.process();
  assert.equal(h.p.getTint(), null);
  hazards.pathfinder.__testRemoved = false;
  hazards.process();
  assert.deepEqual(h.p.getTint(), { startCycle: 0, endCycle: 30, hue: 9, saturation: 7, lightness: 70, weight: 70 });
  const { createPlayerSyncState, encodePlayerSync } = require('../dist/net/protocol/ClientProtocol');
  const tile = { x: 2075, y: 6378, level: 0 };
  const packet = encodePlayerSync(1, 0, 0, 0, [{ index: 1, ...tile, tint: h.p.getTint() }], createPlayerSyncState(1, tile));
  // The packet appends its two-byte loop-cycle trailer after the update block.
  assert.deepEqual([...packet.subarray(-10, -2)], [0,0,30,0,119,7,198,186]);
});

test('aura tint follows actual movement and expires after leaving or stopping without a persistent recolour', t => {
  const h = H.harness(t), hazards = h.fight.hazards;
  h.fight.nextAttack = Infinity;
  hazards.spawnPathfinder(); h.move([2073,6378]);
  h.step(3);
  assert.equal(h.p.getTint()?.endCycle, 30, 'queued east movement does not shift the glow early');
  h.p.resetUpdating();
  hazards.pathfinder.getMovementQueue().process();
  hazards.process();
  assert.equal(hazards.inAura(), false);
  assert.equal(h.p.getTint(), null, 'outside the aura no new tint extends its thirty-cycle lifetime');
  h.move(hazards.pathfinderCentre()); hazards.process();
  assert.equal(h.p.getTint()?.weight, 70);
  h.p.resetUpdating(); h.fight.stop(); hazards.process();
  assert.equal(h.p.getTint(), null, 'stopping removes the pathfinder and stops refreshing the tint');
});

test("pathfinder follows captured clockwise rectangle with ordinary walking packets", t => {
  const h = H.harness(t), hazards = h.fight.hazards;
  h.fight.nextAttack = Infinity;
  hazards.spawnPathfinder();
  const npc = hazards.pathfinder;
  assert.equal(npc.getSize(), 3);
  assert.deepEqual(origin(h, npc), [2074, 6377]);
  assert.deepEqual(hazards.pathCentre, [2075, 6378]);
  walk(h, 2);
  assert.deepEqual(origin(h, npc), [2074, 6377]);
  const corners = [[2086, 6377], [2086, 6365], [2074, 6365], [2074, 6377]];
  let previous = origin(h, npc);
  for (const corner of corners) {
    for (let step = 0; step < 12; step++) {
      walk(h);
      const current = origin(h, npc);
      assert.equal(Math.abs(current[0] - previous[0]) + Math.abs(current[1] - previous[1]), 1);
      assert.equal(npc.getExactMove(), null, "walk direction, not exact-move mask");
      const expectedDirection = current[0] > previous[0] ? 4 : current[0] < previous[0] ? 3 : current[1] < previous[1] ? 6 : 1;
      assert.equal(npc.getWalkingDirection().getId(), expectedDirection);
      assert.equal(npc.getRunningDirection().getId(), -1);
      assert.deepEqual(hazards.pathCentre, [current[0] + 1, current[1] + 1]);
      previous = current;
    }
    assert.deepEqual(origin(h, npc), corner);
  }
});

test("rubble on the track and destination never detours or stalls the pathfinder", t => {
  const h = H.harness(t), hazards = h.fight.hazards;
  h.fight.nextAttack = Infinity;
  hazards.spawnPathfinder();
  for (const tile of [[2076, 6378], [2082, 6379], [2087, 6378], [2087, 6366]]) hazards.place(tile);
  walk(h, 14);
  assert.deepEqual(origin(h, hazards.pathfinder), [2086, 6377]);
  walk(h, 12);
  assert.deepEqual(origin(h, hazards.pathfinder), [2086, 6365]);
  walk(h);
  assert.deepEqual(origin(h, hazards.pathfinder), [2085, 6365]);
});

test("blocked spawn corners advance clockwise and all blocked corners fall back north-west", t => {
  const h = H.harness(t), hazards = h.fight.hazards;
  const corners = [[2075, 6378], [2087, 6378], [2087, 6366], [2075, 6366]];
  hazards.place(corners[0]);
  hazards.spawnPathfinder();
  assert.deepEqual(hazards.pathCentre, corners[1]);
  hazards.clear();
  for (const corner of corners) hazards.place(corner);
  hazards.spawnPathfinder();
  assert.deepEqual(hazards.pathCentre, corners[0]);
  walk(h, 3);
  assert.deepEqual(origin(h, hazards.pathfinder), [2075, 6377]);
});

test("disabled awakened tornado retains its provisional greedy movement independently", t => {
  const h = H.harness(t, true), hazards = h.fight.hazards;
  const from = [2074, 6379], target = [2089, 6379];
  for (let y = 6378; y <= 6380; y++) hazards.place([2075, y]);
  assert.deepEqual(hazards.stepTornadoToward(from, target), from, "no new BFS detour without awakened evidence");
  hazards.spawnTornado();
  assert.deepEqual(origin(h, hazards.tornado), [2089, 6365], "pathfinder route correction must not relocate tornado");
});

test('aura and enrage prayer piercing start with registered spawn, with no extra activation delay', t => {
  const h = H.harness(t), fight = h.fight, hazards = fight.hazards;
  fight.enraged = true; fight.nextAttack = Infinity;
  hazards.spawnPathfinder();
  h.move(hazards.pathCentre);
  assert.equal(hazards.pathfinder.isRegistered(), true);
  assert.equal(hazards.pathReady(), true);
  assert.equal(hazards.inAura(), true);
  h.prayer('magic');
  t.mock.method(Math, 'random', () => 0.999);
  fight.orb('magic', 1); h.step();
  assert.equal(h.p.getHitpoints(), 99, 'correct impact protection works inside registered aura');
  h.move([2089, 6365]);
  fight.orb('magic', 1); h.step();
  assert.equal(h.p.getHitpoints(), 67, 'outside registered aura protection is pierced immediately');
});

test('unregistered pathfinder grants no aura, preserves protection and does not move before registration', t => {
  const h = H.harness(t), fight = h.fight, hazards = fight.hazards;
  fight.enraged = true; fight.nextAttack = Infinity;
  hazards.spawnPathfinder();
  hazards.pathfinder.__testRemoved = true;
  const initial = [...hazards.pathCentre];
  h.move(initial); h.prayer('magic');
  t.mock.method(Math, 'random', () => 0.999);
  const accurate = () => {
    const event = { attacker: h.p, target: fight.boss, combatType: h.core.CombatType.RANGED, forceAccurate: false };
    h.dispatch('onCombatHitRoll', event);
    return event.forceAccurate;
  };
  assert.equal(hazards.inAura(), false);
  assert.equal(accurate(), false, 'unregistered aura does not grant ranged accuracy');
  fight.orb('magic', 1); h.step(6);
  assert.equal(h.p.getHitpoints(), 99);
  assert.deepEqual(hazards.pathCentre, initial, 'invisible NPC must not advance');
  hazards.pathfinder.__testRemoved = false;
  assert.equal(hazards.inAura(), true, 'registration activates the existing aura immediately');
  assert.equal(accurate(), true);
  h.step();
  assert.notDeepEqual(hazards.pathCentre, initial);
});


test("aura follows actual NPC position when queued movement has not executed", t => {
  const h = H.harness(t), hazards = h.fight.hazards;
  h.fight.nextAttack = Infinity;
  hazards.spawnPathfinder();
  h.move([2073, 6378]);
  assert.equal(hazards.inAura(), true);
  h.step(3);
  assert.deepEqual(origin(h, hazards.pathfinder), [2074, 6377]);
  assert.equal(hazards.inAura(), true, "queued east step must not move the west aura boundary early");
  hazards.pathfinder.getMovementQueue().process();
  assert.equal(hazards.inAura(), false);
});

test("deferred registration matches spawn-to-walk delay in world task order", t => {
  const h = H.harness(t), hazards = h.fight.hazards;
  h.fight.nextAttack = Infinity;
  hazards.spawnPathfinder();
  hazards.pathfinder.__testRemoved = true;
  hazards.process();
  assert.equal(hazards.pathfinder.getMovementQueue().size(), 0);
  // World registers the queued NPC after tasks, before NPC movement and sync.
  hazards.pathfinder.__testRemoved = false;
  walk(h, 2);
  assert.deepEqual(origin(h, hazards.pathfinder), [2074, 6377]);
  walk(h);
  assert.deepEqual(origin(h, hazards.pathfinder), [2075, 6377]);
});

test('recorded normal pathfinder keeps its north-west base beside landed rubble and takes its first step after three ticks', t => {
  const h = H.harness(t), hazards = h.fight.hazards;
  h.fight.nextAttack = Infinity;
  hazards.place([2076, 6378]);
  hazards.spawnPathfinder();
  assert.deepEqual(h.session.sourceTile(hazards.pathfinder.getLocation()), [2074, 6377, 0]);
  walk(h, 2);
  assert.deepEqual(h.session.sourceTile(hazards.pathfinder.getLocation()), [2074, 6377, 0]);
  walk(h);
  assert.deepEqual(h.session.sourceTile(hazards.pathfinder.getLocation()), [2075, 6377, 0]);
  walk(h);
  assert.deepEqual(h.session.sourceTile(hazards.pathfinder.getLocation()), [2076, 6377, 0]);
});

test('normal corner selection ignores diagonal or neighboring rubble and advances only past blocked centres', t => {
  const h = H.harness(t), hazards = h.fight.hazards;
  h.fight.nextAttack = Infinity;
  for (const tile of [[2076,6379], [2088,6378], [2088,6366], [2076,6366]]) assert.equal(hazards.place(tile), true);
  hazards.spawnPathfinder();
  assert.deepEqual(hazards.pathCentre, [2075,6378]);
  hazards.clear();
  hazards.place([2075,6378]); hazards.place([2088,6378]);
  hazards.spawnPathfinder();
  assert.deepEqual(hazards.pathCentre, [2087,6378]);
});

test('disabled awakened pathfinder keeps its unverified footprint-based corner selection', t => {
  const h = H.harness(t, true), hazards = h.fight.hazards;
  hazards.place([2076,6378]); hazards.spawnPathfinder();
  assert.deepEqual(hazards.pathCentre, [2087,6378]);
});

test('recorded ethereal pathfinder crosses debris in its route without a collision detour', t => {
  const h = H.harness(t), hazards = h.fight.hazards;
  h.fight.nextAttack = Infinity;
  hazards.place([2077, 6378]);
  hazards.spawnPathfinder();
  assert.deepEqual(h.session.sourceTile(hazards.pathfinder.getLocation()), [2074, 6377, 0]);
  walk(h, 4);
  assert.deepEqual(hazards.pathCentre, [2077, 6378]);
});
