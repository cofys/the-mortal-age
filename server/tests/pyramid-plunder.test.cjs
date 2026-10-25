// Run after `yarn build`: node --test tests/pyramid-plunder.test.cjs
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");

const PyramidPlunder = require("../plugins/minigames/PyramidPlunder.plugin");

const T = PyramidPlunder._test;
const C = T.Common;

/** Ticks, tasks and the world cycle under the test's control. */
const clock = { cycle: 1000, tasks: [] };
const spawned = [];
const removed = [];
const prompts = [];
let questStarted = true;

/** Lets the last action's ticks pass, so the next click is taken. */
function next() {
  clock.cycle += 5;
}

function flush(ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    clock.cycle++;
    const due = clock.tasks.filter((task) => --task.left <= 0);
    clock.tasks = clock.tasks.filter((task) => task.left > 0);
    for (const task of due) task.task.execute();
  }
}

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  const real = PluginManager.getCoreApi();
  const core = {
    ...real,
    World: { getProcessCycle: () => clock.cycle },
    TaskManager: { submit: (task) => clock.tasks.push({ task, left: task.delay ?? task.getDelay?.() ?? 1 }) },
    CombatFactory: { poisonEntity: (player, severity) => { player.poisoned = severity; } },
    ItemOnGroundManager: { registerLocation: (player, item, at) => { player.ground.push([item.getId(), at]); } },
  };
  const api = {
    core,
    emitCustomEvent(name, payload) {
      if (name === "quest:is-started") payload.started = questStarted;
      if (name === "npc-dialogue:start") payload.handled = true;
    },
    spawnNpc(definition) {
      const npc = { definition, attacked: null, getCombat: () => ({ attack: (target) => { npc.attacked = target; } }) };
      spawned.push(npc);
      return npc;
    },
    removeNpc: (npc) => removed.push(npc),
    sendMultiChatboxPrompt: (player, title, ...pairs) => { prompts.push({ player, title, pairs }); return true; },
  };
  C.bind(api);
});

/** Always (1), never (0), or a fixed roll. */
const always = () => 0;
const never = () => 0.999999;

function player({ thieving = 99, strength = 99, items = {}, at = { x: 3289, y: 2801, z: 0 } } = {}) {
  const attrs = new Map();
  const varbits = new Map();
  const inventory = new Map(Object.entries(items).map(([id, amount]) => [Number(id), amount]));
  const Skill = C.getCore().Skill;
  const p = {
    at: { ...at },
    messages: [],
    xp: { THIEVING: 0, STRENGTH: 0 },
    hits: [],
    anims: [],
    ground: [],
    overlay: null,
    poisoned: 0,
    sounds: [],
    dialogues: [],
    varbits,
    inventory,
    getAttribute: (key) => attrs.get(key),
    setAttribute: (key, value) => attrs.set(key, value),
    getSkillManager: () => ({
      getCurrentLevel: (skill) => (skill === Skill.STRENGTH ? strength : thieving),
      getMaxLevel: (skill) => (skill === Skill.STRENGTH ? strength : thieving),
      addExperiences: (skill, amount) => { p.xp[skill === Skill.STRENGTH ? "STRENGTH" : "THIEVING"] += amount; },
    }),
    getPacketSender: () => ({
      sendVarbit: (id, value) => varbits.set(id, value),
      getVarbit: (id) => varbits.get(id) ?? 0,
      sendSubInterface: (uid, id) => { p.overlay = id; },
      closeSubInterface: () => { p.overlay = null; },
      sendSound: (id) => p.sounds.push(id),
      sendObjectAnimation: () => {},
    }),
    getDialogueManager: () => ({ startDialogues: (chain) => p.dialogues.push(chain) }),
    getMovementQueue: () => ({ reset: () => {} }),
    getForceMovement: () => p.forced,
    setForceMovement: (value) => { p.forced = value; },
    getInventory: () => ({
      getAmount: (id) => inventory.get(id) ?? 0,
      addItem: (item) => inventory.set(item.getId(), (inventory.get(item.getId()) ?? 0) + item.getAmount()),
      deleteNumber: (id, amount) => inventory.set(id, (inventory.get(id) ?? 0) - amount),
      getFreeSlots: () => 28 - [...inventory.values()].filter((amount) => amount > 0).length,
    }),
    getCombat: () => ({ reset: () => {}, getHitQueue: () => ({ addPendingDamage: (hits) => p.hits.push(...hits.map((h) => h.getDamage?.() ?? h.damage ?? h)) }) }),
    performAnimation: (anim) => p.anims.push(anim),
    sendMessage: (message) => p.messages.push(message),
    getLocation: () => ({ getX: () => p.at.x, getY: () => p.at.y, getZ: () => p.at.z, clone: () => ({ ...p.at }) }),
    moveTo: (location) => { p.at = { x: location.getX(), y: location.getY(), z: location.getZ() }; },
  };
  return p;
}

