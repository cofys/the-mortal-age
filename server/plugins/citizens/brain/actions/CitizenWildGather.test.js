"use strict";

/**
 * CitizenWildGather unit checks — brave citizens work the wilderness edge.
 *
 * Proves the brain action's contracts without a running server:
 *   - Personality gating: cautious/nervous/timid -> never eligible, never
 *     starts; brave/adventurous/reckless/daring/bold -> eligible; non-bots
 *     and null players -> ineligible.
 *   - Steadfast split: brave/reckless finish the inventory when merely
 *     watched; the merely adventurous/daring flee.
 *   - Spot selection: prospectSpot returns real in-wilderness candidates
 *     only, filters safe-zone objects, null-safe.
 *   - Skill/tier pick: higher skill wins, level-gated tiers, below
 *     MIN_WILD_LEVEL -> null, unresolvable catalog ids -> null.
 *   - Flee trigger: attacked -> flee even when steadfast; watched ->
 *     steadfast keeps gathering, others run; shallow wild (<20) -> teleport
 *     attempt; deep wild -> runs for the ditch.
 *   - Session end: inventory full -> "success"; clock expiry -> "success";
 *     death -> "failed".
 *   - Wilderness geometry: inWilderness / wildLevelAt mirror the engine.
 *   - Null-safety: missing engine seams never throw.
 *
 * Engine TS sources are stubbed in the require cache (same pattern as
 * CitizenRc.test.js) so plain-node tests stay engine-free.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// The engine sources are TypeScript: the production server runs under ts-node,
// so extensionless requires like ../../../../src/.../model/Skill resolve to
// Skill.ts. Plain node needs the same extension registered before
// require.resolve can find them; the stubs below are pre-populated in
// require.cache so the .ts bodies are never actually loaded.
require.extensions[".ts"] = require.extensions[".js"];

// --- stubs --------------------------------------------------------------------

const movementCalls = []; // { fn, x, y, opts }
const emittedInteractions = [];
const teleports = [];
const checkReqsCalls = [];
const saidLines = [];

function stubEngineModules() {
  const SkillStub = { MINING: "MINING", WOODCUTTING: "WOODCUTTING" };
  const stubs = {
    "../../../bots/brain/ActionState": require("../../../bots/brain/ActionState"),
    "../../../bots/behaviours/navigation/BotNavigation": {
      requestMovement: (player, x, y, opts) => {
        movementCalls.push({ fn: "requestMovement", x, y, opts });
        return true;
      },
      clearMovementRequest: (player) => {
        movementCalls.push({ fn: "clearMovementRequest" });
      },
      approachObject: (player, object, opts) => {
        movementCalls.push({ fn: "approachObject", opts });
        return true;
      },
    },
    "../../../bots/brain/BotObjectCatalog": {
      resolveCatalogObjectIds: (spec) => {
        if (spec?.tier === "unresolvable") return [];
        return [9001, 9002];
      },
    },
    "../../../skills/Mining.plugin": {
      ROCKS: [
        { objectName: "Runite rocks", level: 85 },
        { objectName: "Mithril rocks", level: 50 },
        { objectName: "Coal rocks", level: 30 },
      ],
    },
    "../../../skills/Woodcutting.plugin": {
      TREES: [
        { name: "yew", requiredLevel: 60, action: ["Chop down"] },
        { name: "willow", requiredLevel: 30, action: ["Chop down"] },
      ],
    },
    "../../../../src/main/typescript/elvarg/game/model/Skill": {
      Skill: SkillStub,
    },
    "../../../../src/main/typescript/elvarg/game/entity/impl/object/MapObjects": {
      MapObjects: {
        get: (objectId, loc, area) => mockWorldObject(objectId),
      },
    },
    "../../../../src/main/typescript/elvarg/game/model/teleportation/TeleportHandler": {
      TeleportHandler: {
        checkReqs: (player, dest, limit) => {
          checkReqsCalls.push({ dest, limit });
          return true;
        },
        teleport: (player, dest, type, warning) => {
          teleports.push({ dest, type });
        },
      },
    },
    "../../../../src/main/typescript/elvarg/game/model/teleportation/TeleportType": {
      TeleportType: { NORMAL: "NORMAL" },
    },
    "../../../../src/main/typescript/elvarg/game/model/Location": {
      Location: class {
        constructor(x, y, z) {
          this.x = x;
          this.y = y;
          this.z = z;
        }
      },
    },
    "../CitizenSites": {
      siteTile: (player, kind) =>
        kind === "bank" ? { x: 3000, y: 3000, z: 0 } : null,
    },
  };
  for (const [rel, exports] of Object.entries(stubs)) {
    const full = path.join(__dirname, rel);
    const resolved = require.resolve(full);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
    };
  }
}
stubEngineModules();

const {
  createCitizenWildGatherAction,
  _isWildGatherEligible: isWildGatherEligible,
  _isBrave: isBrave,
  _isCautious: isCautious,
  _isSteadfast: isSteadfast,
  _inWilderness: inWilderness,
  _wildLevelAt: wildLevelAt,
  _stagingTile: stagingTile,
  _pickSkillFor: pickSkillFor,
  _prospectSpot: prospectSpot,
  _senseDanger: senseDanger,
  _MIN_WILD_LEVEL: MIN_WILD_LEVEL,
  _TELEPORT_LEVEL: TELEPORT_LEVEL,
} = require("./CitizenWildGather");

// --- mock world -----------------------------------------------------------------

function mockLocation(x, y, z = 0) {
  return {
    getX: () => x,
    getY: () => y,
    getZ: () => z,
    clone: () => ({ set: () => {} }),
  };
}

function mockWorldObject(objectId, x = 3210, y = 3560) {
  return {
    getId: () => objectId,
    getLocation: () => mockLocation(x, y, 0),
  };
}

function makeWorld(candidates = []) {
  return {
    objectSearch: {
      findCandidatesByIds: (player, ids, opts) => candidates,
    },
    emitObjectInteraction: (event) => {
      emittedInteractions.push(event);
    },
    log: () => {},
  };
}

// --- mock players -----------------------------------------------------------------

function makePlayer(over = {}) {
  const traits = over.traits ?? ["brave"];
  const demeanor = over.demeanor ?? "";
  let x = over.x ?? 3200;
  let y = over.y ?? 3420;
  const state = {
    full: over.full ?? false,
    items: over.items ?? 0,
    hitpoints: over.hitpoints ?? 10,
    locals: over.locals ?? [],
    attacker: over.attacker ?? null,
    mining: over.mining ?? 60,
    woodcutting: over.woodcutting ?? 10,
    forceChat: [],
  };
  const player = {
    isPlayerBot: () => over.isBot ?? true,
    getUsername: () => over.username ?? "Test Brave",
    getAttribute: (key) =>
      key === "citizens:personality" ? { traits, demeanor } : undefined,
    getLocation: () => mockLocation(x, y, 0),
    _setXY: (nx, ny) => {
      x = nx;
      y = ny;
    },
    getInventory: () => ({
      isFull: () => state.full,
      getItems: () =>
        Array.from({ length: state.items }, () => ({ getAmount: () => 1 })),
    }),
    _setFull: (v) => {
      state.full = v;
    },
    _setItems: (v) => {
      state.items = v;
    },
    getSkillManager: () => ({
      getCurrentLevel: (skill) =>
        skill === "MINING" ? state.mining : state.woodcutting,
    }),
    getLocalPlayers: () => state.locals,
    _setLocals: (v) => {
      state.locals = v;
    },
    getCombat: () => ({
      getAttacker: () => state.attacker,
      getTarget: () => null,
      reset: () => {},
    }),
    _setAttacker: (v) => {
      state.attacker = v;
    },
    getHitpoints: () => state.hitpoints,
    _setHitpoints: (v) => {
      state.hitpoints = v;
    },
    getMovementQueue: () => ({
      size: () => 0,
      reset: () => {},
      walkToObject: (object, opts) => {
        opts?.execute?.();
      },
    }),
    getForceMovement: () => null,
    getPrivateArea: () => null,
    getRunEnergy: () => 100,
    setRunning: () => {},
    forceChat: (line) => {
      saidLines.push(line);
    },
  };
  return player;
}

/** A real (non-bot) player standing at x, y. */
function makeRealPlayer(x, y) {
  return {
    isPlayerBot: () => false,
    getUsername: () => "PKer Pete",
    getLocation: () => mockLocation(x, y, 0),
  };
}

