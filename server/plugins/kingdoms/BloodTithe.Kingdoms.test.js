"use strict";

/**
 * BloodTithe.Kingdoms tests.
 *
 * Covers: owed scaling (rich vs broke), collectTithe shortfall -> refusal
 * event + debt, notice->grace->wanted escalation over 3 forced rounds,
 * records-burned wiping debt (not standing), and the treasury income ledger
 * recording kind "tithe".
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../src/main/typescript/elvarg/game/task/Task") {
    return { Task: class Task {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Store = require("./KingdomStore");
const BloodTithe = require("./BloodTithe.Kingdoms");
const Bounties = require("./Bounties.Kingdoms");

const M = "morytania";
const COINS = 995;

function seed() {
  Store.resetForTests();
  Store.upsertKingdom({ id: M, name: "Morytania", capital: "Darkmeyer" });
  Store.getKingdom(M).treasury = 100000;
  Store.getKingdom(M).flags = {};
}

function mockPlayer({ username = "victim", coins = 1000, x = 3490, y = 3480, kingdom = M } = {}) {
  const attrs = { "kingdom:id": kingdom, "myreque:standing": 0 };
  const purse = { [COINS]: coins };
  const messages = [];
  return {
    messages,
    getUsername: () => username,
    isPlayerBot: () => false,
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    getInventory: () => ({
      getAmount: (id) => purse[id] ?? 0,
      delete: (id, n) => {
        purse[id] = Math.max(0, (purse[id] ?? 0) - n);
      },
      refreshItems: () => {},
    }),
    getLocation: () => ({ getX: () => x, getY: () => y }),
    sendMessage: (m) => messages.push(m),
    _purse: purse,
  };
}

function mockApi(players) {
  return {
    core: {
      World: {
        getPlayers: () => ({ stream: () => ({ toArray: () => players }) }),
      },
    },
  };
}

function collectEvents() {
  const events = [];
  return {
    events,
    emit: (name, payload) => events.push({ name, payload }),
  };
}

describe("BloodTithe", () => {
  beforeEach(seed);

  it("owed scaling: broke pays the floor, rich pays the cap", () => {
    const broke = mockPlayer({ coins: 0 });
    const rich = mockPlayer({ coins: 100000 });
    assert.equal(BloodTithe.titheOwedFor(broke, Store), BloodTithe.TITHE_FLOOR);
    assert.equal(BloodTithe.titheOwedFor(rich, Store), BloodTithe.TITHE_CAP);
    const mid = mockPlayer({ coins: 10000 });
    assert.equal(BloodTithe.titheOwedFor(mid, Store), 100 + 500); // floor + 5%
  });

  it("collectTithe moves coins, splits patrol share, records 'tithe' income", () => {
    const p = mockPlayer({ coins: 10000 });
    const { emit } = collectEvents();
    const due = BloodTithe.titheOwedFor(p, Store); // 600
    const before = Store.getKingdom(M).treasury;
    const { taken, shortfall } = BloodTithe.collectTithe(p, Store, { emit });
    assert.equal(taken, due);
    assert.equal(shortfall, 0);
    assert.equal(p._purse[COINS], 10000 - due);
    const patrol = Math.round(due * BloodTithe.PATROL_SHARE);
    const coffers = due - patrol;
    assert.equal(Store.getKingdom(M).treasury, before + coffers);
    assert.equal(Store.getKingdom(M).flags["morytania:blood-tithe:patrol-fund"], patrol);
    assert.equal(Store.getIncomeTotals(M).tithe, due);
  });

  it("shortfall records debt and emits kingdom:tithe-refused", () => {
    const p = mockPlayer({ coins: 10 });
    const bus = collectEvents();
    const due = BloodTithe.titheOwedFor(p, Store); // 100 floor + 0 = 100
    const { taken, shortfall } = BloodTithe.collectTithe(p, Store, { emit: bus.emit });
    assert.equal(taken, 10);
    assert.equal(shortfall, due - 10);
    const refused = bus.events.find((e) => e.name === "kingdom:tithe-refused");
    assert.ok(refused, "expected kingdom:tithe-refused");
    assert.equal(refused.payload.player, "victim");
    const debtFlag = Store.getKingdom(M).flags["morytania:blood-tithe:debt:victim"];
    assert.equal(debtFlag.debt, due - 10);
  });

  it("notice -> grace -> wanted over 3 forced rounds", () => {
    const p = mockPlayer({ username: "dodger", coins: 0 });
    const bus = collectEvents();
    const api = mockApi([p]);
    const stages = [];
    // watch via events + debt flags instead of monkeypatching
    for (let round = 1; round <= 3; round++) {
      const res = BloodTithe.runTitheRoundForce(api, Store, { emit: bus.emit });
      assert.ok(res.ok);
      stages.push(res.rounds);
    }
    assert.equal(stages[0].refused, 1);
    assert.equal(stages[2].wanted, 1);
    const rec = Bounties.wantedRecord("dodger", Store);
    assert.ok(rec, "expected a wanted record for the dodger");
    assert.equal(rec.crime, "tithe-evasion");
    assert.ok(rec.amount >= 500 && rec.amount <= 2000);
    // notice message went out on round 1
    assert.ok(p.messages.some((m) => m.includes("ledger")));
    // defiance standing awarded on the wanted round
    assert.ok(p.getAttribute("myreque:standing") > 0, "expected myreque standing from defiance");
    // notoriety event emitted for the citizen layer
    const notor = bus.events.find((e) => e.name === "blood-tithe:notoriety");
    assert.ok(notor);
    assert.equal(notor.payload.username, "dodger");
    // debt cleared after the wanted posting (ledger settled via the warrant)
    const debtFlag = Store.getKingdom(M).flags["morytania:blood-tithe:debt:dodger"];
    assert.ok(!debtFlag || debtFlag.debt === 0);
  });

  it("full payment resets the escalation streak", () => {
    const p = mockPlayer({ username: "flaky", coins: 0 });
    const bus = collectEvents();
    const api = mockApi([p]);
    BloodTithe.runTitheRoundForce(api, Store, { emit: bus.emit }); // notice
    p._purse[COINS] = 100000;
    BloodTithe.runTitheRoundForce(api, Store, { emit: bus.emit }); // pays
    p._purse[COINS] = 0;
    const res = BloodTithe.runTitheRoundForce(api, Store, { emit: bus.emit }); // notice again, not grace
    assert.equal(res.rounds.wanted, 0);
    const debtFlag = Store.getKingdom(M).flags["morytania:blood-tithe:debt:flaky"];
    assert.equal(debtFlag.streak, 1);
    assert.ok(p.messages.some((m) => m.includes("does not forget")), "expected notice, not grace");
  });

  it("players outside the beats and without a subject tie are skipped", () => {
    const p = mockPlayer({ username: "tourist", coins: 5000, x: 3200, y: 3200, kingdom: "misthalin" });
    const bus = collectEvents();
    const res = BloodTithe.runTitheRoundForce(mockApi([p]), Store, { emit: bus.emit });
    assert.ok(res.ok);
    assert.equal(res.rounds.collected, 0);
    assert.equal(p._purse[COINS], 5000);
  });

  it("daily throttle blocks a second normal round", () => {
    const p = mockPlayer({ coins: 5000 });
    const api = mockApi([p]);
    const first = BloodTithe.runTitheRound(api, Store, {});
    assert.ok(first.ok);
    const second = BloodTithe.runTitheRound(api, Store, {});
    assert.equal(second.ok, false);
    assert.equal(second.reason, "too-soon");
  });

  it("records-burned wipes debt but not standing", () => {
    const p = mockPlayer({ username: "ash", coins: 0 });
    p.setAttribute("myreque:standing", 40);
    const bus = collectEvents();
    BloodTithe.runTitheRoundForce(mockApi([p]), Store, { emit: bus.emit });
    assert.ok(Store.getKingdom(M).flags["morytania:blood-tithe:debt:ash"].debt > 0);
    Store.setFlag(M, "morytania:records-burned-at", Date.now());
    const { wiped } = BloodTithe.handleRecordsBurned(Store, { emit: bus.emit });
    assert.equal(wiped, 1);
    assert.ok(!("morytania:blood-tithe:debt:ash" in Store.getKingdom(M).flags));
    assert.equal(p.getAttribute("myreque:standing"), 40, "standing must survive");
    // second call is idempotent
    assert.equal(BloodTithe.handleRecordsBurned(Store, { emit: bus.emit }).wiped, 0);
    assert.ok(bus.events.some((e) => e.name === "kingdom:rumor"));
  });
});
