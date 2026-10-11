"use strict";

/**
 * Hatred: negative influence. Influence can sink below zero (to HATRED_FLOOR)
 * via addInfluence with a negative amount and a reason ("oathbreaking",
 * "assault", "theft", "war-treason"). Consequence tiers: disliked (< 0),
 * hated (<= -25), enemy (<= -100). Negative influence decays toward zero
 * slowly; positive service while negative earns at half rate.
 * breakOath applies the oathbreaking hit plus word-spread to other kingdoms.
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const Influence = require("./Influence.Kingdoms");

const DAY_MS = 24 * 60 * 60 * 1000;

function mockPlayer({ influenceByKingdom = {} } = {}) {
  const attrs = {
    "kingdom:influence": Object.fromEntries(
      Object.entries(influenceByKingdom).map(([k, v]) => {
        const rec =
          typeof v === "object" && v !== null
            ? v
            : { points: v, firstEarned: Date.now(), lastEarned: Date.now() };
        return [k, { ...rec }];
      })
    ),
  };
  return {
    getAttribute: (key) => attrs[key] ?? null,
    setAttribute: (key, val) => {
      attrs[key] = val;
    },
    isPlayerBot: () => false,
    _attrs: () => attrs,
  };
}

describe("hatredTier", () => {
  it("null when neutral or positive", () => {
    assert.equal(Influence.hatredTier(0), null);
    assert.equal(Influence.hatredTier(50), null);
    assert.equal(Influence.hatredTier(1000), null);
  });
  it("disliked just below zero", () => {
    assert.equal(Influence.hatredTier(-1), "disliked");
    assert.equal(Influence.hatredTier(-24), "disliked");
  });
  it("hated at -25 through -99", () => {
    assert.equal(Influence.hatredTier(-25), "hated");
    assert.equal(Influence.hatredTier(-99), "hated");
  });
  it("enemy at -100 and below", () => {
    assert.equal(Influence.hatredTier(-100), "enemy");
    assert.equal(Influence.hatredTier(-150), "enemy");
  });
});

describe("addInfluence (negative)", () => {
  it("accepts negative amounts and records the reason", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: 40 } });
    const pts = Influence.addInfluence(p, "asgarnia", -30, "assault");
    assert.equal(pts, 10);
    assert.equal(p._attrs()["kingdom:influence"].asgarnia.lastReason, "assault");
  });
  it("floors at HATRED_FLOOR", () => {
    const p = mockPlayer();
    const pts = Influence.addInfluence(p, "morytania", -999, "oathbreaking");
    assert.equal(pts, Influence.HATRED_FLOOR);
    assert.equal(Influence.HATRED_FLOOR, -150);
  });
  it("rejects zero, NaN, and non-numbers", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: 20 } });
    assert.equal(Influence.addInfluence(p, "asgarnia", 0), 0);
    assert.equal(Influence.addInfluence(p, "asgarnia", NaN), 0);
    assert.equal(Influence.addInfluence(p, "asgarnia", "nope"), 0);
    assert.equal(p._attrs()["kingdom:influence"].asgarnia.points, 20);
  });
  it("positive service while negative earns at half rate", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: -100 } });
    const pts = Influence.addInfluence(p, "asgarnia", 40);
    assert.equal(pts, -80); // -100 + 40 * 0.5
  });
  it("positive service at zero or above earns full rate", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: 0 } });
    assert.equal(Influence.addInfluence(p, "asgarnia", 40), 40);
  });
});

describe("hatred decay", () => {
  it("negative influence rises toward zero at 1/day", () => {
    const threeDaysAgo = Date.now() - 3 * DAY_MS;
    const p = mockPlayer({
      influenceByKingdom: {
        asgarnia: { points: -50, firstEarned: threeDaysAgo, lastEarned: threeDaysAgo },
      },
    });
    assert.equal(Influence.effectiveInfluence(p, "asgarnia"), -47 + 3); // -47 points + 3 tenure
  });
  it("positive decay never crosses into hatred", () => {
    const tenDaysAgo = Date.now() - 10 * DAY_MS;
    const p = mockPlayer({
      influenceByKingdom: {
        asgarnia: { points: 5, firstEarned: tenDaysAgo, lastEarned: tenDaysAgo },
      },
    });
    // 5 - 10*2 would be -15, but positive decay floors at zero.
    assert.ok(Influence.effectiveInfluence(p, "asgarnia") >= 0);
  });
  it("tenure softens hatred (long service is remembered)", () => {
    const thirtyDaysAgo = Date.now() - 30 * DAY_MS;
    const p = mockPlayer({
      influenceByKingdom: {
        asgarnia: { points: -40, firstEarned: thirtyDaysAgo, lastEarned: Date.now() },
      },
    });
    // -40 points + 30 capped tenure = -10 effective → disliked, not hated.
    assert.equal(Influence.hatredTier(Influence.effectiveInfluence(p, "asgarnia")), "disliked");
  });
});

describe("breakOath", () => {
  it("hits the abandoned kingdom and spreads word on a lucky roll", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: 120 } });
    const result = Influence.breakOath(p, "asgarnia", ["misthalin", "kandarin"], () => 0.0);
    assert.equal(result.oldKingdomId, "asgarnia");
    assert.equal(result.oldPoints, 45); // 120 - 75
    assert.deepEqual(result.spreadTo.sort(), ["kandarin", "misthalin"]);
    const recs = p._attrs()["kingdom:influence"];
    assert.equal(recs.misthalin.points, -15);
    assert.equal(recs.misthalin.lastReason, "oathbreaking");
  });
  it("word does not always spread (unlucky roll)", () => {
    const p = mockPlayer();
    const result = Influence.breakOath(p, "asgarnia", ["misthalin"], () => 0.99);
    assert.deepEqual(result.spreadTo, []);
    assert.equal(p._attrs()["kingdom:influence"].misthalin, undefined);
  });
  it("never spreads to the abandoned kingdom itself", () => {
    const p = mockPlayer();
    const result = Influence.breakOath(p, "asgarnia", ["asgarnia"], () => 0.0);
    assert.deepEqual(result.spreadTo, []);
  });
  it("oathbreaking can drive a new citizen to hated", () => {
    const p = mockPlayer({ influenceByKingdom: { asgarnia: 10 } });
    const result = Influence.breakOath(p, "asgarnia", [], () => 0.99);
    assert.equal(result.oldPoints, -65); // 10 - 75
    assert.equal(
      Influence.hatredTier(Influence.effectiveInfluence(p, "asgarnia")),
      "hated"
    );
  });
  it("returns null on bad args", () => {
    assert.equal(Influence.breakOath(null, "asgarnia", []), null);
    assert.equal(Influence.breakOath(mockPlayer(), null, []), null);
  });
});