const ids = () => C.ids();
const art = (key) => ids().item.artefacts[key];
const artefactCount = (p) => Object.values(ids().item.artefacts).reduce((n, id) => n + Math.max(0, p.inventory.get(id) ?? 0), 0);
const roomOf = (p) => C.roomAt(p.at.x, p.at.y, p.at.z);
const objectAt = (room, objectId) => {
  const b = C.roomData(room).bounds;
  return { objectId, location: { x: b.minX + 2, y: b.minY + 2, z: 0 } };
};
const firstUrn = () => [...ids().urns.keys()][0];
const doorId = (n) => [...ids().tombDoors.entries()].find(([, door]) => door === n)[0];

// --- Data and rolls

test("rooms, XP and sceptre rates follow the Wiki", () => {
  assert.equal(C.ROOMS.length, 8);
  assert.deepEqual(C.ROOMS.map((r) => r.level), [21, 31, 41, 51, 61, 71, 81, 91]);
  assert.deepEqual(C.ROOMS.map((r) => r.urnXp), [60, 90, 150, 215, 300, 450, 675, 825]);
  assert.deepEqual(C.ROOMS.map((r) => r.chestXp), [40, 60, 100, 140, 200, 300, 450, 550]);
  assert.deepEqual(C.ROOMS.map((r) => r.sarcophagusXp), [20, 30, 50, 70, 100, 150, 225, 275]);
  assert.deepEqual(C.ROOMS.map((r) => r.sceptre), [4200, 2800, 1600, 950, 800, 750, 650, 650]);
  for (const room of C.ROOMS) {
    const b = room.bounds;
    assert.ok(room.entry.x >= b.minX && room.entry.x <= b.maxX && room.entry.y >= b.minY && room.entry.y <= b.maxY, `room ${room.room} entry inside`);
  }
});

test("fitted chances hit the Wiki's chart values", () => {
  assert.equal(Math.round(C.chanceOf("urnSearch", 21, 1) * 256), 117);
  assert.equal(Math.round(C.chanceOf("urnSearch", 99, 1) * 256), 181);
  assert.equal(Math.round(C.chanceOf("urnSearch", 99, 4) * 256), 178, "1/256 less per room");
  assert.equal(Math.round(C.chanceOf("checkForSnakes", 21, 1) * 256), 179);
  assert.equal(Math.round(C.chanceOf("checkForSnakes", 69, 1) * 256), 223);
  assert.equal(Math.round(C.chanceOf("door", 21, 1) * 256), 149);
  assert.equal(Math.round(C.chanceOf("door", 99, 1) * 256), 221);
  assert.equal(Math.round(C.chanceOf("doorLockpick", 21, 1) * 256), 179);
  assert.equal(Math.round(C.chanceOf("speartrap", 99, 1) * 256), 251);
  assert.equal(Math.round(C.sarcophagusChance(1, 1) * 256), 60);
  assert.equal(Math.round(C.sarcophagusChance(99, 1) * 256), 250);
  assert.equal(Math.round(C.sarcophagusChance(1, 6) * 256), 10);
  assert.equal(C.sarcophagusChance(1, 7), 0, "room 7: impossible at Strength 1");
  assert.ok(C.sarcophagusChance(2, 7) > 0);
  assert.equal(C.sarcophagusChance(7, 8), 0, "room 8: impossible up to Strength 7");
  assert.ok(C.sarcophagusChance(8, 8) > 0);
});

