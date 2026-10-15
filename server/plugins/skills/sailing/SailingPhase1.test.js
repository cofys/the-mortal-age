// Sailing Phase 1 tests — rowing, coastal trading, charting, wind, waypoints, construction.
// Pure-logic + stubbed-engine tests; no running server.
//
// Run: node -r ts-node/register/transpile-only server/plugins/skills/sailing/SailingPhase1.test.js
require("ts-node").register({ transpileOnly: true });

const assert = require("node:assert/strict");
const path = require("node:path");

const SAIL = path.resolve(__dirname);

// ---------------------------------------------------------------------------
// Stub the engine modules in require.cache before the plugins load.
// ---------------------------------------------------------------------------
function stubEngine() {
  const boatSpecs = new Map();
  const stubs = {
    "src/main/typescript/elvarg/game/content/sailing/Sailing": {
      Sailing: {
        registerBoatType: (spec) => boatSpecs.set(spec.type, spec),
        registerDock() {},
        instanceAboard: () => undefined,
        giveBoat: (player, type) => {
          if (!boatSpecs.has(type)) return undefined;
          const boat = { slot: player.__boats.length, type, name: [0, 0, 0] };
          player.__boats.push(boat);
          return boat;
        },
      },
    },
    "src/main/typescript/elvarg/game/content/sailing/BoatManager": {
      BoatManager: {
        getSpec: () => undefined,
        onHeadingSet() {},
        onAfterTick() {},
      },
    },
    "src/main/typescript/elvarg/game/content/sailing/Boat": {
      BoatMoveMode: { Full: 1, Half: 2, Stopped: 3 },
    },
    "src/main/typescript/elvarg/game/World": {
      World: { getPlayers: () => [] },
    },
    "src/main/typescript/elvarg/game/model/Skill": {
      Skill: { SAILING: 21, CONSTRUCTION: 22 },
    },
    "src/main/typescript/elvarg/game/model/Item": {
      Item: class {
        constructor(id, amount) {
          this.id = id;
          this.amount = amount;
        }
      },
    },
    "src/main/typescript/elvarg/game/GameConstants": { GameConstants: {} },
    "src/main/typescript/elvarg/game/model/Animation": { Animation: class {} },
    "src/main/typescript/elvarg/game/model/Location": { Location: class {} },
    "src/main/typescript/elvarg/game/task/Task": {
      Task: class {
        constructor() {}
        stop() {}
      },
    },
    "src/main/typescript/elvarg/game/task/TaskManager": {
      TaskManager: { submit() {} },
    },
  };
  for (const [rel, exports] of Object.entries(stubs)) {
    const resolved = require.resolve(path.resolve(rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  }
}
stubEngine();

// The pure wind logic needs no stubs.
const wind = require("./sailingWind.js");
const trading = require("./SailingTrading.plugin.js");
const charting = require("./SailingCharting.plugin.js");
const rowing = require("./SailingRowing.plugin.js");
const waypoints = require("./SailingWaypoints.plugin.js");
const construction = require("./SailingConstruction.plugin.js");
const { content } = require("./SailingContent.Sailing");

// ---------------------------------------------------------------------------
// Mock player.
// ---------------------------------------------------------------------------
function mockPlayer(opts = {}) {
  const attrs = new Map(Object.entries(opts.attrs ?? {}));
  const inv = new Map(Object.entries(opts.inventory ?? {}).map(([k, v]) => [Number(k), v]));
  const messages = [];
  const xp = {};
  const player = {
    __boats: [],
    __messages: messages,
    __xp: xp,
    getAttribute: (k) => attrs.get(k),
    setAttribute: (k, v) => void attrs.set(k, v),
    getInventory: () => ({
      getAmount: (id) => inv.get(id) ?? 0,
      add: (id, amount) => void inv.set(id, (inv.get(id) ?? 0) + amount),
      addItem: (item) => void inv.set(item.id, (inv.get(item.id) ?? 0) + item.amount),
      delete: (id, amount) => void inv.set(id, Math.max(0, (inv.get(id) ?? 0) - amount)),
    }),
    getSkillManager: () => ({
      getMaxLevel: (skill) => opts.levels?.[skill] ?? 1,
      addExperience: (skill, amount) => void (xp[skill] = (xp[skill] ?? 0) + amount),
    }),
    sendMessage: (msg) => void messages.push(msg),
    getLocation: () => ({
      getX: () => opts.x ?? 3048,
      getY: () => opts.y ?? 3186,
      getZ: () => 0,
    }),
    getIndex: () => 1,
    getSailing: () => ({ boats: player.__boats }),
  };
  return player;
}

/** Deterministic PRNG for wind rolls. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Wind (pure logic).
// ---------------------------------------------------------------------------
{
  // rollWind stays in range over many rolls.
  for (let i = 0; i < 200; i++) {
    const w = wind.rollWind(lcg(i));
    assert.ok(w.dir >= 0 && w.dir < 8, `dir in range: ${w.dir}`);
    assert.ok(w.strength >= 1 && w.strength <= 3, `strength in range: ${w.strength}`);
  }

  // describeWind names the compass point and strength.
  assert.equal(wind.describeWind({ dir: 4, strength: 2 }), "blowing from the north, steady");
  assert.equal(wind.describeWind({ dir: 0, strength: 3 }), "blowing from the south, strong");
  assert.equal(wind.describeWind({ dir: 6, strength: 1 }), "blowing from the east, light");

  // Aspect: wind from the north (angle 1024); dead astern is heading south (0).
  const northWind = { dir: 4, strength: 2 };
  assert.equal(wind.windAspect(0, northWind), "with");
  assert.equal(wind.windAspect(1024, northWind), "against");
  assert.equal(wind.windAspect(512, northWind), "across");
  assert.equal(wind.windAspect(1536, northWind), "across");

  // Speed and XP factors follow the aspect.
  assert.equal(wind.windSpeedFactor(0, northWind), wind.WITH_WIND_SPEED);
  assert.equal(wind.windSpeedFactor(1024, northWind), wind.AGAINST_WIND_SPEED);
  assert.equal(wind.windSpeedFactor(512, northWind), 1);
  assert.equal(wind.windXpFactor(0, northWind), wind.WITH_WIND_XP);
  assert.equal(wind.windXpFactor(1024, northWind), 1);

  // Constants match the design doc: +50% / -30% speed, +25% XP.
  assert.equal(wind.WITH_WIND_SPEED, 1.5);
  assert.equal(wind.AGAINST_WIND_SPEED, 0.7);
  assert.equal(wind.WITH_WIND_XP, 1.25);
}

// ---------------------------------------------------------------------------
// Coastal trading.
// ---------------------------------------------------------------------------
{
  const docks = content().docks;
  const sarim = docks.find((d) => d.id === "port_sarim");
  const musa = docks.find((d) => d.id === "musa_point");
  assert.ok(sarim && musa, "port_sarim and musa_point exist");

  // cratePrice grows with the port's level.
  assert.ok(trading.cratePrice(musa) > trading.cratePrice(sarim), "richer port pays more");
  assert.equal(trading.cratePrice(sarim), 50 + 10 * sarim.level);

  // voyageQuote XP scales with distance and crates at the design rate.
  const rich = mockPlayer({ levels: { 21: 50 }, attrs: {} });
  rich.setAttribute(trading.TRADE_VOYAGE_ATTRIBUTE, { origin: "port_sarim", crates: 8, cost: 800 });
  const quote = trading.voyageQuote(rich, musa);
  assert.ok(quote && quote.distance > 0, "quote has a distance");
  const expectedXp = quote.distance * 0.25 * 8;
  assert.ok(Math.abs(quote.xp - expectedXp) <= 1, `XP follows the 0.25/tile/crate rate (got ${quote.xp}, want ~${expectedXp})`);
  // A ~93-tile Sarim->Musa run with 8 crates should be a few hundred XP, not thousands.
  assert.ok(quote.xp < 1000, `short voyage XP is sane: ${quote.xp}`);

  // Same-port quote is undefined (no voyage).
  assert.equal(trading.voyageQuote(rich, sarim), undefined);
}

// ---------------------------------------------------------------------------
// Charting.
// ---------------------------------------------------------------------------
{
  // regionKey tiles the world into 64-tile regions.
  assert.equal(charting.regionKey(0, 0), "0,0");
  assert.equal(charting.regionKey(63, 63), "0,0");
  assert.equal(charting.regionKey(64, 0), "1,0");
  assert.equal(charting.regionKey(0, 128), "0,2");
  assert.equal(charting.regionKey(charting.REGION_TILES, charting.REGION_TILES), "1,1");

  // First visit charts for XP; a revisit charts nothing.
  const surveyor = mockPlayer({ levels: { 21: 40 } });
  const boat = { fineX: 10 * 128, fineY: 10 * 128, heading: 0 };
  const xp1 = charting.chartRegion(surveyor, boat);
  assert.ok(xp1 > 0, "first visit gives XP");
  const xp2 = charting.chartRegion(surveyor, boat);
  assert.equal(xp2, 0, "revisit gives nothing");
  assert.ok(surveyor.__messages.some((m) => m.includes("chart these waters")), "survey message shown");

  // Below 35 the XP is a trickle, from 35 a full share.
  const novice = mockPlayer({ levels: { 21: 10 } });
  const farBoat = { fineX: 5000 * 128, fineY: 5000 * 128, heading: 0 };
  const trickle = charting.chartRegion(novice, farBoat);
  assert.ok(trickle > 0 && trickle < xp1, `trickle (${trickle}) < full share (${xp1})`);
}

// ---------------------------------------------------------------------------
// Rowing.
// ---------------------------------------------------------------------------
{
  assert.equal(rowing.XP_PER_TILE, 4, "rowing XP/tile matches the ~8k/hr design rate");
  assert.ok(rowing.ROW_SPEED > 0, "row speed is positive");
}

// ---------------------------------------------------------------------------
// Waypoints.
// ---------------------------------------------------------------------------
{
  // nearestPorts respects the sailing level and returns closest-first, capped at 8.
  const noob = mockPlayer({ levels: { 21: 1 }, x: 3048, y: 3186 });
  const ports = waypoints.nearestPorts(noob);
  assert.ok(ports.length > 0 && ports.length <= 8, `capped port list: ${ports.length}`);
  assert.ok(ports.every((d) => d.level <= 1), "all ports within the player's level");
  for (let i = 1; i < ports.length; i++) {
    const prev = Math.hypot(ports[i - 1].buoy.x - 3048, ports[i - 1].buoy.y - 3186);
    const cur = Math.hypot(ports[i].buoy.x - 3048, ports[i].buoy.y - 3186);
    assert.ok(prev <= cur, "ports sorted closest-first");
  }
  const veteran = mockPlayer({ levels: { 21: 99 }, x: 3048, y: 3186 });
  assert.ok(waypoints.nearestPorts(veteran).length === 8, "high level gets the full 8");
}

// ---------------------------------------------------------------------------
// Construction.
// ---------------------------------------------------------------------------
{
  // Three drydock stages with materials and XP each.
  assert.equal(construction.STAGES.length, 3, "three build stages");
  for (const stage of construction.STAGES) {
    assert.ok(stage.materials.length > 0, `${stage.name} needs materials`);
    assert.ok(stage.xp > 0, `${stage.name} gives Construction XP`);
  }
  // Twelve hull paints.
  assert.equal(construction.PAINTS.length, 12, "twelve paint colours");
  // Brig needs Construction 55 (the design's tier gate).
  assert.equal(construction.BUILD_LEVEL, 55);

  // The brig spec is registered with the design's stats.
  const brig = content().boats.find((b) => b.type === "brig");
  assert.ok(brig, "brig boat type registered");
  assert.equal(brig.cargoCapacity, 70, "brig cargo 70 per the design");
}

// ---------------------------------------------------------------------------
// Content sanity: the phase-1 items exist.
// ---------------------------------------------------------------------------
{
  const items = require("../../../data/definitions/custom-items.json");
  const ids = new Set(items.map((i) => i.id));
  assert.ok(ids.has(trading.TRADE_CRATE), "sealed trade crate (50005) defined");
  assert.ok(ids.has(construction.BRIG_BLUEPRINT), "brig blueprint (50006) defined");
}

console.log("SailingPhase1.test.js: all assertions passed");
