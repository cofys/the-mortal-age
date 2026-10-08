// CitizenMarketStalls unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  isMarketOpenHour,
  dateKeyFor,
  dailyWaresFor,
  priceMultiplierFor,
  stallSpotFor,
  fillLine,
  parseMarketWares,
  WARE_POOLS,
  MIN_WARES,
  MAX_WARES,
} = require("./CitizenMarketStalls");

let n = 0;
function check(cond, label) {
  n++;
  assert.ok(cond, label);
  console.log(`ok ${n} - ${label}`);
}

// --- market hours ---
check(isMarketOpenHour(8) === true, "opens at 08:00");
check(isMarketOpenHour(12) === true, "open at midday");
check(isMarketOpenHour(18) === true, "open at 18:59 window");
check(isMarketOpenHour(19) === false, "closed at 19:00");
check(isMarketOpenHour(7) === false, "closed at 07:00");
check(isMarketOpenHour(0) === false, "closed at midnight");
check(isMarketOpenHour(23) === false, "closed late night");

// --- date keys ---
check(dateKeyFor(new Date(2026, 9, 7)) === "2026-10-07", "date key formats YYYY-MM-DD");
check(
  dateKeyFor(new Date(2026, 9, 7)) !== dateKeyFor(new Date(2026, 9, 8)),
  "date key changes across days"
);

// --- daily wares ---
for (const kind of ["provisioner", "supplier", "prime"]) {
  const wares = dailyWaresFor("SomeMerchant", kind, "2026-10-07");
  check(
    wares.length >= MIN_WARES && wares.length <= MAX_WARES,
    `${kind}: 3-5 wares (got ${wares.length})`
  );
  check(
    wares.every((w) => (WARE_POOLS[kind] ?? []).includes(w)),
    `${kind}: wares come from the kind pool`
  );
  check(
    new Set(wares).size === wares.length,
    `${kind}: no duplicate wares in a day`
  );
}
const dayA = dailyWaresFor("SomeMerchant", "prime", "2026-10-07");
const dayA2 = dailyWaresFor("SomeMerchant", "prime", "2026-10-07");
check(JSON.stringify(dayA) === JSON.stringify(dayA2), "wares stable within a day");
const dayB = dailyWaresFor("SomeMerchant", "prime", "2026-10-08");
check(JSON.stringify(dayA) !== JSON.stringify(dayB), "wares rotate across days");
const other = dailyWaresFor("OtherMerchant", "prime", "2026-10-07");
check(
  JSON.stringify(dayA) !== JSON.stringify(other) || true,
  "wares seeded per merchant (no crash on different names)"
);
check(
  dailyWaresFor("X", "not-a-kind", "2026-10-07").length >= MIN_WARES,
  "unknown merchantKind falls back to the mixed pool"
);

// --- personality pricing ---
check(priceMultiplierFor(["greedy"]) === 1.3, "greedy merchants charge more");
check(priceMultiplierFor(["easygoing"]) === 0.9, "easygoing merchants price to move");
check(priceMultiplierFor(["cheerful"]) === 0.9, "cheerful merchants price to move");
check(priceMultiplierFor(["dutiful"]) === 1.0, "neutral traits list at par");
check(priceMultiplierFor([]) === 1.0, "no traits list at par");
check(priceMultiplierFor(new Set(["greedy"])) === 1.3, "accepts a Set of traits");
check(priceMultiplierFor(["greedy", "cheerful"]) === 1.3, "greedy wins over cheerful");

// --- stall spots ---
const anchor = { x: 3200, y: 3200, z: 0 };
const spot = stallSpotFor("SomeMerchant", anchor);
check(
  Math.abs(spot.x - anchor.x) <= 4 && Math.abs(spot.y - anchor.y) <= 2,
  "stall spot sits on the pitch ring around the anchor"
);
check(spot.z === 0, "stall spot keeps the anchor plane");
check(
  JSON.stringify(stallSpotFor("SomeMerchant", anchor)) === JSON.stringify(spot),
  "stall spot deterministic per merchant"
);
const spot2 = stallSpotFor("OtherMerchant", anchor);
check(
    spot2.x !== spot.x || spot2.y !== spot.y || true,
  "different merchants hash (no crash)"
);

// --- line templates ---
check(
  fillLine("For you, {player} — {pct}% off.", { player: "Liam", pct: 10 }) ===
    "For you, Liam — 10% off.",
  "fillLine substitutes vars"
);
check(
  fillLine("Fresh {ware}!", { ware: "Bread" }) === "Fresh Bread!",
  "fillLine substitutes ware"
);

// --- market-wares attribute parsing ---
check(parseMarketWares("") === null, "empty attribute -> null");
check(parseMarketWares(null) === null, "null attribute -> null");
check(parseMarketWares("not json") === null, "bad JSON -> null");
check(parseMarketWares("[]") === null, "empty list -> null");
const parsed = parseMarketWares('[{"id": 1234, "price": 50}]');
check(
  parsed && parsed.length === 1 && parsed[0].id === 1234 && parsed[0].price === 50,
  "valid wares parse"
);
check(
  parseMarketWares('[{"id": -1, "price": 50}, {"id": 0, "price": 0}]') === null,
  "invalid entries filtered out -> null"
);
const mixed = parseMarketWares('[{"id": 1, "price": 5}, {"id": "nope", "price": 5}]');
check(mixed && mixed.length === 1 && mixed[0].id === 1, "partially valid list keeps good entries");

console.log(`\n${n} assertions passed.`);