test("loot tables: one artefact per chest and sarcophagus from the room's table", () => {
  assert.equal(C.rollChestArtefact(1, () => 0), "stoneSeal");
  assert.equal(C.rollChestArtefact(1, () => 0.5), "stoneScarab");
  assert.equal(C.rollChestArtefact(8, () => 0.99), "goldenStatuette");
  assert.equal(C.rollSarcophagusArtefact(1, () => 0), "potteryScarab");
  assert.equal(C.rollSarcophagusArtefact(8, () => 0.99), "goldSeal");
  assert.equal(C.rollUrnArtefact(1, () => 0), "ivoryComb");
  assert.equal(C.rollUrnArtefact(8, () => 0.99), "goldenStatuette");
  assert.equal(C.rollSceptre(8, () => 0), true);
  assert.equal(C.rollSceptre(8, () => 1 / 650), false);
});

// --- Entry, rooms and the timer

test("21 Thieving and Icthlarin's Little Helper started are needed to play", () => {
  const low = player({ thieving: 20 });
  assert.equal(T.Entrance.tryStart(low), false);
  assert.deepEqual(low.messages, [C.MESSAGES.entryLevel]);
  questStarted = false;
  const noQuest = player({ thieving: 50 });
  assert.equal(T.Entrance.tryStart(noQuest), false);
  assert.deepEqual(noQuest.messages, [C.MESSAGES.quest]);
  questStarted = true;
  assert.equal(C.sessionOf(low), null);
});

test("a run starts in room 1 with the overlay, a full timer and closed rooms", () => {
  const p = player({ thieving: 21 });
  p.varbits.set(ids().urnVarbits[0], 1);
  assert.equal(T.Entrance.tryStart(p, () => 0), true);
  const run = C.sessionOf(p);
  assert.equal(run.room, 1);
  assert.equal(roomOf(p), 1);
  assert.equal(p.overlay, ids().overlay);
  assert.equal(p.varbits.get(ids().varbit.room), 1);
  assert.equal(p.varbits.get(ids().varbit.level), 21);
  assert.equal(p.varbits.get(ids().varbit.timer), 0);
  assert.equal(p.varbits.get(ids().urnVarbits[0]), 0, "rooms reset");
  C.endRun(p);
});

test("rooms advance in order through the right door, and only with the level", () => {
  const p = player({ thieving: 99 });
  T.Entrance.tryStart(p, () => 0);
  C.sessionOf(p).exits = [2, 2, 2, 2, 2, 2, 2, 2];
  T.Passages.pickLock({ player: p, ...objectAt(1, doorId(1)) }, always);
  assert.ok(p.messages.includes(C.MESSAGES.deadEnd));
  next();
  T.Passages.pickLock({ player: p, ...objectAt(1, doorId(2)) }, always);
  flush(2);
  assert.equal(C.sessionOf(p).room, 2);
  assert.equal(roomOf(p), 2);
  assert.equal(p.varbits.get(ids().varbit.doors[0]), 0, "doors closed again in the new room");
  assert.equal(p.xp.THIEVING, 40 + 40, "room 1 door XP for each picked door");

  const low = player({ thieving: 30 });
  T.Entrance.tryStart(low, () => 0);
  C.sessionOf(low).exits = [1, 1, 1, 1, 1, 1, 1, 1];
  T.Passages.pickLock({ player: low, ...objectAt(1, doorId(1)) }, always);
  assert.deepEqual(low.messages.slice(-1), [C.MESSAGES.level(31)]);
  assert.equal(C.sessionOf(low).room, 1);
  C.endRun(p);
  C.endRun(low);
});

