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
  cargoCost,
  tradeProfit,
  affordableCargo,
  goodsForKingdom,
  refPrice,
  debitCoinsVerified,
  creditCoinsVerified,
  transferCoinsVerified,
  buyCargo,
  sellCargo,
  caravanGoodsSummary,
  formCaravan,
  settleCaravan,
  KINGDOM_GOODS,
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

// --- real goods per kingdom ---
const KINGDOMS5 = ["asgarnia", "kandarin", "keldagrim", "misthalin", "morytania"];
for (const k of KINGDOMS5) {
  const goods = KINGDOM_GOODS[k];
  assert.ok(Array.isArray(goods) && goods.length >= 4 && goods.length <= 8,
    `${k}: 4-8 real goods, got ${goods?.length}`);
  for (const g of goods) {
    assert.ok(Number.isInteger(g.itemId) && g.itemId > 0, `${k}: real item id`);
    assert.ok(typeof g.name === "string" && g.name.length > 0, `${k}: named good`);
    assert.ok(refPrice(g.itemId) >= 1, `${g.name}: has a real price`);
  }
  assert.equal(new Set(goods.map((g) => g.itemId)).size, goods.length, `${k}: no dupes`);
}
assert.deepEqual(goodsForKingdom("nope"), [], "unknown kingdom -> no goods");
// Spot-check the documented surplus mapping.
const keldIds = new Set(KINGDOM_GOODS.keldagrim.map((g) => g.itemId));
assert.ok(keldIds.has(453) && keldIds.has(440) && keldIds.has(447) && keldIds.has(449), "keldagrim ores exact");
assert.ok(keldIds.has(1623) && keldIds.has(1617), "keldagrim gems -> uncut");
const kandIds = new Set(KINGDOM_GOODS.kandarin.map((g) => g.itemId));
assert.ok(kandIds.has(1521) && kandIds.has(1519) && kandIds.has(1515) && kandIds.has(1513), "kandarin logs exact");
assert.ok(kandIds.has(377) && kandIds.has(1779), "kandarin raw_fish/flax mapped");
assert.ok(KINGDOM_GOODS.asgarnia.some((g) => g.itemId === 2309), "asgarnia bread exact");
assert.ok(KINGDOM_GOODS.asgarnia.some((g) => g.itemId === 1947), "asgarnia wheat -> grain");
assert.ok(KINGDOM_GOODS.misthalin.some((g) => g.itemId === 1741), "misthalin leather");
assert.ok(KINGDOM_GOODS.morytania.some((g) => g.itemId === 2970), "morytania fungus");

// --- cargo & economics: real goods, real prices ---
// Deterministic price stub — the math, not the GE table, is under test.
const TEST_PRICES = { 453: 140, 440: 70, 1515: 100, 377: 110, 1779: 2, 2309: 80, 1947: 8 };
const testPrice = (id) => TEST_PRICES[id] ?? 1;

for (const k of KINGDOMS5) {
  const allowed = new Set(KINGDOM_GOODS[k].map((g) => g.itemId));
  const poolSize = KINGDOM_GOODS[k].length;
  for (let s = 0; s < 20; s++) {
    const c = buildCargo(lcg(s * 131 + 7), k, testPrice);
    assert.ok(c.length >= 3 && c.length <= Math.min(6, poolSize), `${k}: 3-6 lines, got ${c.length}`);
    for (const line of c) {
      assert.ok(allowed.has(line.itemId), `${k}: origin surplus only (got ${line.itemId})`);
      assert.ok(typeof line.name === "string" && line.name.length > 0, "named line");
      assert.ok(line.qty >= 4 && line.qty <= 12, "qty in range");
      assert.equal(line.buyPrice, testPrice(line.itemId), "buyPrice = origin price at muster");
    }
    assert.equal(new Set(c.map((l) => l.itemId)).size, c.length, "no duplicate goods");
  }
}
assert.deepEqual(buildCargo(lcg(1), "nope", testPrice), [], "unknown kingdom -> empty cargo");
assert.equal(caravanGoodsSummary([{ qty: 8, name: "Coal" }, { qty: 5, name: "Iron ore" }]),
  "8 Coal, 5 Iron ore", "cargo summary");

const priced = [
  { itemId: 453, name: "Coal", qty: 10, buyPrice: 100 },
  { itemId: 440, name: "Iron ore", qty: 5, buyPrice: 50 },
];
assert.equal(cargoCost(priced), 1250, "cargo cost math");
assert.equal(cargoValue(priced, () => 120), 15 * 120, "cargo value at sell prices");
assert.equal(tradeProfit(priced, () => 120), 20 * 10 + 70 * 5, "spread profit");
const badTrade = tradeProfit(priced, () => 10);
assert.ok(badTrade < 0, `bad trade goes negative, got ${badTrade}`);
assert.equal(badTrade, -90 * 10 - 40 * 5, "negative profit math");

