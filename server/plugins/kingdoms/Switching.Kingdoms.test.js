"use strict";

/**
 * Switching.Kingdoms.test.js — the leave / naturalize / join flow.
 *
 * Covers: renounce (influence drop via breakOath, word-spread, allegiance
 * cleared, offices vacated, cooldown started), the naturalization quest
 * (petition guards, real-service progress, fee, oath completion), the 7-day
 * oath cooldown, tenure gating of office petitions and strategic war powers,
 * and hatred-tier interplay (hated/enemy courts refuse petitions and oaths).
 *
 * Sibling modules are stubbed in the require cache so plain-node tests stay
 * engine-free; Influence is the real module (its breakOath math is the
 * behaviour under test). WarTableApi's runWarfareAction is reached through
 * its _test seam — the full war-table status payload is out of scope here.
 *
 * Run: node server/plugins/kingdoms/Switching.Kingdoms.test.js
 */

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const path = require("node:path");

const KINGDOMS_DIR = __dirname;

function stub(rel, exports) {
  const p = path.resolve(KINGDOMS_DIR, rel) + ".js";
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const KINGDOMS = {
  asgarnia: { id: "asgarnia", name: "Asgarnia" },
  misthalin: { id: "misthalin", name: "Misthalin" },
  kandarin: { id: "kandarin", name: "Kandarin" },
};

const treasury = { asgarnia: 0, misthalin: 0, kandarin: 0 };

stub("./KingdomStore", {
  getKingdom: (id) => KINGDOMS[id] ?? null,
  getKingdoms: () => Object.values(KINGDOMS),
  grantTax: (id, amount) => { treasury[id] = (treasury[id] ?? 0) + amount; },
  recordIncome: () => {},
  save: () => {},
});

// Membership: constants plus a joinKingdom that mirrors the real event path
// (seats the subject, grants the standard +10 fealty influence).
let Influence;
stub("./Membership.Kingdoms", {
  KINGDOM_ID_ATTRIBUTE: "kingdom:id",
  KINGDOM_RANK_ATTRIBUTE: "kingdom:rank",
  KINGDOM_TITLES_ATTRIBUTE: "kingdom:titles",
  joinKingdom: (player, kingdomId) => {
    player.setAttribute("kingdom:id", kingdomId);
    player.setAttribute("kingdom:rank", "Subject");
    Influence.addInfluence(player, kingdomId, 10);
    return true;
  },
});

stub("./Offices.Kingdoms", {
  getOffices: (kingdomId) => [
    { officeId: "marshal", office: "marshal", title: "Marshal", kingdomId, holder: null },
    {
      officeId: "steward",
      office: "steward",
      title: "Steward",
      kingdomId,
      holder: { kind: "player", ref: "TestUser" },
    },
  ],
  getOffice: (officeId) => ({
    officeId,
    office: officeId,
    title: "Marshal",
    kingdomId: "asgarnia",
    holder: null,
  }),
  holderName: (h) => h.ref,
});

Influence = require(path.resolve(KINGDOMS_DIR, "Influence.Kingdoms.js"));
const Switching = require(path.resolve(KINGDOMS_DIR, "Switching.Kingdoms.js"));

const emitted = [];
// Attach the real module with a mock api so event emissions are observable.
Switching({
  persistAttribute: () => {},
  emitCustomEvent: (name, payload) => emitted.push({ name, payload }),
});

function mockPlayer(username, attrs = {}, coins = 0) {
  const store = { ...attrs };
  const messages = [];
  let purse = coins;
  return {
    getUsername: () => username,
    getAttribute: (k) => (k in store ? store[k] : null),
    setAttribute: (k, v) => { store[k] = v; },
    sendMessage: (m) => messages.push(m),
    isPlayerBot: () => false,
    getInventory: () => ({
      getAmount: (id) => (id === 995 ? purse : 0),
      delete: (id, amount) => { if (id === 995) purse = Math.max(0, purse - amount); },
      refreshItems: () => {},
    }),
    __store: store,
    __messages: messages,
    __purse: () => purse,
  };
}

function influenceAttrs(pointsByKingdom, firstEarnedAgoMs = 0) {
  const now = Date.now();
  const first = now - firstEarnedAgoMs;
  return {
    "kingdom:influence": Object.fromEntries(
      Object.entries(pointsByKingdom).map(([k, v]) => [
        k,
        { points: v, firstEarned: first, lastEarned: now },
      ])
    ),
  };
}

const OTHER_IDS = ["misthalin", "kandarin"];

describe("renounce", () => {
  it("drops influence with the old kingdom and clears the allegiance", () => {
    const p = mockPlayer("TestUser", {
      "kingdom:id": "asgarnia",
      "kingdom:rank": "Knight",
      "kingdom:titles": ["Oathkeeper"],
      ...influenceAttrs({ asgarnia: 50 }),
    });
    const res = Switching.renounce(p, OTHER_IDS, () => 1); // rng=1: no word-spread
    assert.equal(res.ok, true);
    assert.equal(res.oldKingdomId, "asgarnia");
    assert.deepEqual(res.spreadTo, []);
    // breakOath: 50 - 75 = -25 (disliked tier)
    assert.equal(Math.floor(Influence.effectiveInfluence(p, "asgarnia")), -25);
    assert.equal(p.__store["kingdom:id"], null);
    assert.equal(p.__store["kingdom:rank"], null);
    assert.deepEqual(p.__store["kingdom:titles"], []);
    assert.equal(p.__store["kingdom:oath-at"], null);
    assert.equal(p.__store["kingdom:naturalization"], null);
    assert.ok(typeof p.__store["kingdom:renounced-at"] === "number");
    console.log("ok - renounce drops influence, clears allegiance");
  });

  it("spreads word to other kingdoms on a 40% roll", () => {
    const p = mockPlayer("TestUser", {
      "kingdom:id": "asgarnia",
      ...influenceAttrs({ asgarnia: 0 }),
    });
    const res = Switching.renounce(p, OTHER_IDS, () => 0); // rng=0: always spreads
    assert.deepEqual(res.spreadTo.sort(), ["kandarin", "misthalin"]);
    assert.equal(Math.floor(Influence.effectiveInfluence(p, "misthalin")), -15);
    assert.equal(Math.floor(Influence.effectiveInfluence(p, "kandarin")), -15);
    // -75 with the old kingdom -> hated tier territory (-75 + tenure 0)
    assert.equal(Influence.hatredTier(Math.floor(Influence.effectiveInfluence(p, "asgarnia"))), "hated");
    console.log("ok - word-spread applies -15 to hearing kingdoms");
  });

  it("vacates held offices and emits kingdom:oath-broken", () => {
    emitted.length = 0;
    const p = mockPlayer("TestUser", { "kingdom:id": "asgarnia" });
    Switching.renounce(p, OTHER_IDS, () => 1);
    const vacated = emitted.filter((e) => e.name === "kingdom:office-vacated");
    assert.equal(vacated.length, 1);
    assert.equal(vacated[0].payload.officeId, "steward");
    const broken = emitted.filter((e) => e.name === "kingdom:oath-broken");
    assert.equal(broken.length, 1);
    assert.equal(broken[0].payload.oldKingdomId, "asgarnia");
    console.log("ok - offices vacated, oath-broken emitted");
  });

  it("returns null when the player serves no kingdom", () => {
    const p = mockPlayer("TestUser", {});
    assert.equal(Switching.renounce(p, OTHER_IDS, () => 0), null);
    console.log("ok - renounce with no allegiance is a no-op");
  });
});

describe("naturalization quest", () => {
  it("refuses petitioners who still serve a kingdom", () => {
    const p = mockPlayer("TestUser", { "kingdom:id": "asgarnia" });
    const res = Switching.startNaturalization(p, "misthalin");
    assert.equal(res.ok, false);
    assert.equal(res.reason, "already-sworn");
    assert.equal(Switching.naturalizationTarget(p), null);
    console.log("ok - petition refused while sworn");
  });

  it("refuses petitioners hated by the target court", () => {
    const p = mockPlayer("TestUser", { ...influenceAttrs({ misthalin: -30 }) });
    const res = Switching.startNaturalization(p, "misthalin");
    assert.equal(res.ok, false);
    assert.equal(res.reason, "unwelcome");
    console.log("ok - hated petitioners refused");
  });

  it("opens the quest for the allegiance-free and replaces prior petitions", () => {
    const p = mockPlayer("TestUser", {
      "kingdom:naturalization": { kingdomId: "kandarin", startedAt: Date.now() },
    });
    const res = Switching.startNaturalization(p, "misthalin");
    assert.equal(res.ok, true);
    assert.equal(Switching.naturalizationTarget(p), "misthalin");
    assert.ok(p.__messages.some((m) => m.includes("Kandarin")), "withdrawal noted");
    console.log("ok - quest opens, prior petition replaced");
  });

  it("tracks real-service progress and fee status", () => {
    const p = mockPlayer(
      "TestUser",
      {
        "kingdom:naturalization": { kingdomId: "misthalin", startedAt: Date.now() },
        ...influenceAttrs({ misthalin: 100 }),
      },
      5000
    );
    const q = Switching.naturalizationProgress(p);
    assert.equal(q.kingdomId, "misthalin");
    assert.equal(q.influence, 100);
    assert.equal(q.target, Switching.SWITCHING_CONFIG.naturalizationInfluenceTarget);
    assert.equal(q.oathReady, false);
    assert.ok(q.blockers.some((b) => b.includes("50 more influence")));
    assert.ok(q.blockers.some((b) => b.includes("5,000 more coins")));
    console.log("ok - quest progress reflects live influence and purse");
  });

  it("completes the oath: fee moves, allegiance set, tenure clock starts", () => {
    treasury.misthalin = 0;
    const p = mockPlayer(
      "TestUser",
      {
        "kingdom:naturalization": { kingdomId: "misthalin", startedAt: Date.now() },
        ...influenceAttrs({ misthalin: 150 }),
      },
      20000
    );
    const res = Switching.takeOath(p, "misthalin");
    assert.equal(res.ok, true);
    assert.equal(p.__purse(), 10000, "fee taken from the purse");
    assert.equal(treasury.misthalin, 10000, "fee lands in the new treasury");
    assert.equal(p.__store["kingdom:id"], "misthalin");
    assert.equal(p.__store["kingdom:rank"], "Subject");
    assert.ok(typeof p.__store["kingdom:oath-at"] === "number");
    assert.equal(Switching.naturalizationTarget(p), null, "quest cleared");
    // Fealty grant: the oath seats the subject at +10 influence.
    assert.ok(Math.floor(Influence.effectiveInfluence(p, "misthalin")) >= 10);
    assert.ok(p.__messages.some((m) => m.includes("swear")));
    console.log("ok - oath ceremony completes the join");
  });

  it("blocks the oath while service, fee, or cooldown are unmet", () => {
    // Insufficient service.
    let p = mockPlayer(
      "TestUser",
      {
        "kingdom:naturalization": { kingdomId: "misthalin", startedAt: Date.now() },
        ...influenceAttrs({ misthalin: 10 }),
      },
      50000
    );
    assert.equal(Switching.takeOath(p, "misthalin").reason, "insufficient-service");

    // Insufficient fee.
    p = mockPlayer(
      "TestUser",
      {
        "kingdom:naturalization": { kingdomId: "misthalin", startedAt: Date.now() },
        ...influenceAttrs({ misthalin: 200 }),
      },
      100
    );
    assert.equal(Switching.takeOath(p, "misthalin").reason, "insufficient-fee");

    // No quest before this court.
    p = mockPlayer("TestUser", { ...influenceAttrs({ misthalin: 200 }) }, 50000);
    assert.equal(Switching.takeOath(p, "misthalin").reason, "no-quest");
    console.log("ok - oath blocked until service, fee, and quest line up");
  });
});

describe("oath cooldown", () => {
  it("bars a new oath for 7 days after renouncing", () => {
    const p = mockPlayer("TestUser", {
      "kingdom:id": "asgarnia",
      ...influenceAttrs({ asgarnia: 0, misthalin: 200 }),
    });
    Switching.renounce(p, OTHER_IDS, () => 1);
    assert.ok(Switching.cooldownRemainingMs(p) > 0);
    assert.equal(Switching.cooldownDaysLeft(p), 7);

    // Petitioning is allowed during the cooldown; the oath is not.
    const started = Switching.startNaturalization(p, "misthalin");
    assert.equal(started.ok, true);
    const oath = Switching.takeOath(p, "misthalin");
    assert.equal(oath.ok, false);
    assert.equal(oath.reason, "on-cooldown");
    console.log("ok - 7-day cooldown enforced server-side");
  });

  it("releases the oath once the cooldown has elapsed", () => {
    const p = mockPlayer(
      "TestUser",
      {
        "kingdom:renounced-at": Date.now() - 8 * DAY_MS,
        "kingdom:naturalization": { kingdomId: "misthalin", startedAt: Date.now() },
        ...influenceAttrs({ misthalin: 200 }),
      },
      50000
    );
    assert.equal(Switching.cooldownRemainingMs(p), 0);
    const oath = Switching.takeOath(p, "misthalin");
    assert.equal(oath.ok, true);
    console.log("ok - oath allowed after cooldown");
  });
});

describe("tenure", () => {
  it("fresh oaths lack tenure; old oaths have it", () => {
    const fresh = mockPlayer("TestUser", {
      "kingdom:id": "asgarnia",
      "kingdom:oath-at": Date.now(),
    });
    assert.equal(Switching.hasTenure(fresh, "asgarnia"), false);

    const veteran = mockPlayer("TestUser", {
      "kingdom:id": "asgarnia",
      "kingdom:oath-at": Date.now() - 15 * DAY_MS,
    });
    assert.equal(Switching.hasTenure(veteran, "asgarnia"), true);
    assert.equal(Switching.tenureDaysOf(veteran, "asgarnia"), 15);
    console.log("ok - tenure measured from the oath timestamp");
  });

  it("grandfathers subjects sworn before the oath ledger", () => {
    // First recorded service 20 days ago, no oath-at: tenured.
    const old = mockPlayer("TestUser", {
      "kingdom:id": "asgarnia",
      ...influenceAttrs({ asgarnia: 10 }, 20 * DAY_MS),
    });
    assert.equal(Switching.hasTenure(old, "asgarnia"), true);
    // Nothing recorded at all: also tenured, never locked out.
    const ancient = mockPlayer("TestUser", { "kingdom:id": "asgarnia" });
    assert.equal(Switching.hasTenure(ancient, "asgarnia"), true);
    console.log("ok - pre-ledger subjects grandfathered");
  });

  it("gates office petitions on tenure (Politics)", () => {
    const Politics = require(path.resolve(KINGDOMS_DIR, "Politics.Kingdoms.js"));
    const emittedPolitics = [];
    Politics({
      core: { PlayerRights: { NONE: 0 } },
      registerCommand: () => {},
      emitCustomEvent: (n, pl) => emittedPolitics.push({ n, pl }),
    });

    // Fresh oath: the court will not hear the petition.
    const fresh = mockPlayer("Newcomer", {
      "kingdom:id": "asgarnia",
      "kingdom:oath-at": Date.now(),
      ...influenceAttrs({ asgarnia: 300 }),
    });
    Politics.petition(fresh, ["marshal"]);
    assert.equal(emittedPolitics.length, 0, "no office assigned");
    assert.ok(
      fresh.__messages.some((m) => m.includes("still fresh")),
      "tenure refusal messaged"
    );

    // Tenured: the petition proceeds (vacant office, influence clears 100).
    const veteran = mockPlayer("Newcomer", {
      "kingdom:id": "asgarnia",
      "kingdom:oath-at": Date.now() - 15 * DAY_MS,
      ...influenceAttrs({ asgarnia: 300 }),
    });
    Politics.petition(veteran, ["marshal"]);
    assert.ok(
      emittedPolitics.some((e) => e.n === "kingdom:office-assigned"),
      "tenured petition heard"
    );
    console.log("ok - office petitions tenure-gated");
  });

  it("gates strategic war powers on tenure (WarTableApi)", () => {
    stub("./Castle.Kingdoms", {});
    stub("./Siege.Kingdoms", { canDeclareSiege: () => ({ ok: true }) });
    stub("./Relations.Kingdoms", {});
    stub("./Wars.Kingdoms", {
      WAR_DECLARE_INFLUENCE_COST: 50,
      canDeclareWar: () => ({ ok: true }),
      declareWar: () => ({ ok: true, goalLabel: "plunder" }),
    });
    stub("./WarSupply.Kingdoms", {});
    stub("./Coalitions.Kingdoms", {});
    stub("./AiDiplomacy.Kingdoms", {});
    const WarTableApi = require(path.resolve(KINGDOMS_DIR, "WarTableApi.js"));

    const query = (params) => ({ get: (k) => params[k] ?? null });

    // Fresh oath: declare-war refused with the new-oath reason.
    const fresh = mockPlayer("TestUser", {
      "kingdom:id": "asgarnia",
      "kingdom:oath-at": Date.now(),
      ...influenceAttrs({ asgarnia: 500 }),
    });
    const blocked = WarTableApi._test.runWarfareAction({}, fresh, "declare-war", query({ target: "misthalin", goal: "loot" }));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "new-oath");

    // Tenured: the gate passes and the war is declared.
    const veteran = mockPlayer("TestUser", {
      "kingdom:id": "asgarnia",
      "kingdom:oath-at": Date.now() - 15 * DAY_MS,
      ...influenceAttrs({ asgarnia: 500 }),
    });
    const allowed = WarTableApi._test.runWarfareAction({}, veteran, "declare-war", query({ target: "misthalin", goal: "loot" }));
    assert.equal(allowed.ok, true);

    // The council buttons agree: the gate payload carries the same refusal.
    const gates = WarTableApi._test.warGatesFor(fresh, "asgarnia", Object.values(KINGDOMS));
    assert.equal(gates.misthalin.declareWar.ok, false);
    assert.equal(gates.misthalin.declareWar.reason, "new-oath");
    console.log("ok - strategic war powers tenure-gated");
  });
});

describe("hatred-tier interplay", () => {
  it("enemy-tier courts refuse the oath outright", () => {
    const p = mockPlayer(
      "TestUser",
      {
        "kingdom:naturalization": { kingdomId: "misthalin", startedAt: Date.now() },
        ...influenceAttrs({ misthalin: -120 }),
      },
      50000
    );
    assert.equal(
      Influence.hatredTier(Math.floor(Influence.effectiveInfluence(p, "misthalin"))),
      "enemy"
    );
    const res = Switching.takeOath(p, "misthalin");
    assert.equal(res.ok, false);
    assert.equal(res.reason, "unwelcome");
    assert.equal(p.__store["kingdom:id"] ?? null, null, "no allegiance granted");
    console.log("ok - enemy-tier oath refused");
  });
});

console.log("All Switching tests passed.");