test("after three dead ends the fourth door always leads on; a lockpick halves the XP", () => {
  const p = player({ thieving: 99, items: { [1523]: 1 } });
  T.Entrance.tryStart(p, () => 0);
  const run = C.sessionOf(p);
  run.exits = [3, 4, 4, 4, 4, 4, 4, 4];
  for (const n of [1, 2, 4]) {
    T.Passages.pickLock({ player: p, ...objectAt(1, doorId(n)) }, always);
    next();
  }
  flush(2);
  assert.equal(C.sessionOf(p).room, 1, "doors 1, 2 and 4 were dead ends");
  run.exits = [1, 4, 4, 4, 4, 4, 4, 4];
  assert.equal(T.Passages.leadsOn(p, C.sessionOf(p), 3), true, "doors 1, 2 and 4 failed: 3 leads on");
  assert.equal(p.xp.THIEVING, 3 * 20, "half of 40 per door with a lockpick");
  C.endRun(p);
});

test("room 8's doors ask before leaving the tomb", () => {
  const p = player({ thieving: 99 });
  T.Entrance.tryStart(p, () => 0);
  C.enterRoom(p, C.sessionOf(p), 8);
  T.Passages.pickLock({ player: p, ...objectAt(8, doorId(1)) }, always);
  const prompt = prompts.at(-1);
  assert.equal(prompt.player, p);
  prompt.pairs[1](p);
  assert.equal(C.sessionOf(p), null);
  assert.deepEqual(p.at, C.DATA.outside);
});

test("the run ends once when the time runs out, and the next run starts fresh", () => {
  const p = player({ thieving: 99 });
  T.Entrance.tryStart(p, () => 0);
  C.enterRoom(p, C.sessionOf(p), 3);
  clock.cycle += C.DATA.timerTicks;
  T.Session.tick(p);
  assert.equal(C.sessionOf(p), null);
  assert.deepEqual(p.at, C.DATA.outside);
  assert.equal(p.overlay, null);
  assert.equal(p.messages.filter((m) => m === C.MESSAGES.timeUp).length, 1);
  T.Session.tick(p);
  assert.equal(p.messages.filter((m) => m === C.MESSAGES.timeUp).length, 1, "ends once");
  assert.equal(T.Entrance.variantFor(p), T.Entrance.VARIANT.timedOut);
  assert.equal(T.Entrance.variantFor(p), T.Entrance.VARIANT.later, "the time-out line plays once");

  T.Entrance.tryStart(p, () => 0);
  assert.equal(C.sessionOf(p).room, 1);
  assert.equal(p.varbits.get(ids().varbit.timer), 0);
  C.endRun(p);
});

test("logout mid-run ends the run outside, and nothing can be looted after", () => {
  const p = player({ thieving: 99 });
  T.Entrance.tryStart(p, () => 0);
  T.Session.onPlayerLogout({ player: p });
  assert.equal(C.sessionOf(p), null);
  assert.deepEqual(p.at, C.DATA.outside);
  T.Containers.searchUrn({ player: p, ...objectAt(1, firstUrn()) }, always);
  assert.equal(artefactCount(p), 0);
  p.at = { ...C.roomData(2).entry, z: 0 };
  T.Session.onPlayerLogin({ player: p });
  assert.deepEqual(p.at, C.DATA.outside, "a player saved inside wakes outside");
});

// --- Containers

test("an urn gives its XP and one artefact once", () => {
  const p = player({ thieving: 99 });
  T.Entrance.tryStart(p, () => 0);
  const urn = { player: p, ...objectAt(1, firstUrn()) };
  T.Containers.searchUrn(urn, always);
  assert.equal(p.xp.THIEVING, 60);
  assert.equal(artefactCount(p), 1);
  T.Containers.searchUrn(urn, always);
  assert.equal(artefactCount(p), 1, "looted once");
  assert.ok(p.messages.includes(C.MESSAGES.looted));
  C.endRun(p);
});

