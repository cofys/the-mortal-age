"use strict";

// CitizenArtisans unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const A = require("./CitizenArtisans");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- hashName: deterministic, spreads ---
check("hashName is deterministic", () => {
  assert.equal(A.hashName("Liam Cofy"), A.hashName("Liam Cofy"));
  assert.equal(A.hashName("Liam Cofy"), A.hashName("liam cofy")); // case-insensitive
});

check("hashName spreads across names", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(A.hashName(`citizen${i}`));
  assert.ok(seen.size > 40, `expected spread, got ${seen.size}`);
});

// --- tradeFor: stable, valid ---
check("tradeFor is stable and valid", () => {
  const t = A.tradeFor("Liam Cofy");
  assert.ok(A.TRADE_KEYS.includes(t), `unknown trade ${t}`);
  assert.equal(A.tradeFor("Liam Cofy"), t);
});

check("tradeFor covers all five trades across a roster", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(A.tradeFor(`artisan-candidate-${i}`));
  assert.deepEqual([...seen].sort(), [...A.TRADE_KEYS].sort());
});

// --- masterpieceName / commissionSpec ---
check("masterpieceName has a unique name and a trade item", () => {
  const rng = lcg(7);
  const name = A.masterpieceName(rng, "blacksmith");
  assert.ok(name.includes("masterwork"), name);
  assert.ok(
    A.TRADES.blacksmith.items.some((i) => name.includes(i)),
    name
  );
});

check("masterpieceName returns null for unknown trade", () => {
  assert.equal(A.masterpieceName(lcg(1), "necromancer"), null);
});

check("commissionSpec has item and detail", () => {
  const spec = A.commissionSpec(lcg(42), "jeweler");
  assert.ok(spec.item && spec.detail, JSON.stringify(spec));
  assert.ok(A.TRADES.jeweler.items.includes(spec.item));
});

// --- renownTitle thresholds ---
check("renownTitle thresholds", () => {
  assert.equal(A.renownTitle(0), "");
  assert.equal(A.renownTitle(4), "");
  assert.equal(A.renownTitle(5), "known");
  assert.equal(A.renownTitle(14), "known");
  assert.equal(A.renownTitle(15), "renowned");
  assert.equal(A.renownTitle(29), "renowned");
  assert.equal(A.renownTitle(30), "master");
  assert.equal(A.renownTitle(999), "master");
});

// --- isRealPlayer / withinTiles ---
check("isRealPlayer gates bots and nulls", () => {
  assert.equal(A.isRealPlayer(null), false);
  assert.equal(A.isRealPlayer({ isPlayerBot: () => true }), false);
  assert.equal(A.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(A.isRealPlayer({ getUsername: () => "Jon" }), true);
});

function fakeAt(x, y, z = 0) {
  return {
    getLocation: () => ({
      getX: () => x,
      getY: () => y,
      getZ: () => z,
    }),
  };
}

check("withinTiles uses Chebyshev on the same plane", () => {
  assert.equal(A.withinTiles(fakeAt(0, 0), fakeAt(3, 4), 4), true);
  assert.equal(A.withinTiles(fakeAt(0, 0), fakeAt(3, 4), 3), false);
  assert.equal(A.withinTiles(fakeAt(0, 0, 1), fakeAt(0, 0, 0), 40), false);
});

// --- eligibleArtisan: commoners only ---
check("eligibleArtisan accepts commoners, rejects others", () => {
  assert.equal(A.eligibleArtisan({ username: "Amy", role: "commoner" }), true);
  assert.equal(A.eligibleArtisan({ username: "Bob", role: "merchant" }), false);
  assert.equal(A.eligibleArtisan({ username: "Cat", role: "guard" }), false);
  assert.equal(A.eligibleArtisan({ username: "Dan", role: "courtier" }), false);
  assert.equal(A.eligibleArtisan(null), false);
});

// --- tickArtisans: roster rebuild caps at one per trade per kingdom ---
function fakeDirector(records) {
  return {
    roster: new Map(records.map((r) => [r.username, r])),
    isOnline: () => true,
    getBot: () => null,
    api: { core: {} },
  };
}

check("tickArtisans caps artisans at one per trade per kingdom", () => {
  A._artisans.clear();
  A._renown.clear();
  // 30 commoners in one kingdom: at most 5 artisans (one per trade).
  const records = [];
  for (let i = 0; i < 30; i++) {
    records.push({ username: `commoner${i}`, role: "commoner", kingdomId: "asgarnia" });
  }
  A.tickArtisans(fakeDirector(records), 1_000_000);
  assert.ok(A._artisans.size <= 5, `expected <=5, got ${A._artisans.size}`);
  assert.ok(A._artisans.size > 0, "expected some artisans");
  const slots = new Set();
  for (const info of A._artisans.values()) {
    const slot = `${info.kingdomId}:${info.trade}`;
    assert.ok(!slots.has(slot), `duplicate slot ${slot}`);
    slots.add(slot);
  }
});

check("tickArtisans is deterministic across rebuilds", () => {
  const before = [...A._artisans.keys()].sort().join(",");
  A.tickArtisans(
    fakeDirector(
      [...Array(30)].map((_, i) => ({
        username: `commoner${i}`,
        role: "commoner",
        kingdomId: "asgarnia",
      }))
    ),
    2_000_000
  );
  const after = [...A._artisans.keys()].sort().join(",");
  assert.equal(after, before);
});

// --- commissions: mechanics without a server ---
check("commissionItem registers and completes a commission", () => {
  A._artisans.clear();
  A._commissions.clear();
  A._renown.clear();
  A._artisans.set("amy", { trade: "tailor", kingdomId: "asgarnia", display: "Amy" });
  const now = 10_000_000;
  const id = A.commissionItem("amy", "Jon", "tailor", "silk robe", "in your house colors", now);
  assert.ok(id, "commission should register");
  assert.equal(A._renown.get("amy") ?? 0, 0, "no renown until completion");
  // Wrong trade rejected.
  assert.equal(A.commissionItem("amy", "Jon", "blacksmith", "sword", "sharp", now), null);
  // Fast-forward past the commission duration: completion bumps renown.
  A.tickArtisans(
    { roster: new Map(), isOnline: () => false, getBot: () => null, api: { core: {} } },
    now + A.COMMISSION_MS + 1000
  );
  assert.equal(A._renown.get("amy"), A.RENOWN_COMMISSION);
  const c = A._commissions.get(id);
  assert.ok(c.completedAt, "commission should be completed");
  assert.equal(c.announced, false, "announcement happens on the fast tick");
});

check("commissionItem respects the per-artisan active cap", () => {
  A._artisans.clear();
  A._commissions.clear();
  A._artisans.set("bob", { trade: "blacksmith", kingdomId: "asgarnia", display: "Bob" });
  // Bypass the new-commission cooldown by spacing calls.
  let ok = 0;
  for (let i = 0; i < 10; i++) {
    const id = A.commissionItem(
      "bob",
      `player${i}`,
      "blacksmith",
      "rune longsword",
      "sharp",
      20_000_000 + i * (31 * 60 * 1000)
    );
    if (id) ok++;
  }
  assert.ok(ok <= A.MAX_ACTIVE_COMMISSIONS, `expected cap ${A.MAX_ACTIVE_COMMISSIONS}, got ${ok}`);
});

console.log(`\n${passed} assertions passed.`);
