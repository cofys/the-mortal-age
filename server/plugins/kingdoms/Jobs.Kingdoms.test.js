"use strict";

/**
 * Jobs.Kingdoms — the kingdom job board.
 *
 * Real KingdomStore (resetForTests) + fake players with real-shaped
 * inventories/locations. Covers: posting from war state, claim gates +
 * daily caps, supply delivery attribution + completion, scout/envoy
 * location verification, sabotage success/failure coherence, and
 * rewards funded from the treasury (never invented).
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const Module = require("node:module");

// Some kingdoms modules transitively require the TS Task class; stub it.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../src/main/typescript/elvarg/game/task/Task") {
    return { Task: class Task {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Store = require("./KingdomStore");
const Jobs = require("./Jobs.Kingdoms");
const WarSupply = require("./WarSupply.Kingdoms");
const Relations = require("./Relations.Kingdoms");

const A = "asgarnia";
const M = "misthalin";
const K = "kandarin";

function mockPlayer(name, kingdomId, opts = {}) {
  const attrs = { "kingdom:id": kingdomId };
  const inv = { ...(opts.inv ?? {}) };
  let loc = opts.loc ?? { x: 2964, y: 3378 };
  return {
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    getUsername: () => name,
    isPlayerBot: () => false,
    getLocation: () => ({ getX: () => loc.x, getY: () => loc.y, getZ: () => 0 }),
    getInventory: () => ({
      getAmount: (id) => inv[id] ?? 0,
      delete: (id, n) => {
        inv[id] = Math.max(0, (inv[id] ?? 0) - n);
      },
      deleteNumber: (id, n) => {
        inv[id] = Math.max(0, (inv[id] ?? 0) - n);
      },
      adds: (id, n) => {
        inv[id] = (inv[id] ?? 0) + n;
      },
      refreshItems: () => {},
    }),
    sendMessage: () => {},
    _inv: () => inv,
    _setLoc: (x, y) => {
      loc = { x, y };
    },
  };
}

function seedKingdoms() {
  Store.resetForTests();
  for (const [id, name, capital] of [
    [A, "Asgarnia", "Falador"],
    [M, "Misthalin", "Varrock"],
    [K, "Kandarin", "East Ardougne"],
  ]) {
    Store.upsertKingdom({ id, name, capital });
    const k = Store.getKingdom(id);
    k.treasury = 100000;
    k.flags = {};
  }
}

function declareWar() {
  Store.declareWar({ attackerId: A, defenderId: M, declaredBy: "test" });
  return Store.getActiveWars();
}

describe("Jobs posting from real state", () => {
  beforeEach(seedKingdoms);

  it("war posts soldier, scout, sabotage and per-category supply/craft jobs", () => {
    declareWar();
    const board = Jobs.boardFor(A, Store);
    const types = board.map((j) => j.type);
    assert.ok(types.includes("soldier"), types.join(","));
    assert.ok(types.includes("scout"));
    assert.ok(types.includes("sabotage"));
    assert.ok(types.includes("supply"), "food demand posts a supply job");
    assert.ok(types.includes("craft"), "arrows/runes/materials demands post craft jobs");
    // No duplicates on a second ensure.
    const again = Jobs.boardFor(A, Store);
    assert.equal(again.length, board.length);
  });

  it("peacetime posts a stockpile contract and envoy missions, no war jobs", () => {
    const board = Jobs.boardFor(A, Store);
    assert.ok(board.some((j) => j.type === "supply" && j.target.stockpile));
    assert.ok(board.some((j) => j.type === "envoy" && j.target.foe === K));
    assert.ok(!board.some((j) => j.type === "soldier"));
  });
});

describe("Jobs claim gates and caps", () => {
  beforeEach(seedKingdoms);

  it("foreigners cannot claim kingdom work; members can; one claim per job", () => {
    const board = Jobs.boardFor(K, Store);
    const job = board.find((j) => j.type === "supply");
    const foreigner = mockPlayer("Foreigner", A);
    assert.equal(Jobs.claim(foreigner, job.id, Store).reason, "not-your-kingdom");
    const member = mockPlayer("Member", K);
    assert.ok(Jobs.claim(member, job.id, Store).ok);
    const other = mockPlayer("Other", K);
    assert.equal(Jobs.claim(other, job.id, Store).reason, "already-claimed");
    // Abandon releases the claim for someone else.
    assert.ok(Jobs.abandon(member, job.id, Store).ok);
    assert.ok(Jobs.claim(other, job.id, Store).ok);
  });

  it("daily cap stops repeat claiming of the same type", () => {
    const member = mockPlayer("Grinder", K);
    for (let i = 0; i < Jobs.JOBS_CONFIG.DAILY_CAPS.supply; i++) {
      const board = Jobs.boardFor(K, Store);
      const job = board.find((j) => j.type === "supply" && !j.claimedBy);
      assert.ok(job, `pass ${i} should have an open supply job`);
      assert.ok(Jobs.claim(member, job.id, Store).ok);
      assert.ok(Jobs.abandon(member, job.id, Store).ok);
    }
    const board = Jobs.boardFor(K, Store);
    const job = board.find((j) => j.type === "supply");
    assert.equal(Jobs.claim(member, job.id, Store).reason, "daily-cap");
  });
});

describe("Jobs completion verification", () => {
  beforeEach(seedKingdoms);

  it("supply: only attributed deliveries after the claim count; reward comes from the treasury", () => {
    declareWar();
    const board = Jobs.boardFor(A, Store);
    const job = board.find((j) => j.type === "supply");
    const worker = mockPlayer("Hauler", A);
    // Deliveries BEFORE the claim do not count.
    Jobs.recordDelivery("Hauler", A, "food", 500, job.target.warKey, Store);
    assert.ok(Jobs.claim(worker, job.id, Store).ok);
    assert.equal(Jobs.complete(worker, job.id, Store).reason, "deliveries-short");
    Jobs.recordDelivery("Hauler", A, "food", job.units - 1, job.target.warKey, Store);
    assert.equal(Jobs.complete(worker, job.id, Store).reason, "deliveries-short");
    Jobs.recordDelivery("Hauler", A, "food", 1, job.target.warKey, Store);
    const treasuryBefore = Store.getKingdom(A).treasury;
    const res = Jobs.complete(worker, job.id, Store);
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(Store.getKingdom(A).treasury, treasuryBefore - job.rewardGold);
    assert.equal(worker._inv()[995], job.rewardGold);
  });

  it("scout: location is verified against the enemy capital", () => {
    declareWar();
    const job = Jobs.boardFor(A, Store).find((j) => j.type === "scout");
    const scout = mockPlayer("Scout", A);
    assert.ok(Jobs.claim(scout, job.id, Store).ok);
    assert.equal(Jobs.complete(scout, job.id, Store).reason, "not-at-target");
    scout._setLoc(3165, 3485); // Varrock, the misthalin capital tile
    assert.ok(Jobs.complete(scout, job.id, Store).ok);
  });

  it("envoy: arrival warms goodwill by the config amount", () => {
    const job = Jobs.boardFor(A, Store).find((j) => j.type === "envoy" && j.target.foe === K);
    assert.ok(job, "envoy job posts in peacetime");
    const envoy = mockPlayer("Envoy", A);
    assert.ok(Jobs.claim(envoy, job.id, Store).ok);
    envoy._setLoc(2660, 3290); // East Ardougne
    const before = Relations.goodwillOf(A, K, Store);
    assert.ok(Jobs.complete(envoy, job.id, Store).ok);
    assert.equal(Relations.goodwillOf(A, K, Store), before + Jobs.JOBS_CONFIG.ENVOY_GOODWILL);
  });

  it("sabotage: a run at the enemy capital resolves coherently (paid or caught)", () => {
    const wars = declareWar();
    WarSupply.ensureDemands(M, wars, Store); // the victim has stock to burn
    const job = Jobs.boardFor(A, Store).find((j) => j.type === "sabotage");
    const sab = mockPlayer("Saboteur", A);
    assert.ok(Jobs.claim(sab, job.id, Store).ok);
    sab._setLoc(3165, 3485);
    const res = Jobs.complete(sab, job.id, Store);
    if (res.ok) {
      assert.equal(sab._inv()[995], job.rewardGold);
    } else {
      assert.equal(res.reason, "caught");
      const stored = Store.load().jobs.list.find((j) => j.id === job.id);
      assert.equal(stored.status, "failed");
    }
  });

  it("an empty treasury blocks completion and keeps the claim", () => {
    declareWar();
    const job = Jobs.boardFor(A, Store).find((j) => j.type === "scout");
    const scout = mockPlayer("Scout", A);
    assert.ok(Jobs.claim(scout, job.id, Store).ok);
    scout._setLoc(3165, 3485);
    Store.getKingdom(A).treasury = 0;
    assert.equal(Jobs.complete(scout, job.id, Store).reason, "treasury-cannot-pay");
    assert.equal(Jobs.claimsOf("Scout", Store).length, 1);
  });

  it("builder: real materials restore one damaged building tier and clear the damage", () => {
    // A resolved siege left the barracks knocked down a tier (Castle state).
    const state = Store.load();
    state.castles = {
      [A]: { kingdomId: A, fortTier: 2, buildings: { barracks: { tier: 1, staff: [] } }, warChest: 0 },
    };
    state.sieges = {
      [A]: {
        attackerKingdomId: M,
        defenderKingdomId: A,
        status: "victory",
        resolvedAt: 4242,
        damaged: ["barracks:tier-1"],
      },
    };
    const board = Jobs.boardFor(A, Store);
    const job = board.find((j) => j.type === "builder");
    assert.ok(job, "siege damage posts a builder job");
    const builder = mockPlayer("Mason", A, { inv: { 1511: 10, 2351: 2 } });
    assert.ok(Jobs.claim(builder, job.id, Store).ok);
    // Without materials in hand the repair cannot happen.
    const bare = mockPlayer("Bare", A);
    assert.equal(Jobs.complete(bare, job.id, Store).reason, "not-your-claim");
    const res = Jobs.complete(builder, job.id, Store);
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(state.castles[A].buildings.barracks.tier, 2, "one tier restored");
    assert.equal(builder._inv()[1511], 0, "logs consumed");
    assert.equal(builder._inv()[2351], 0, "iron bars consumed");
    assert.ok(
      !Jobs.boardFor(A, Store).some((j) => j.type === "builder"),
      "repaired damage posts no further builder jobs"
    );
  });

  it("soldier jobs never complete from the button", () => {
    declareWar();
    const job = Jobs.boardFor(A, Store).find((j) => j.type === "soldier");
    const soldier = mockPlayer("Soldier", A);
    assert.ok(Jobs.claim(soldier, job.id, Store).ok);
    assert.equal(Jobs.complete(soldier, job.id, Store).reason, "settled-on-the-field");
    // The war-event hook settles it when the claimant stood at the site.
    soldier._setLoc(3100, 3400);
    const settled = Jobs.onWarEventResolved({
      kind: "battle",
      attackerId: A,
      defenderId: M,
      site: { x: 3105, y: 3402 },
      store: Store,
      worldLookup: (name) => (name === "Soldier" ? soldier : null),
    });
    assert.equal(settled.length, 1);
    assert.equal(soldier._inv()[995], job.rewardGold);
  });
});