test("a failed urn search bites and poisons; a charmed snake makes it safe", () => {
  const p = player({ thieving: 21, items: { [ids().item.snakeCharm]: 1 } });
  T.Entrance.tryStart(p, () => 0);
  const urn = { player: p, ...objectAt(1, firstUrn()) };
  T.Containers.searchUrn(urn, never);
  assert.equal(p.hits.length, 1);
  assert.ok(p.poisoned >= 1 && p.poisoned <= 4);
  assert.equal(artefactCount(p), 0);
  next();
  T.Containers.checkUrn(urn, always);
  assert.equal(p.varbits.get(ids().urns.get(firstUrn())), T.Containers.URN.SNAKE);
  assert.equal(p.xp.THIEVING, 20, "a third of the urn's XP for the check");
  T.Containers.charmUrn(urn);
  next();
  T.Containers.searchUrn(urn, never);
  assert.equal(artefactCount(p), 1, "charmed: no roll to fail");
  C.endRun(p);
});

test("the chest always gives its artefact; a scarab swarm takes the XP instead", () => {
  const p = player({ thieving: 99 });
  T.Entrance.tryStart(p, () => 0);
  // 0.5: no swarm at 99 Thieving, no sceptre.
  T.Containers.searchChest({ player: p, ...objectAt(1, ids().chest) }, () => 0.5);
  assert.equal(p.xp.THIEVING, 40);
  assert.equal(artefactCount(p), 1);
  T.Containers.searchChest({ player: p, ...objectAt(1, ids().chest) }, () => 0.5);
  assert.equal(artefactCount(p), 1, "opens once");

  const q = player({ thieving: 21 });
  T.Entrance.tryStart(q, () => 0);
  spawned.length = 0;
  T.Containers.searchChest({ player: q, ...objectAt(1, ids().chest) }, () => 0.9);
  assert.equal(q.xp.THIEVING, 0, "the swarm takes the XP");
  assert.equal(artefactCount(q), 1);
  assert.deepEqual(q.hits, [3]);
  assert.equal(spawned[0].definition.id, ids().npc.scarabs);
  assert.equal(spawned[0].attacked, q);
  C.endRun(q);
  assert.ok(removed.includes(spawned[0]), "the swarm goes with the run");
  C.endRun(p);
});

test("the sceptre ends the run, and lands outside with a full pack", () => {
  const p = player({ thieving: 99 });
  T.Entrance.tryStart(p, () => 0);
  T.Containers.searchChest({ player: p, ...objectAt(1, ids().chest) }, () => 0);
  assert.equal(C.sessionOf(p), null);
  assert.equal(p.inventory.get(ids().item.sceptre), 1);
  assert.deepEqual(p.at, C.DATA.outside);

  const full = {};
  for (let i = 0; i < 28; i++) full[20000 + i] = 1;
  const q = player({ thieving: 99, items: full });
  T.Entrance.tryStart(q, () => 0);
  T.Containers.searchChest({ player: q, ...objectAt(1, ids().chest) }, () => 0);
  assert.equal(q.inventory.get(ids().item.sceptre) ?? 0, 0);
  assert.ok(q.ground.some(([id]) => id === ids().item.sceptre));
});

