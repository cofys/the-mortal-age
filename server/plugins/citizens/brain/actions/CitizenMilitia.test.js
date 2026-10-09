"use strict";

/**
 * CitizenMilitia tests — plain node with stubbed engine modules.
 *
 * Covers: enemy target identification (raiders, enemy-tagged NPCs, not
 * friendlies), muster phase movement, fight phase attack, fallback on low
 * HP, orders respected. Engine modules are stubbed in the require cache
 * (same pattern as CitizenSlayer.test.js) so plain-node tests stay
 * engine-free.
 */

const assert = require("node:assert");
const { test } = require("node:test");

// --- stubs ----------------------------------------------------------------

const moved = [];
const said = [];

function mockNpc(opts = {}) {
  return {
    isDead: () => opts.dead ?? false,
    isDying: () => opts.dying ?? false,
    isRegistered: () => opts.registered ?? true,
    getAttribute: (k) => (k === "kingdom:id" ? opts.kingdom ?? null : null),
    getLocation: () => ({
      getX: () => opts.x ?? 0,
      getY: () => opts.y ?? 0,
      getZ: () => opts.z ?? 0,
    }),
    warRaider: opts.raider ?? null,
  };
}

function mockBot(opts = {}) {
  const combat = {
    _target: opts.combatTarget ?? null,
    _attacked: null,
    getTarget() { return this._target; },
    attack(t) { this._target = t; this._attacked = t; },
    reset() { this._target = null; },
  };
  return {
    _combat: combat,
    getUsername: () => opts.username ?? "TestMilitia",
    getLocation: () => ({
      getX: () => opts.x ?? 0,
      getY: () => opts.y ?? 0,
      getZ: () => 0,
    }),
    getAttribute: (k) => {
      if (k === "kingdom:id") return opts.kingdom ?? "asgarnia";
      if (k === "citizens:personality") return {};
      return null;
    },
    getCombat: () => combat,
    getHitpoints: () => opts.hp ?? 100,
    getMaxHitpoints: () => 100,
    getLocalNpcs: () => opts.npcs ?? [],
  };
}

// War state for CitizenEvents stub.
let atWar = false;

// Install require-cache stubs before loading the action.
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../../bots/brain/ActionState") {
    const states = new Map();
    return {
      playerState: (action, bot, init) => {
        const key = bot.getUsername();
        if (!states.has(key)) states.set(key, init());
        return states.get(key);
      },
    };
  }
  if (request === "../../../bots/behaviours/navigation/BotNavigation") {
    return {
      clearMovementRequest: () => {},
      requestMovement: (bot, x, y) => { moved.push({ bot: bot.getUsername(), x, y }); },
    };
  }
  if (request === "../../CitizenEvents") {
    return { isKingdomAtWar: () => atWar };
  }
  if (request === "../CitizenSites") {
    return { kingdomIdOf: (bot) => bot.getAttribute("kingdom:id") };
  }
  if (request === "../../constants") {
    return { ATTR_CITIZEN_PERSONALITY: "citizens:personality" };
  }
  if (request === "../../lib/humanizer") {
    return { agentRng: () => Math.random, chance: (rng, p) => rng() < p };
  }
  if (request === "../../lib/citizenVoice") {
    return { voiceFor: () => ({}), voiceLine: (v, pool) => pool.plain[0] };
  }
  if (request === "../../chat/CitizenSayPublic") {
    return { sayPublic: (bot, line) => { said.push({ bot: bot.getUsername(), line }); } };
  }
  if (request === "../../../kingdoms/Militia.Kingdoms") {
    return origLoad.call(this, request, parent, isMain);
  }
  if (request === "../../../kingdoms/KingdomStore") {
    return { getKingdom: (id) => ({ name: String(id) }) };
  }
  if (request === "../../../world/DiegeticObjects") {
    return {
      CAPITALS: [
        { id: "asgarnia", x: 2964, y: 3378, z: 0 },
        { id: "misthalin", x: 3165, y: 3485, z: 0 },
      ],
    };
  }
  if (request === "../../../kingdoms/Wars.Kingdoms") {
    return { getWars: () => [] };
  }
  return origLoad.call(this, request, parent, isMain);
};

const { createCitizenMilitiaAction } = require("./CitizenMilitia");
const Militia = require("../../../kingdoms/Militia.Kingdoms");

function reset() {
  Militia._roster.clear();
  Militia._orders.clear();
  moved.length = 0;
  said.length = 0;
  atWar = false;
}