function resetCalls() {
  movementCalls.length = 0;
  emittedInteractions.length = 0;
  teleports.length = 0;
  checkReqsCalls.length = 0;
  saidLines.length = 0;
}

// Drive an action from init through to the gather phase; returns { action, player, world }.
function driveToGather(over = {}) {
  resetCalls();
  const rock = mockWorldObject(9001, 3210, 3560);
  const world = makeWorld([rock]);
  const player = makePlayer({ x: 3200, y: 3420, ...over });
  const action = createCitizenWildGatherAction({}, world);
  let nowMs = 1000;
  const tick = () => action.update({ player, nowMs });
  assert.equal(tick(), "running"); // init -> stage
  player._setXY(3200, 3517); // arrive at staging
  nowMs += 1000;
  assert.equal(tick(), "running"); // stage -> prospect
  nowMs += 1000;
  assert.equal(tick(), "running"); // prospect -> gather (spot found)
  player._setXY(3208, 3558); // walk up to the rock
  nowMs += 1000;
  return { action, player, world, tick: (ms) => {
    nowMs += ms ?? 1000;
    return action.update({ player, nowMs });
  }, now: () => nowMs, setNow: (v) => { nowMs = v; } };
}

// --- personality gating --------------------------------------------------------------

test("cautious citizens are never eligible", () => {
  for (const traits of [["cautious"], ["nervous"], ["timid"], ["brave", "cautious"]]) {
    const p = makePlayer({ traits });
    assert.equal(isCautious({ traits }), true, JSON.stringify(traits));
    assert.equal(isWildGatherEligible(p), false, JSON.stringify(traits));
  }
});