test("the sarcophagus opens on Strength and gives Strength XP", () => {
  const weak = player({ thieving: 99, strength: 5 });
  T.Entrance.tryStart(weak, () => 0);
  C.enterRoom(weak, C.sessionOf(weak), 8);
  T.Containers.openSarcophagus({ player: weak, ...objectAt(8, ids().sarcophagus) }, always);
  assert.deepEqual(weak.messages.slice(-1), [C.MESSAGES.sarcophagusWeak]);
  C.endRun(weak);

  const p = player({ thieving: 99, strength: 99 });
  T.Entrance.tryStart(p, () => 0);
  // 0.5: opens, no mummy in room 1 (1/9), no sceptre.
  T.Containers.openSarcophagus({ player: p, ...objectAt(1, ids().sarcophagus) }, () => 0.5);
  assert.equal(p.xp.STRENGTH, 20);
  assert.equal(artefactCount(p), 1);
  assert.equal(p.varbits.get(ids().varbit.sarcophagus), T.Containers.SARCOPHAGUS.OPEN);
  T.Containers.openSarcophagus({ player: p, ...objectAt(1, ids().sarcophagus) }, () => 0.5);
  assert.equal(artefactCount(p), 1, "opens once");
  C.endRun(p);
});

test("containers in another room do nothing", () => {
  const p = player({ thieving: 99 });
  T.Entrance.tryStart(p, () => 0);
  T.Containers.searchChest({ player: p, ...objectAt(5, ids().chest) }, () => 0.5);
  assert.equal(artefactCount(p), 0);
  C.endRun(p);
});

// --- The speartrap

test("the speartrap is armed on entry; its disarm takes the captured six ticks, then the spears go down", () => {
  const p = player({ thieving: 21 });
  T.Entrance.tryStart(p, () => 0);
  const trap = C.roomData(1).trap;
  const trapVarbit = ids().varbit.trap;
  assert.equal(p.varbits.get(trapVarbit), 1, "armed as the room starts");
  const event = { player: p, objectId: 21280, location: { x: trap.x, y: trap.y, z: 0 } };
  p.at = { x: trap.x, y: trap.y + 2, z: 0 };
  T.Passages.passTrap(event, never);
  flush(1);
  assert.equal(p.messages.at(-1), C.MESSAGES.trapTry);
  flush(5);
  assert.equal(p.messages.at(-1), C.MESSAGES.trapFail);
  assert.equal(p.hits.length, 1);
  assert.deepEqual(p.sounds, [ids().sound.trapWork, ids().sound.trapWork]);

  next();
  T.Passages.passTrap(event, always);
  T.Passages.passTrap(event, always);
  flush(5);
  assert.deepEqual(p.at, { x: trap.x, y: trap.y + 2, z: 0 }, "nothing until the sixth tick");
  flush(1);
  assert.equal(p.messages.at(-1), C.MESSAGES.trapDisarmed);
  assert.equal(p.xp.THIEVING, T.Passages.TRAP_XP, "a click during the disarm is ignored");
  flush(1);
  assert.deepEqual(p.at, { x: trap.x, y: trap.y + 2, z: 0 }, "the three-tile walk is still in progress");
  assert.equal(p.varbits.get(trapVarbit), 1, "the spears are still up as the player crosses");
  flush(1);
  assert.equal(p.varbits.get(trapVarbit), 0, "down two ticks after the disarm, for the rest of the room");
  flush(1);
  assert.deepEqual(p.at, { x: trap.x, y: trap.y - 1, z: 0 }, "walked across in three ticks");
  T.Passages.passTrap(event, never);
  flush(3);
  assert.deepEqual(p.at, { x: trap.x, y: trap.y + 2, z: 0 }, "Pass on a disarmed trap just walks back across");
  assert.equal(p.hits.length, 1);
  C.endRun(p);
});

// --- The entrance

test("one outer panel leads to the Guardian mummy, the others to an abandoned room", () => {
  const p = player();
  C.state.entranceChangesAt = clock.cycle + 100;
  C.state.entrance = 2;
  T.Entrance.searchPanel({ player: p, objectId: ids().outerPanels[2] });
  flush(4);
  assert.deepEqual(p.at, C.DATA.mummyLobby);
  T.Entrance.searchPanel({ player: p, objectId: ids().outerPanels[0] });
  flush(4);
  assert.deepEqual(p.at, C.DATA.abandonedLobby);
});