// --- affordability: smaller cargo or no caravan ---
assert.equal(affordableCargo(priced, 999999).length, 2, "rich merchant keeps everything");
const shrunk = affordableCargo(priced, 300); // coal line 1000, iron line 250
assert.equal(shrunk.length, 1, "poor merchant loads less");
assert.equal(shrunk[0].itemId, 440, "priciest line dropped first");
assert.deepEqual(affordableCargo(priced, 0), [], "broke -> nothing affordable");
assert.deepEqual(affordableCargo([], 100), [], "empty cargo in");

// --- verified transfers ---
function fakeInv(coins) {
  const store = new Map([[995, coins]]);
  return {
    getAmount: (id) => store.get(id) ?? 0,
    deleteNumber: (id, n) => { store.set(id, Math.max(0, (store.get(id) ?? 0) - n)); },
    adds: (id, n) => { store.set(id, (store.get(id) ?? 0) + n); },
  };
}
{
  const inv = fakeInv(1000);
  assert.equal(debitCoinsVerified(inv, 400), true, "debit ok");
  assert.equal(inv.getAmount(995), 600, "debit landed exactly");
  assert.equal(debitCoinsVerified(inv, 700), false, "no overdraw");
  assert.equal(inv.getAmount(995), 600, "failed debit leaves purse alone");
  assert.equal(creditCoinsVerified(inv, 250), true, "credit ok");
  assert.equal(inv.getAmount(995), 850, "credit landed exactly");
  assert.equal(debitCoinsVerified(inv, 0), true, "zero debit trivially ok");
  assert.equal(creditCoinsVerified(inv, -5), true, "negative credit trivially ok");
}
{
  // A lying inventory (ops don't land) fails verification both ways.
  const lying = { getAmount: () => 100, deleteNumber: () => {}, adds: () => {} };
  assert.equal(debitCoinsVerified(lying, 50), false, "unverified debit fails");
  assert.equal(creditCoinsVerified(lying, 50), false, "unverified credit fails");
  assert.equal(debitCoinsVerified(null, 50), false, "missing inventory fails");
}
{
  const a = fakeInv(500), b = fakeInv(0);
  assert.equal(transferCoinsVerified(a, b, 200), true, "transfer ok");
  assert.equal(a.getAmount(995), 300, "sender debited");
  assert.equal(b.getAmount(995), 200, "receiver credited");
  const a2 = fakeInv(500);
  const badB = { getAmount: () => 0, adds: () => { throw new Error("nope"); } };
  assert.equal(transferCoinsVerified(a2, badB, 200), false, "failed credit");
  assert.equal(a2.getAmount(995), 500, "debit rolled back — nothing vanished");
  assert.equal(transferCoinsVerified(a2, b, 9999), false, "can't send what you lack");
}

// --- the muster buy ---
function fakeDirector({ leaderName, coins, online = true, botInv = null } = {}) {
  const inv = botInv ?? fakeInv(coins ?? 0);
  const record = { username: leaderName, role: "merchant", kingdomId: "keldagrim" };
  return {
    director: {
      roster: {
        get: () => (online ? record : null),
        values: () => [record].values(),
      },
      isOnline: () => online,
      getBot: () => ({ getInventory: () => inv, getUsername: () => leaderName }),
    },
    inv,
  };
}
const buyLines = [
  { itemId: 453, name: "Coal", qty: 10, buyPrice: 100 }, // 1000
  { itemId: 440, name: "Iron ore", qty: 5, buyPrice: 50 }, // 250
];
{
  const { director, inv } = fakeDirector({ leaderName: "MerchA", coins: 5000 });
  const p = buyCargo(director, "MerchA", buyLines);
  assert.ok(p && p.verified, "rich merchant buys");
  assert.equal(p.cost, 1250, "cost captured");
  assert.equal(p.cargo.length, 2, "full cargo");
  assert.equal(inv.getAmount(995), 3750, "real coins left the purse");
}
{
  const { director, inv } = fakeDirector({ leaderName: "MerchA", coins: 300 });
  const p = buyCargo(director, "MerchA", buyLines);
  assert.ok(p && p.verified, "poor merchant still runs");
  assert.equal(p.cargo.length, 1, "forms smaller");
  assert.equal(p.cargo[0].itemId, 440, "keeps what it can cover");
  assert.equal(p.cost, 250);
  assert.equal(inv.getAmount(995), 50, "paid for the smaller load");
}
{
  const { director } = fakeDirector({ leaderName: "MerchA", coins: 10 });
  assert.equal(buyCargo(director, "MerchA", buyLines), null, "broke merchant -> no buy");
}
{
  const { director } = fakeDirector({ leaderName: "MerchA", coins: 0, online: false });
  const p = buyCargo(director, "MerchA", buyLines);
  assert.ok(p && !p.verified, "offline leader -> journaled commitment");
  assert.equal(p.cost, 1250, "books still balance");
  assert.equal(p.cargo.length, 2, "offline caravan keeps its cargo");
}
{
  // Debit that doesn't land aborts the buy.
  const lyingInv = { getAmount: () => 5000, deleteNumber: () => {}, adds: () => {} };
  const { director } = fakeDirector({ leaderName: "MerchA", botInv: lyingInv });
  assert.equal(buyCargo(director, "MerchA", buyLines), null, "unverified debit -> no caravan");
}

