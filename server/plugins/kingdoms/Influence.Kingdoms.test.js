"use strict";

/**
 * Influence earned-promotion checks — the kingdom choice as a progression
 * path. Service (donations, tasks, fealty) earns influence; crossing a
 * threshold promotes the player through their own kingdom's hierarchy via
 * kingdom:rank-granted. No owner command, no demotion, Monarch never earned,
 * bots excluded (the citizens director owns their promotions).
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const Influence = require("./Influence.Kingdoms");

const LADDER = ["Outsider", "Subject", "Man-at-arms", "Knight", "Lord", "Regent", "Monarch"];
const DAY_MS = 24 * 60 * 60 * 1000;

function mockPlayer({ kingdomId = "asgarnia", rank = "Subject", influenceByKingdom = {}, bot = false } = {}) {
  const attrs = {
    "kingdom:id": kingdomId,
    "kingdom:rank": rank,
    "kingdom:influence": Object.fromEntries(
      Object.entries(influenceByKingdom).map(([k, points]) => [
        k,
        { points, firstEarned: Date.now(), lastEarned: Date.now() },
      ])
    ),
  };
  return {
    username: "test-player",
    getAttribute: (key) => attrs[key] ?? null,
    setAttribute: (key, val) => {
      attrs[key] = val;
    },
    isPlayerBot: () => bot,
    _attrs: () => attrs,
  };
}

describe("rankForInfluence", () => {
  it("Subject below the first threshold", () => {
    assert.equal(Influence.rankForInfluence(0), "Subject");
    assert.equal(Influence.rankForInfluence(99), "Subject");
  });
  it("Man-at-arms at 100 — the petition threshold", () => {
    assert.equal(Influence.rankForInfluence(100), "Man-at-arms");
    assert.equal(Influence.rankForInfluence(299), "Man-at-arms");
  });
  it("Knight at 300, Lord at 800, Regent at 2000", () => {
    assert.equal(Influence.rankForInfluence(300), "Knight");
    assert.equal(Influence.rankForInfluence(799), "Knight");
    assert.equal(Influence.rankForInfluence(800), "Lord");
    assert.equal(Influence.rankForInfluence(1999), "Lord");
    assert.equal(Influence.rankForInfluence(2000), "Regent");
  });
  it("never Monarch, however much is served", () => {
    assert.equal(Influence.rankForInfluence(100000), "Regent");
  });
});

describe("promotionTarget", () => {
  it("promotes a Subject who crossed 100", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: 150 } });
    assert.equal(Influence.promotionTarget(p, "asgarnia", LADDER), "Man-at-arms");
  });
  it("null when the rank is already held", () => {
    const p = mockPlayer({ rank: "Man-at-arms", influenceByKingdom: { asgarnia: 150 } });
    assert.equal(Influence.promotionTarget(p, "asgarnia", LADDER), null);
  });
  it("skips straight to the highest earned rank", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: 900 } });
    assert.equal(Influence.promotionTarget(p, "asgarnia", LADDER), "Lord");
  });
  it("never demotes when influence decayed below the held rank", () => {
    const p = mockPlayer({ rank: "Knight", influenceByKingdom: { asgarnia: 40 } });
    assert.equal(Influence.promotionTarget(p, "asgarnia", LADDER), null);
  });
  it("null for a Regent — nothing higher is earnable", () => {
    const p = mockPlayer({ rank: "Regent", influenceByKingdom: { asgarnia: 99999 } });
    assert.equal(Influence.promotionTarget(p, "asgarnia", LADDER), null);
  });
  it("null for another kingdom's influence", () => {
    const p = mockPlayer({ kingdomId: "asgarnia", influenceByKingdom: { misthalin: 500 } });
    assert.equal(Influence.promotionTarget(p, "misthalin", LADDER), null);
  });
  it("null for the kingdomless (Wanderer)", () => {
    const p = mockPlayer({ kingdomId: null, influenceByKingdom: { asgarnia: 500 } });
    assert.equal(Influence.promotionTarget(p, "asgarnia", LADDER), null);
  });
  it("null for bots — the director owns their promotions", () => {
    const p = mockPlayer({ bot: true, influenceByKingdom: { asgarnia: 500 } });
    assert.equal(Influence.promotionTarget(p, "asgarnia", LADDER), null);
  });
  it("null when the earned rank is not in this kingdom's hierarchy", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: 500 } });
    assert.equal(Influence.promotionTarget(p, "asgarnia", ["Outsider", "Subject"]), null);
  });
  it("null for players without setAttribute", () => {
    assert.equal(Influence.promotionTarget({ getAttribute: () => "asgarnia" }, "asgarnia", LADDER), null);
    assert.equal(Influence.promotionTarget(null, "asgarnia", LADDER), null);
  });
  it("tenure bonus counts toward the threshold", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: 75 } });
    const rec = p._attrs()["kingdom:influence"].asgarnia;
    rec.firstEarned = Date.now() - 40 * DAY_MS; // +30 tenure, capped
    assert.equal(Influence.promotionTarget(p, "asgarnia", LADDER), "Man-at-arms");
  });
  it("decayed raw points are honestly priced", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: 150 } });
    const rec = p._attrs()["kingdom:influence"].asgarnia;
    rec.lastEarned = Date.now() - 40 * DAY_MS; // 150 - 80 decay = 70
    assert.equal(Influence.promotionTarget(p, "asgarnia", LADDER), null);
  });
});

describe("settlePromotion", () => {
  it("emits kingdom:rank-granted with via:service and returns the rank", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: 320 } });
    const emitted = [];
    const rank = Influence.settlePromotion(p, "asgarnia", LADDER, (payload) => emitted.push(payload));
    assert.equal(rank, "Knight");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].player, p);
    assert.equal(emitted[0].kingdomId, "asgarnia");
    assert.equal(emitted[0].rank, "Knight");
    assert.equal(emitted[0].via, "service");
  });
  it("emits nothing when nothing is earned", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: 10 } });
    const emitted = [];
    const rank = Influence.settlePromotion(p, "asgarnia", LADDER, (payload) => emitted.push(payload));
    assert.equal(rank, null);
    assert.equal(emitted.length, 0);
  });
  it("no emit function, no crash", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: 320 } });
    assert.equal(Influence.settlePromotion(p, "asgarnia", LADDER, null), null);
  });
});

describe("event chain (Events.Kingdoms)", () => {
  // Seed Asgarnia in the store for the chain (the repo save file is unseeded).
  const Store = require("./KingdomStore");
  const origGetKingdom = Store.getKingdom;
  Store.getKingdom = (id) =>
    id === "asgarnia"
      ? { id: "asgarnia", name: "Asgarnia", hierarchy: LADDER }
      : origGetKingdom(id);

  function busPlayer() {
    const p = mockPlayer({ kingdomId: null, rank: null, influenceByKingdom: {} });
    p.messages = [];
    p.sendMessage = (m) => p.messages.push(m);
    return p;
  }

  function wireBus() {
    const handlers = {};
    const api = {
      onCustomEvent: (name, fn) => {
        handlers[name] = fn;
      },
      emitCustomEvent: (name, payload) => {
        if (handlers[name]) handlers[name](payload);
      },
      persistAttribute: () => {},
      registerCommand: () => {},
      core: {},
    };
    require("./Events.Kingdoms")(api);
    return api;
  }

  it("fealty writes membership and ledgers influence, but promotes nothing", () => {
    const api = wireBus();
    const p = busPlayer();
    api.emitCustomEvent("kingdom:rank-granted", { player: p, kingdomId: "asgarnia", rank: "Subject" });
    const attrs = p._attrs();
    assert.equal(attrs["kingdom:id"], "asgarnia");
    assert.equal(attrs["kingdom:rank"], "Subject");
    assert.equal(Influence.effectiveInfluence(p, "asgarnia"), 10);
    assert.ok(!p.messages.some((m) => m.includes("named")), "no promotion message on fealty");
  });

  it("a big war-effort donation promotes straight to the earned rank", () => {
    const api = wireBus();
    const p = busPlayer();
    api.emitCustomEvent("kingdom:rank-granted", { player: p, kingdomId: "asgarnia", rank: "Subject" });
    api.emitCustomEvent("kingdom:donation-made", { player: p, kingdomId: "asgarnia", amount: 100000 });
    // 10 fealty + 1000 donation influence = 1010 -> Lord (one hop, not a cascade).
    assert.equal(p._attrs()["kingdom:rank"], "Lord");
    assert.ok(
      p.messages.some((m) => m.includes("named Lord of Asgarnia")),
      "court announces the promotion"
    );
  });

  it("kingdom:task-completed can also trigger a promotion", () => {
    const api = wireBus();
    const p = busPlayer();
    api.emitCustomEvent("kingdom:rank-granted", { player: p, kingdomId: "asgarnia", rank: "Subject" });
    // 95 influence banked + 25 task = 120 -> Man-at-arms.
    Influence.addInfluence(p, "asgarnia", 95);
    api.emitCustomEvent("kingdom:task-completed", { player: p, kingdomId: "asgarnia", task: "raid" });
    assert.equal(p._attrs()["kingdom:rank"], "Man-at-arms");
  });

  it("a second settle after promotion is a no-op (chain terminates)", () => {
    const api = wireBus();
    const p = busPlayer();
    api.emitCustomEvent("kingdom:rank-granted", { player: p, kingdomId: "asgarnia", rank: "Subject" });
    api.emitCustomEvent("kingdom:donation-made", { player: p, kingdomId: "asgarnia", amount: 100000 });
    const messages = p.messages.length;
    api.emitCustomEvent("kingdom:donation-made", { player: p, kingdomId: "asgarnia", amount: 100 });
    assert.equal(p._attrs()["kingdom:rank"], "Lord");
    assert.equal(p.messages.length, messages + 1, "only the donation message, no second promotion");
  });
});