test("the mummy's start steps put the player in room 1", () => {
  const p = player({ thieving: 50 });
  const request = { player: p, npcId: ids().npc.guardian, stepId: "1Goj0e", handled: false };
  T.Entrance.onDialogueAction(request);
  assert.equal(request.handled, true);
  assert.equal(C.sessionOf(p).room, 1);
  C.endRun(p);
  assert.equal(T.Entrance.variantFor(player()), T.Entrance.VARIANT.first);
});

// --- Simon Templeton

test("Simon takes every artefact, noted or not, and pays his prices", () => {
  const noted = ids().item.noted;
  const p = player({ items: { [art("ivoryComb")]: 2, [noted.goldenStatuette]: 3, [art("stoneSeal")]: 1 } });
  assert.equal(T.Simon.onDialogueVariant({ player: p, npcId: 5786 }), T.Simon.VARIANT.carrying);
  T.Simon.onDialogueAction({ player: p, npcId: 5786, stepId: "Kn2FnM", handled: false });
  const pay = { player: p, npcId: 5786, stepId: "7vfUYS", handled: false };
  T.Simon.onDialogueAction(pay);
  assert.equal(p.inventory.get(ids().item.coins), 2 * 50 + 3 * 1250 + 150);
  assert.equal(artefactCount(p), 0);
  assert.equal(p.inventory.get(noted.goldenStatuette), 0);
  assert.equal(T.Simon.onDialogueVariant({ player: p, npcId: 5786 }), null, "nothing left: his usual lines");
});

test("an artefact used on Simon sells just that one", () => {
  const p = player({ items: { [art("goldSeal")]: 2 } });
  const event = { player: p, npcId: 5786, itemId: art("goldSeal"), target: {}, handled: false };
  T.Simon.onItemOnNpc(event);
  assert.equal(event.handled, true);
  T.Simon.onDialogueAction({ player: p, npcId: 5786, stepId: "0egJhg", handled: false });
  T.Simon.onDialogueAction({ player: p, npcId: 5786, stepId: "dFDQfD", handled: false });
  assert.equal(p.inventory.get(art("goldSeal")), 1);
  assert.equal(p.inventory.get(ids().item.coins), 750);
});

// --- Review fixes

test("a run's exits are its own: another player's run doesn't change them", () => {
  const a = player({ thieving: 99 });
  T.Entrance.tryStart(a, () => 0);
  const exits = [...C.sessionOf(a).exits];
  const b = player({ thieving: 99 });
  T.Entrance.tryStart(b, () => 0.9);
  assert.deepEqual(C.sessionOf(a).exits, exits);
  C.endRun(a);
  C.endRun(b);
});

test("walking onto the armed speartrap springs it and pushes the player back", () => {
  const p = player({ thieving: 99 });
  T.Entrance.tryStart(p, () => 0);
  const run = C.sessionOf(p);
  const trap = C.roomData(1).trap;
  p.at = { x: trap.x, y: trap.y + 3, z: 0 };
  T.Session.guardTrap(p, run);
  p.at = { x: trap.x, y: trap.y + 1, z: 0 };
  T.Session.guardTrap(p, run);
  assert.equal(p.hits.length, 1);
  assert.deepEqual(p.at, { x: trap.x, y: trap.y + 3, z: 0 });
  C.endRun(p);
});

test("a search takes its ticks: an immediate second click is ignored", () => {
  const p = player({ thieving: 21 });
  T.Entrance.tryStart(p, () => 0);
  const urn = { player: p, ...objectAt(1, firstUrn()) };
  T.Containers.searchUrn(urn, never);
  T.Containers.searchUrn(urn, never);
  assert.equal(p.hits.length, 1, "one bite, not two");
  C.endRun(p);
});

