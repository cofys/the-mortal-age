// CitizenTradeCaravans unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  hashStr,
  routeKey,
  allRoutes,
  departureOffsetMs,
  riskFor,
  cityName,
  pickOne,
  fill,
  pickCrew,
  buildCargo,
  cargoValue,
  guardWage,
  resolveBanditAttack,
  netProfit,
  splitShares,
  isRealPlayer,
  withinTiles,
  INVITE_KIND_GUARD,
  INVITE_KIND_TRADER,
  MAX_PLAYER_GUARDS,
  MAX_PLAYER_TRADERS,
  TRADER_SHARE_PCT,
  ROUTE_CADENCE_MS,
} = require("./CitizenTradeCaravans");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- route math ---
assert.equal(routeKey("asgarnia", "kandarin"), "asgarnia->kandarin");

const kingdoms = ["asgarnia", "kandarin", "keldagrim", "misthalin", "morytania"];
const routes = allRoutes(kingdoms);
assert.equal(routes.length, 20, "5 kingdoms => 20 ordered pairs");
assert.ok(!routes.some((r) => r.from === r.to), "no self-routes");
assert.ok(routes.some((r) => r.key === "misthalin->morytania"));

const offA = departureOffsetMs("asgarnia->kandarin");
const offB = departureOffsetMs("asgarnia->kandarin");
assert.equal(offA, offB, "offset deterministic");
assert.ok(offA >= 0 && offA < ROUTE_CADENCE_MS, "offset within cadence");
const offs = new Set(routes.map((r) => departureOffsetMs(r.key)));
assert.ok(offs.size > 10, "offsets spread across routes");

const risk = riskFor("asgarnia->kandarin");
assert.ok(risk >= 0.1 && risk <= 0.3, `risk in range, got ${risk}`);
assert.equal(riskFor("asgarnia->kandarin"), risk, "risk deterministic");

assert.equal(typeof cityName("asgarnia"), "string");
assert.ok(cityName("asgarnia").length > 0);

// --- templates ---
assert.equal(fill("to {city} for {wage}", { city: "Ardougne", wage: 200 }), "to Ardougne for 200");
assert.equal(fill("no tokens", {}), "no tokens");
const rng = lcg(42);
assert.ok(["a", "b"].includes(pickOne(rng, ["a", "b"])));

// --- crew ---
const candidates = [
  { username: "MerchA", role: "merchant", kingdomId: "asgarnia" },
  { username: "MerchB", role: "merchant", kingdomId: "kandarin" },
  { username: "Guard1", role: "guard", kingdomId: "asgarnia" },
  { username: "Guard2", role: "guard", kingdomId: "asgarnia" },
  { username: "Guard3", role: "guard", kingdomId: "asgarnia" },
  { username: "Commoner", role: "commoner", kingdomId: "asgarnia" },
];
const crew = pickCrew(lcg(7), candidates, "asgarnia");
assert.ok(crew, "crew formed");
assert.equal(crew.leader, "MerchA", "leader is origin merchant");
assert.ok(crew.guards.length >= 2 && crew.guards.length <= 4, "2-4 guards");
assert.ok(!crew.guards.includes("MerchB"), "no foreign-kingdom guards");
assert.ok(!crew.guards.includes("Commoner"), "no commoners as guards");
assert.equal(pickCrew(lcg(7), [], "asgarnia"), null, "null with no merchants");

// --- cargo & economics ---
const cargo = buildCargo(lcg(99));
assert.ok(cargo.length >= 3 && cargo.length <= 6, "3-6 goods");
assert.ok(cargo.every((c) => c.qty >= 4 && c.qty <= 12), "qty in range");
assert.ok(cargo.every((c) => typeof c.name === "string" && c.margin > 0), "named goods with margin");
const names = cargo.map((c) => c.name);
assert.equal(new Set(names).size, names.length, "no duplicate goods");

const val = cargoValue([{ name: "x", qty: 10, margin: 20 }, { name: "y", qty: 5, margin: 8 }]);
assert.equal(val, 240, "cargo value math");

const wage = guardWage(lcg(5), 0.2);
assert.ok(wage >= 150 && wage <= 400, `wage in range, got ${wage}`);

// --- bandits ---
let sawAttack = false, sawPeace = false;
for (let i = 0; i < 50; i++) {
  const r = resolveBanditAttack(lcg(i * 7919), 0.2);
  if (r.attacked) {
    sawAttack = true;
    assert.ok(["skirmish", "ambush", "disaster"].includes(r.severity));
    assert.ok(r.lossPct >= 10 && r.lossPct <= 65, `loss pct in range: ${r.lossPct}`);
  } else {
    sawPeace = true;
    assert.equal(r.lossPct, 0);
    assert.equal(r.severity, null);
  }
}
assert.ok(sawAttack && sawPeace, "both outcomes occur");
const calm = resolveBanditAttack(lcg(1), 0);
assert.equal(calm.attacked, false, "zero risk never attacked");

assert.equal(netProfit(1000, 0), 1000);
assert.equal(netProfit(1000, 25), 750);
assert.equal(netProfit(1000, 100), 0);

// --- shares ---
const shares = splitShares(10000, 3, 1, 1, 250);
assert.equal(shares.guardPayout, 1000, "3 citizen + 1 player guard x 250");
const expectedTrader = Math.round((10000 * TRADER_SHARE_PCT) / 100);
assert.equal(shares.traderPayout, expectedTrader, "trader cut");
assert.equal(shares.leaderKeeps, 10000 - 1000 - expectedTrader, "leader keeps rest");
const broke = splitShares(100, 4, 2, 2, 250);
assert.equal(broke.leaderKeeps, 0, "leader never negative");

assert.equal(INVITE_KIND_GUARD, "caravan_guard");
assert.equal(INVITE_KIND_TRADER, "caravan_trader");
assert.equal(MAX_PLAYER_GUARDS, 2);
assert.equal(MAX_PLAYER_TRADERS, 2);

// --- player/world helpers ---
assert.equal(isRealPlayer(null), false);
assert.equal(isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false);
assert.equal(isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
assert.equal(isRealPlayer({ getUsername: () => "Jon" }), true);

function fakeEnt(x, y, z) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}
assert.equal(withinTiles(fakeEnt(0, 0, 0), fakeEnt(5, 5, 0), 12), true);
assert.equal(withinTiles(fakeEnt(0, 0, 0), fakeEnt(20, 0, 0), 12), false);
assert.equal(withinTiles(fakeEnt(0, 0, 0), fakeEnt(0, 0, 1), 12), false, "different plane");

// --- hash ---
assert.equal(hashStr("abc"), hashStr("abc"), "hash deterministic");
assert.notEqual(hashStr("abc"), hashStr("abd"), "hash distinguishes");

console.log("CitizenTradeCaravans: all assertions passed.");