test("cautious citizen never starts: first update is failed", () => {
  resetCalls();
  const world = makeWorld([]);
  const player = makePlayer({ traits: ["cautious"] });
  const action = createCitizenWildGatherAction({}, world);
  assert.equal(action.update({ player, nowMs: 1000 }), "failed");
});

test("brave-family traits are eligible; the meek are not", () => {
  for (const traits of [["brave"], ["adventurous"], ["reckless"], ["daring"]]) {
    assert.equal(isBrave({ traits }), true, JSON.stringify(traits));
    assert.equal(
      isWildGatherEligible(makePlayer({ traits })),
      true,
      JSON.stringify(traits)
    );
  }
  assert.equal(isBrave({ demeanor: "bold" }), true);
  assert.equal(isWildGatherEligible(makePlayer({ traits: ["dutiful"], demeanor: "" })), false);
  assert.equal(isWildGatherEligible(makePlayer({ traits: ["dutiful"] })), false);
});

test("non-bots and null players are ineligible", () => {
  assert.equal(isWildGatherEligible(makePlayer({ isBot: false })), false);
  assert.equal(isWildGatherEligible(null), false);
  assert.equal(isWildGatherEligible({}), false);
});

test("steadfast is the narrow core of brave", () => {
  assert.equal(isSteadfast({ traits: ["brave"] }), true);
  assert.equal(isSteadfast({ traits: ["reckless"] }), true);
  assert.equal(isSteadfast({ demeanor: "brash" }), true);
  assert.equal(isSteadfast({ traits: ["adventurous"] }), false);
  assert.equal(isSteadfast({ traits: ["daring"] }), false);
  assert.equal(isSteadfast({ traits: ["brave", "cautious"] }), false);
});

// --- wilderness geometry -----------------------------------------------------------------

test("inWilderness matches the economy rect", () => {
  assert.equal(inWilderness(3210, 3560, 0), true);
  assert.equal(inWilderness(3200, 3519, 0), false); // south of the ditch
  assert.equal(inWilderness(3210, 3560, 1), false); // wrong plane
  assert.equal(inWilderness(NaN, 3560, 0), false);
});

test("wildLevelAt mirrors the engine formula", () => {
  assert.equal(wildLevelAt(3200, 3520), 1);
  assert.equal(wildLevelAt(3200, 3527), 1);
  assert.equal(wildLevelAt(3200, 3528), 2);
  assert.equal(wildLevelAt(3200, 3558), 5);
  assert.equal(wildLevelAt(3200, 3519), 0); // not in the wild
  assert.equal(wildLevelAt(2000, 3600), 0); // outside levelled x range
});

test("stagingTile sits just south of the ditch at the citizen's x", () => {
  const tile = stagingTile(makePlayer({ x: 3200, y: 3420 }));
  assert.deepEqual(tile, { x: 3200, y: 3517, z: 0 });
  const clamped = stagingTile(makePlayer({ x: 100, y: 3420 }));
  assert.ok(clamped.x >= 2952 && clamped.x <= 3383);
  assert.equal(stagingTile(null), null);
});