test("walking away stops the sarcophagus pushes", () => {
  const p = player({ thieving: 99, strength: 1 });
  T.Entrance.tryStart(p, () => 0);
  // Never opens on this roll; then the player walks off.
  T.Containers.openSarcophagus({ player: p, ...objectAt(1, ids().sarcophagus) }, () => 0.99);
  p.at = { x: p.at.x + 1, y: p.at.y, z: 0 };
  flush(10);
  assert.equal(p.varbits.get(ids().varbit.sarcophagus), T.Containers.SARCOPHAGUS.CLOSED);
  assert.equal(p.xp.STRENGTH, 0);
  C.endRun(p);
});

test("with a full pack, the artefact found with the sceptre lands outside too", () => {
  const full = {};
  for (let i = 0; i < 28; i++) full[20000 + i] = 1;
  const p = player({ thieving: 99, items: full });
  T.Entrance.tryStart(p, () => 0);
  T.Containers.searchChest({ player: p, ...objectAt(1, ids().chest) }, () => 0);
  const outside = p.ground.filter(([, at]) => at.x === C.DATA.outside.x && at.y === C.DATA.outside.y);
  assert.equal(outside.length, 2, "the sceptre and the artefact, both outside");
});

test("an unanswered one-item offer doesn't stick to Simon's next conversation", () => {
  const p = player({ items: { [art("goldSeal")]: 1 } });
  T.Simon.onItemOnNpc({ player: p, npcId: 5786, itemId: art("goldSeal"), target: {}, handled: false });
  assert.ok(T.Simon.offered.has(p));
  T.Simon.forget({ player: p });
  assert.ok(!T.Simon.offered.has(p));
  assert.equal(T.Simon.onDialogueVariant({ player: p, npcId: 5786 }), T.Simon.VARIANT.carrying);
});

test("Leave Tomb asks first, Quick-leave doesn't; time running out has the live lines", () => {
  const p = player({ thieving: 21 });
  T.Entrance.tryStart(p, () => 0);
  T.Passages.leaveTomb({ player: p, objectId: ids().tombExit, option: "Leave Tomb" });
  assert.equal(prompts.at(-1).title, C.MESSAGES.leaveTomb);
  assert.ok(C.sessionOf(p), "nothing happens until the player answers");
  const beforeQuickLeave = prompts.length;
  // ObjectActionPacketListener supplies lowercase option text.
  T.Passages.leaveTomb({ player: p, objectId: ids().tombExit, option: "quick-leave" });
  assert.equal(C.sessionOf(p) ?? null, null);
  assert.equal(prompts.length, beforeQuickLeave);

  const q = player({ thieving: 21 });
  T.Entrance.tryStart(q, () => 0);
  C.endRun(q, { timedOut: true });
  assert.equal(q.messages.at(-1), C.MESSAGES.timeUp);
  assert.equal(q.dialogues.length, 1, "the Guardian mummy's line");
});

test("the forced trap walk lasts as long as its client movement", () => {
  const trap = C.roomData(1).trap;
  const at = trap.horizontal ? { x: trap.x - 1, y: trap.y, z: 0 } : { x: trap.x, y: trap.y - 1, z: 0 };
  const p = player({ at });
  const destination = T.Passages.crossingTile(trap, at);
  T.Passages.walkAcross(p, { room: 1 });
  assert.ok(p.forced);
  flush(1);
  assert.deepEqual(p.at, at, "one tick cannot complete a three-tile walk");
  assert.ok(p.forced);
  flush(2);
  assert.deepEqual(p.at, { ...destination, z: 0 });
  assert.equal(p.forced, null);
});

test("ending a run with a mummy or swarm out tells the player they go", () => {
  const p = player({ thieving: 21 });
  T.Entrance.tryStart(p, () => 0);
  const run = C.sessionOf(p);
  run.hostiles.push({ getId: () => ids().npc.mummy, getHitpoints: () => 10, isRegistered: () => true });
  run.hostiles.push({ getId: () => ids().npc.scarabs, getHitpoints: () => 10, isRegistered: () => true });
  C.endRun(p);
  assert.ok(p.messages.includes(C.MESSAGES.mummyVanishes));
  assert.ok(p.messages.includes(C.MESSAGES.scarabsLeave));
});
