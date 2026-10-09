"use strict";

/**
 * Treasury.Kingdoms tests — the court's purse.
 *
 * collectTax: a small configurable coin tax lands in the kingdom treasury
 * whenever influence lands (fealty, promotion, task). Bots are excluded,
 * broke players pay nothing, the tax never blocks the honor.
 *
 * grantFromTreasury: office-holders grant treasury coins to a named player —
 * money rules enforced (cap, treasury covers it, real online recipient,
 * never a bot, never yourself).
 *
 * Event wiring: the full bus chain through Events.Kingdoms — rank-granted
 * (fealty + promotion hops) and task-completed collect the tax and emit
 * kingdom:tax-collected; quiet grants and donations do not tax.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const Store = require("./KingdomStore");
const Treasury = require("./Treasury.Kingdoms");
const Influence = require("./Influence.Kingdoms");

const LADDER = ["Subject", "Man-at-arms", "Knight", "Lord", "Regent", "Monarch"];

function mockPlayer({ coins = 0, bot = false, username = "test-player" } = {}) {
  const attrs = {};
  const messages = [];
  const inv = {
    coins,
    getAmount: (id) => (id === Treasury.COINS_ID ? inv.coins : 0),
    delete: (id, n) => {
      if (id === Treasury.COINS_ID) inv.coins = Math.max(0, inv.coins - n);
    },
    add: (id, n) => {
      if (id === Treasury.COINS_ID) inv.coins += n;
    },
    refreshItems: () => {},
  };
  return {
    username,
    messages,
    getUsername: () => username,
    isPlayerBot: () => bot,
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    getInventory: () => inv,
    sendMessage: (m) => messages.push(m),
    _inv: inv,
    _attrs: attrs,
  };
}

function seedAsgarnia(treasury = 100000) {
  Store.resetForTests();
  Store.upsertKingdom({
    id: "asgarnia",
    name: "Asgarnia",
    capital: "Falador",
    hierarchy: LADDER,
    treasury,
  });
}

beforeEach(() => {
  seedAsgarnia();
});

describe("collectTax", () => {
  it("takes the fealty tax from a player's purse into the treasury", () => {
    const p = mockPlayer({ coins: 1000 });
    const emitted = [];
    const taken = Treasury.collectTax(p, "asgarnia", "fealty", (n, pl) =>
      emitted.push({ name: n, payload: pl })
    );
    assert.equal(taken, Treasury.FEALTY_TAX);
    assert.equal(p._inv.coins, 1000 - Treasury.FEALTY_TAX);
    assert.equal(Store.getKingdom("asgarnia").treasury, 100000 + Treasury.FEALTY_TAX);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].name, "kingdom:tax-collected");
    assert.equal(emitted[0].payload.source, "fealty");
    assert.equal(emitted[0].payload.amount, Treasury.FEALTY_TAX);
  });

  it("promotion and task kinds use their own rates", () => {
    const p = mockPlayer({ coins: 1000 });
    assert.equal(Treasury.collectTax(p, "asgarnia", "promotion", null), Treasury.PROMOTION_TAX);
    assert.equal(Treasury.collectTax(p, "asgarnia", "task", null), Treasury.TASK_TAX);
    assert.equal(Treasury.collectTax(p, "asgarnia", "bogus", null), 0);
    assert.equal(
      Store.getKingdom("asgarnia").treasury,
      100000 + Treasury.PROMOTION_TAX + Treasury.TASK_TAX
    );
  });

  it("bots are excluded — the director owns their wealth", () => {
    const p = mockPlayer({ coins: 1000, bot: true });
    const emitted = [];
    assert.equal(Treasury.collectTax(p, "asgarnia", "fealty", (n, pl) => emitted.push(n)), 0);
    assert.equal(p._inv.coins, 1000);
    assert.equal(Store.getKingdom("asgarnia").treasury, 100000);
    assert.equal(emitted.length, 0);
  });

  it("a broke player pays nothing and the honor still lands", () => {
    const p = mockPlayer({ coins: 0 });
    assert.equal(Treasury.collectTax(p, "asgarnia", "fealty", null), 0);
    assert.equal(Store.getKingdom("asgarnia").treasury, 100000);
  });

  it("takes what a poor player carries, never more", () => {
    const p = mockPlayer({ coins: 10 });
    const taken = Treasury.collectTax(p, "asgarnia", "fealty", null);
    assert.equal(taken, 10);
    assert.equal(p._inv.coins, 0);
    assert.equal(Store.getKingdom("asgarnia").treasury, 100010);
  });

  it("unknown kingdom moves no coins", () => {
    const p = mockPlayer({ coins: 1000 });
    assert.equal(Treasury.collectTax(p, "nowhere", "fealty", null), 0);
    assert.equal(p._inv.coins, 1000);
  });

  it("records the last collection for the steward's survey", () => {
    const p = mockPlayer({ coins: 1000 });
    Treasury.collectTax(p, "asgarnia", "task", null);
    const last = Treasury.lastTax("asgarnia");
    assert.ok(last);
    assert.equal(last.amount, Treasury.TASK_TAX);
    assert.equal(last.source, "task");
    assert.ok(last.at > 0);
  });
});

describe("grantFromTreasury", () => {
  it("moves coins from the treasury to the named player's purse", () => {
    const granter = mockPlayer({ username: "steward_bob" });
    const target = mockPlayer({ username: "alice", coins: 0 });
    const out = Treasury.grantFromTreasury("asgarnia", granter, target, 5000);
    assert.equal(out.ok, true);
    assert.equal(out.granted, 5000);
    assert.equal(target._inv.coins, 5000);
    assert.equal(Store.getKingdom("asgarnia").treasury, 95000);
  });

  it("refuses when the coffers cannot bear it", () => {
    const granter = mockPlayer({ username: "steward_bob" });
    const target = mockPlayer({ username: "alice" });
    const out = Treasury.grantFromTreasury("asgarnia", granter, target, 100001);
    assert.equal(out.ok, false);
    assert.equal(Store.getKingdom("asgarnia").treasury, 100000);
    assert.equal(target._inv.coins, 0);
  });

  it("enforces the single-grant cap", () => {
    seedAsgarnia(1000000);
    const granter = mockPlayer({ username: "steward_bob" });
    const target = mockPlayer({ username: "alice" });
    const out = Treasury.grantFromTreasury("asgarnia", granter, target, Treasury.GRANT_MAX + 1);
    assert.equal(out.ok, false);
    assert.equal(Store.getKingdom("asgarnia").treasury, 1000000);
  });

  it("rejects zero, negative, and non-numeric sums", () => {
    const granter = mockPlayer({ username: "steward_bob" });
    const target = mockPlayer({ username: "alice" });
    for (const bad of [0, -50, "lots", null]) {
      assert.equal(Treasury.grantFromTreasury("asgarnia", granter, target, bad).ok, false);
    }
    assert.equal(Store.getKingdom("asgarnia").treasury, 100000);
  });

  it("rejects an offline recipient and a bot recipient", () => {
    const granter = mockPlayer({ username: "steward_bob" });
    assert.equal(Treasury.grantFromTreasury("asgarnia", granter, null, 100).ok, false);
    assert.equal(
      Treasury.grantFromTreasury("asgarnia", granter, { noPlayer: true }, 100).ok,
      false
    );
    const botTarget = mockPlayer({ username: "bot_1", bot: true });
    assert.equal(Treasury.grantFromTreasury("asgarnia", granter, botTarget, 100).ok, false);
    assert.equal(Store.getKingdom("asgarnia").treasury, 100000);
  });

  it("rejects grants to yourself — the ledgers are watched", () => {
    const granter = mockPlayer({ username: "steward_bob" });
    const same = mockPlayer({ username: "Steward_Bob" });
    const out = Treasury.grantFromTreasury("asgarnia", granter, same, 100);
    assert.equal(out.ok, false);
    assert.match(out.message, /yourself/);
    assert.equal(Store.getKingdom("asgarnia").treasury, 100000);
  });
});

describe("event wiring (Events.Kingdoms)", () => {
  function wireBus() {
    const handlers = {};
    const taxEvents = [];
    const api = {
      onCustomEvent: (name, fn) => {
        handlers[name] = fn;
      },
      emitCustomEvent: (name, payload) => {
        if (name === "kingdom:tax-collected") taxEvents.push(payload);
        if (handlers[name]) handlers[name](payload);
      },
      persistAttribute: () => {},
      registerCommand: () => {},
      core: {},
    };
    require("./Events.Kingdoms")(api);
    return { api, taxEvents };
  }

  function busPlayer(opts = {}) {
    const p = mockPlayer(opts);
    p.sendMessage = (m) => p.messages.push(m);
    return p;
  }

  it("fealty (rank-granted) collects the tax and emits tax-collected", () => {
    const { api, taxEvents } = wireBus();
    const p = busPlayer({ coins: 500 });
    api.emitCustomEvent("kingdom:rank-granted", {
      player: p,
      kingdomId: "asgarnia",
      rank: "Subject",
    });
    assert.equal(p._inv.coins, 500 - Treasury.FEALTY_TAX);
    assert.equal(Store.getKingdom("asgarnia").treasury, 100000 + Treasury.FEALTY_TAX);
    assert.equal(taxEvents.length, 1);
    assert.equal(taxEvents[0].source, "fealty");
    assert.equal(taxEvents[0].amount, Treasury.FEALTY_TAX);
  });

  it("quiet rank grants (office honorifics) are not taxed", () => {
    const { api, taxEvents } = wireBus();
    const p = busPlayer({ coins: 500 });
    api.emitCustomEvent("kingdom:rank-granted", {
      player: p,
      kingdomId: "asgarnia",
      rank: "Subject",
      title: "Steward of Asgarnia",
      quiet: true,
    });
    assert.equal(p._inv.coins, 500);
    assert.equal(taxEvents.length, 0);
  });

  it("bots swearing fealty are not taxed", () => {
    const { api, taxEvents } = wireBus();
    const p = busPlayer({ coins: 500, bot: true });
    api.emitCustomEvent("kingdom:rank-granted", {
      player: p,
      kingdomId: "asgarnia",
      rank: "Subject",
    });
    assert.equal(p._inv.coins, 500);
    assert.equal(taxEvents.length, 0);
  });

  it("task-completed collects the task tax", () => {
    const { api, taxEvents } = wireBus();
    const p = busPlayer({ coins: 500 });
    api.emitCustomEvent("kingdom:task-completed", {
      player: p,
      kingdomId: "asgarnia",
      task: "raid",
    });
    assert.equal(p._inv.coins, 500 - Treasury.TASK_TAX);
    assert.equal(taxEvents.length, 1);
    assert.equal(taxEvents[0].source, "task");
  });

  it("an earned promotion taxes each hop exactly once, then settles", () => {
    const { api, taxEvents } = wireBus();
    const p = busPlayer({ coins: 10000 });
    // 300 influence already earned: the next rank-granted promotes to Knight.
    Influence.addInfluence(p, "asgarnia", 300);
    api.emitCustomEvent("kingdom:rank-granted", {
      player: p,
      kingdomId: "asgarnia",
      rank: "Subject",
    });
    assert.equal(p._attrs["kingdom:rank"], "Knight");
    const sources = taxEvents.map((e) => e.source).sort();
    assert.deepEqual(sources, ["fealty", "promotion"]);
    assert.equal(
      Store.getKingdom("asgarnia").treasury,
      100000 + Treasury.FEALTY_TAX + Treasury.PROMOTION_TAX
    );
  });

  it("donations are not taxed — the gift itself already moved", () => {
    const { api, taxEvents } = wireBus();
    const p = busPlayer({ coins: 500 });
    api.emitCustomEvent("kingdom:donation-made", {
      player: p,
      kingdomId: "asgarnia",
      amount: 1000,
    });
    assert.equal(taxEvents.length, 0);
    assert.equal(Store.getKingdom("asgarnia").treasury, 100000);
  });
});