test("isEnemyTarget: raiders of the enemy are targets", () => {
  const action = createCitizenMilitiaAction({}, {});
  const isEnemy = action._isEnemyTarget;
  assert.strictEqual(
    isEnemy(mockNpc({ raider: { attackerId: "misthalin", defenderId: "asgarnia" } }), "asgarnia"),
    true
  );
  assert.strictEqual(
    isEnemy(mockNpc({ raider: { attackerId: "asgarnia", defenderId: "misthalin" } }), "asgarnia"),
    false
  );
  assert.strictEqual(isEnemy(mockNpc({ kingdom: "misthalin" }), "asgarnia"), true);
  assert.strictEqual(isEnemy(mockNpc({ kingdom: "asgarnia" }), "asgarnia"), false);
  assert.strictEqual(isEnemy(mockNpc({}), "asgarnia"), false);
  assert.strictEqual(
    isEnemy(mockNpc({ dead: true, raider: { attackerId: "x", defenderId: "asgarnia" } }), "asgarnia"),
    false
  );
  assert.strictEqual(isEnemy(null, "asgarnia"), false);
});

test("hpPercent: reads real HP", () => {
  const action = createCitizenMilitiaAction({}, {});
  assert.strictEqual(action._hpPercent(mockBot({ hp: 100 })), 100);
  assert.strictEqual(action._hpPercent(mockBot({ hp: 25 })), 25);
  assert.strictEqual(action._hpPercent(mockBot({ hp: 0 })), 0);
});

test("muster: walks to muster point when far, cries on arrival", () => {
  reset();
  atWar = true;
  const bot = mockBot({ username: "MusterBob", kingdom: "asgarnia", x: 0, y: 0 });
  Militia.enlist(bot, "asgarnia", "defender");
  const action = createCitizenMilitiaAction({}, {});
  const r1 = action.update({ player: bot, nowMs: Date.now() });
  assert.strictEqual(r1, "running");
  assert.strictEqual(moved.length, 1); // moving to muster
  // Teleport to muster point (2964+5, 3378+5).
  const bot2 = mockBot({ username: "MusterBob", kingdom: "asgarnia", x: 2969, y: 3383 });
  Militia._roster.get("musterbob").joinedAt = Date.now(); // keep enlisted
  const r2 = action.update({ player: bot2, nowMs: Date.now() + 1000 });
  assert.strictEqual(r2, "running");
  assert.ok(said.length > 0); // battle cry on arrival
  Militia.discharge("MusterBob", "asgarnia");
});

test("fight: attacks enemy in range with real combat", () => {
  reset();
  atWar = true;
  const enemy = mockNpc({
    x: 2970, y: 3384,
    raider: { attackerId: "misthalin", defenderId: "asgarnia" },
  });
  const bot = mockBot({
    username: "FightBob",
    kingdom: "asgarnia",
    x: 2969, y: 3383,
    npcs: [enemy],
  });
  Militia.enlist(bot, "asgarnia", "defender");
  const action = createCitizenMilitiaAction({}, {});
  action.update({ player: bot, nowMs: Date.now() }); // muster -> deploy
  action.update({ player: bot, nowMs: Date.now() + 1000 }); // deploy -> fight
  const r = action.update({ player: bot, nowMs: Date.now() + 2000 }); // fight: attack
  assert.strictEqual(r, "running");
  assert.strictEqual(bot._combat._attacked, enemy); // real attack issued
  Militia.discharge("FightBob", "asgarnia");
});

test("fallback: low HP triggers retreat", () => {
  reset();
  atWar = true;
  const bot = mockBot({
    username: "HurtBob",
    kingdom: "asgarnia",
    x: 2900, y: 3300,
    hp: 10,
  });
  Militia.enlist(bot, "asgarnia", "defender");
  const action = createCitizenMilitiaAction({}, {});
  action.update({ player: bot, nowMs: Date.now() });
  assert.ok(moved.length > 0); // retreating
  assert.ok(said.some((s) => /fall back|retreat/i.test(s.line))); // fallback cry
  Militia.discharge("HurtBob", "asgarnia");
});

test("fallback order: marshal's order overrides", () => {
  reset();
  atWar = true;
  Militia.setOrders("asgarnia", "fallback", "marshal");
  const bot = mockBot({
    username: "OrderBob",
    kingdom: "asgarnia",
    x: 2969, y: 3383, // at muster
    hp: 100,
  });
  Militia.enlist(bot, "asgarnia", "defender");
  const action = createCitizenMilitiaAction({}, {});
  action.update({ player: bot, nowMs: Date.now() });
  // Should go to fallback, not deploy.
  assert.ok(said.some((s) => /fall back|retreat/i.test(s.line)));
  Militia.discharge("OrderBob", "asgarnia");
});

test("not at war: action ends gracefully", () => {
  reset();
  atWar = false;
  const bot = mockBot({ username: "PeaceBob", kingdom: "asgarnia" });
  Militia.enlist(bot, "asgarnia", "defender");
  const action = createCitizenMilitiaAction({}, {});
  const result = action.update({ player: bot, nowMs: Date.now() });
  assert.strictEqual(result, "success");
  Militia.discharge("PeaceBob", "asgarnia");
});

test("not militia: action ends gracefully", () => {
  reset();
  atWar = true;
  const bot = mockBot({ username: "Civilian", kingdom: "asgarnia" });
  const action = createCitizenMilitiaAction({}, {});
  const result = action.update({ player: bot, nowMs: Date.now() });
  assert.strictEqual(result, "success");
});