// --- spot selection -----------------------------------------------------------------

test("prospectSpot returns real in-wilderness candidates", () => {
  const rock = mockWorldObject(9001, 3210, 3560);
  const world = makeWorld([rock]);
  const player = makePlayer({ x: 3200, y: 3517 });
  const spot = prospectSpot(world, player, [9001], () => 0);
  assert.deepEqual(spot, { objectId: 9001, x: 3210, y: 3560, z: 0 });
});

test("prospectSpot filters safe-zone objects and handles empties", () => {
  const safeRock = mockWorldObject(9001, 3200, 3400); // south of the ditch
  const world = makeWorld([safeRock]);
  const player = makePlayer({ x: 3200, y: 3517 });
  assert.equal(prospectSpot(world, player, [9001], () => 0), null);
  assert.equal(prospectSpot(makeWorld([]), player, [9001], () => 0), null);
  assert.equal(prospectSpot({}, player, [9001], () => 0), null);
  assert.equal(prospectSpot(makeWorld([safeRock]), player, [], () => 0), null);
  assert.equal(prospectSpot(makeWorld([safeRock]), null, [9001], () => 0), null);
});

// --- skill / tier pick -----------------------------------------------------------------

test("pickSkillFor takes the higher skill and the richest affordable tier", () => {
  const pick = pickSkillFor(makePlayer({}), {
    levels: { mining: 60, woodcutting: 10 },
  });
  assert.equal(pick.key, "mining");
  assert.equal(pick.tier, "mithril"); // 60 < 85 runite, >= 50 mithril
  assert.deepEqual(pick.ids, [9001, 9002]);
  const wc = pickSkillFor(makePlayer({}), {
    levels: { mining: 10, woodcutting: 60 },
  });
  assert.equal(wc.key, "woodcutting");
  assert.equal(wc.tier, "yew");
});

test("pickSkillFor returns null below the wild minimum or without ids", () => {
  assert.ok(MIN_WILD_LEVEL > 1);
  assert.equal(
    pickSkillFor(makePlayer({}), { levels: { mining: 10, woodcutting: 10 } }),
    null
  );
  assert.equal(
    pickSkillFor(makePlayer({}), {
      levels: { mining: 99, woodcutting: 99 },
      rockTiers: [{ tier: "unresolvable", level: 1, click: "Mine" }],
      treeTiers: [{ tier: "unresolvable", level: 1, click: "Chop down" }],
    }),
    null
  );
});

// --- danger sensing -----------------------------------------------------------------

test("senseDanger spots real players nearby, ignores fellow bots", () => {
  const player = makePlayer({ x: 3200, y: 3560 });
  assert.deepEqual(senseDanger(player), {
    attacked: false,
    watched: false,
    threat: false,
  });
  player._setLocals([makeRealPlayer(3205, 3562)]); // 5 tiles
  assert.equal(senseDanger(player).watched, true);
  player._setLocals([makeRealPlayer(3230, 3600)]); // far
  assert.equal(senseDanger(player).watched, false);
  const fellow = { isPlayerBot: () => true, getUsername: () => "Citizen Two", getLocation: () => mockLocation(3201, 3561, 0) };
  player._setLocals([fellow]);
  assert.equal(senseDanger(player).watched, false);
  player._setLocals([]);
  player._setAttacker({});
  assert.equal(senseDanger(player).attacked, true);
  assert.equal(senseDanger(player).threat, true);
});

// --- flee trigger -----------------------------------------------------------------

test("attacked citizen flees even when steadfast-brave", () => {
  const { tick, player } = driveToGather({ traits: ["brave"] });
  player._setAttacker({ getUsername: () => "PKer Pete" });
  assert.equal(tick(), "running"); // danger noticed -> flee phase
  const r = tick(); // flee tick: shallow wild -> teleport attempt
  assert.equal(r, "running");
  assert.ok(checkReqsCalls.length > 0, "expected a teleport check below level 20");
  assert.ok(teleports.length > 0, "expected the teleport to fire");
  assert.deepEqual(
    { x: teleports[0].dest.x, y: teleports[0].dest.y },
    { x: 3000, y: 3000 },
    "teleport goes to the kingdom bank tile"
  );
});