// --- the arrival sale ---
{
  const line = [{ itemId: 453, name: "Coal", qty: 10, buyPrice: 100 }];
  const { director, inv } = fakeDirector({ leaderName: "MerchA", coins: 100 });
  const s = sellCargo(director, "MerchA", line, 0);
  const expected = netProfit(cargoValue(line, (id) => refPrice(id)), 0);
  assert.equal(s.proceeds, expected, "proceeds = arrival prices");
  assert.equal(s.verified, true, "verified credit");
  assert.equal(inv.getAmount(995), 100 + expected, "real coins entered the purse");
}
{
  const line = [{ itemId: 453, name: "Coal", qty: 10, buyPrice: 100 }];
  const { director } = fakeDirector({ leaderName: "MerchA", coins: 0 });
  const full = sellCargo(director, "MerchA", line, 0).proceeds;
  const hit = sellCargo(director, "MerchA", line, 50).proceeds;
  assert.equal(hit, Math.round(full * 0.5), "bandit loss destroys value");
}
{
  const { director } = fakeDirector({ leaderName: "MerchA", online: false });
  const s = sellCargo(director, "MerchA", [{ itemId: 453, name: "Coal", qty: 10, buyPrice: 100 }], 0);
  assert.ok(!s.verified && s.proceeds > 0, "offline leader -> journaled sale");
}
{
  // Credit that doesn't land aborts the leg: proceeds zeroed, journaled.
  const lyingInv = { getAmount: () => 0, deleteNumber: () => {}, adds: () => {} };
  const { director } = fakeDirector({ leaderName: "MerchA", botInv: lyingInv });
  const s = sellCargo(director, "MerchA", [{ itemId: 453, name: "Coal", qty: 10, buyPrice: 100 }], 0);
  assert.equal(s.proceeds, 0, "failed verification -> leg aborted");
  assert.equal(s.verified, false);
}

// --- formCaravan: merchant-can't-afford ---
function caravanDirector(coins, online = true) {
  const inv = fakeInv(coins);
  const rec = (u, role) => ({ username: u, role, kingdomId: "keldagrim" });
  const all = [rec("MerchA", "merchant"), rec("G1", "guard"), rec("G2", "guard")];
  return {
    director: {
      roster: {
        get: () => all[0], // leaderInventory normalizes the lookup key; the merchant record is what matters
        values: () => all.values(),
      },
      isOnline: () => online,
      getBot: () => ({ getInventory: () => inv, getUsername: () => "MerchA" }),
    },
    inv,
  };
}
const testRoute = { from: "keldagrim", to: "asgarnia", key: "keldagrim->asgarnia" };
{
  const { director } = caravanDirector(5);
  assert.equal(formCaravan(director, testRoute, 1000000), null, "broke merchant -> no caravan forms");
}
{
  const { director, inv } = caravanDirector(1e9);
  const c = formCaravan(director, testRoute, 1000000);
  assert.ok(c, "rich merchant musters");
  assert.ok(c.cargo.length >= 3, "real cargo loaded");
  const allowed = new Set(KINGDOM_GOODS.keldagrim.map((g) => g.itemId));
  assert.ok(c.cargo.every((l) => allowed.has(l.itemId)), "origin surplus only");
  assert.equal(c.cargoCost, cargoCost(c.cargo), "cost captured at muster");
  assert.equal(c.cargoVerified, true, "verified buy");
  assert.ok(inv.getAmount(995) === 1e9 - c.cargoCost, "purse debited exactly");
}
{
  // Offline leader: caravan still musters (muster logic untouched), books journaled.
  const { director } = caravanDirector(0, false);
  const c = formCaravan(director, testRoute, 1000000);
  assert.ok(c, "offline merchant still musters");
  assert.equal(c.cargoVerified, false, "buy journaled, not verified");
}

// --- settleCaravan: real P&L end to end ---
{
  const { director, inv } = caravanDirector(1e9);
  const c = formCaravan(director, testRoute, 1000000);
  assert.ok(c, "caravan formed");
  const purseAfterBuy = inv.getAmount(995);
  const s = settleCaravan(director, c, 2000000);
  assert.ok(s, "settled");
  assert.equal(s.cost, c.cargoCost, "cost carried through");
  const expectedProceeds = netProfit(cargoValue(c.cargo, (id) => refPrice(id, 2000000)), s.lossPct);
  assert.equal(s.proceeds, expectedProceeds, "proceeds = surviving cargo at arrival prices");
  assert.equal(s.net, s.proceeds - s.cost, "net = proceeds - cost (can be negative)");
  assert.equal(inv.getAmount(995), purseAfterBuy + s.proceeds, "purse credited exactly");
  assert.ok(s.shares.leaderKeeps >= 0, "leader never negative");
  assert.ok(s.saleVerified, "sale verified");
}

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