test("gather clicks the real object through the real click path", () => {
  const { tick } = driveToGather({ traits: ["brave"] });
  assert.equal(tick(), "running"); // first gather tick: within 20 tiles -> click
  assert.equal(emittedInteractions.length, 1, "expected one object interaction");
  const ev = emittedInteractions[0];
  assert.equal(ev.objectId, 9001);
  assert.equal(ev.clickType, 1);
  assert.deepEqual(ev.location, { x: 3210, y: 3560, z: 0 });
  assert.equal(ev.handled, false);
});

test("merely watched: steadfast finishes the inventory, others flee", () => {
  // Steadfast brave keeps gathering.
  {
    const { tick, player } = driveToGather({ traits: ["brave"] });
    player._setLocals([makeRealPlayer(3209, 3559)]);
    assert.equal(tick(), "running");
    assert.equal(tick(), "running");
    assert.equal(teleports.length, 0, "steadfast brave does not flee when watched");
    assert.ok(saidLines.length > 0, "steadfast brave says a nervous line");
  }
  // Merely adventurous flees when watched.
  {
    const { tick, player } = driveToGather({ traits: ["adventurous"] });
    player._setLocals([makeRealPlayer(3209, 3559)]);
    assert.equal(tick(), "running"); // -> flee phase
    tick(); // flee tick
    assert.ok(
      checkReqsCalls.length > 0 || movementCalls.some((c) => c.fn === "requestMovement"),
      "adventurous citizen flees when watched"
    );
  }
});

test("deep wild flees on foot toward the ditch, no teleport", () => {
  const { tick, player } = driveToGather({ traits: ["daring"] });
  player._setXY(3200, 3800); // wild level 36 — too deep to teleport
  assert.equal(wildLevelAt(3200, 3800) >= TELEPORT_LEVEL, true);
  player._setAttacker({ getUsername: () => "PKer Pete" });
  tick(); // -> flee
  tick(); // flee tick: runs south
  assert.equal(teleports.length, 0, "no teleport at/above level 20");
  const runs = movementCalls.filter((c) => c.fn === "requestMovement");
  assert.ok(runs.length > 0, "expected a run movement request");
  assert.ok(
    runs.some((c) => c.y < 3520),
    "run target is south of the ditch"
  );
});

test("escape across the ditch ends the run as success", () => {
  const { tick, player } = driveToGather({ traits: ["daring"] });
  player._setAttacker({ getUsername: () => "PKer Pete" });
  tick(); // -> flee
  player._setXY(3200, 3510); // crossed back south, out of the wild
  assert.equal(tick(), "success");
});

// --- session end -----------------------------------------------------------------

test("full inventory ends the session as success", () => {
  const { tick, player } = driveToGather({ traits: ["brave"] });
  player._setFull(true);
  assert.equal(tick(), "success");
});

test("session clock expiry ends the session as success", () => {
  const d = driveToGather({ traits: ["brave"] });
  d.setNow(d.now() + 11 * 60 * 1000); // past the 5-10 minute session
  assert.equal(d.tick(0), "success");
});

test("death ends the action as failed — the engine owns the death", () => {
  const { tick, player } = driveToGather({ traits: ["brave"] });
  player._setHitpoints(0);
  assert.equal(tick(), "failed");
});

// --- null-safety -----------------------------------------------------------------

test("null-safety: broken engine seams never throw", () => {
  const action = createCitizenWildGatherAction({}, {});
  assert.equal(action.update({ player: null, nowMs: 1 }), "failed");
  assert.equal(action.update({ player: {}, nowMs: 1 }), "failed");
  const bare = { isPlayerBot: () => true };
  assert.equal(action.update({ player: bare, nowMs: 1 }), "failed");
  assert.doesNotThrow(() => action.stop({}));
  assert.doesNotThrow(() => action.stop(null));
  assert.equal(prospectSpot(null, null, null), null);
  assert.deepEqual(senseDanger({}), {
    attacked: false,
    watched: false,
    threat: false,
  });
});

test("action id and stop clear movement", () => {
  resetCalls();
  const action = createCitizenWildGatherAction({}, makeWorld([]));
  assert.equal(action.id, "citizenWildGather");
  action.stop({ player: makePlayer({}) });
  assert.ok(movementCalls.some((c) => c.fn === "clearMovementRequest"));
});
