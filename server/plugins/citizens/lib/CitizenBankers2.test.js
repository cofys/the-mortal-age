// CitizenBankers2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const mod = require("./CitizenBankers2");

const {
  hashStr,
  pickOne,
  fill,
  moneyfolkTypeFromRoll,
  moneyfolkTypeOf,
  pitchFor,
  nearestBankFor,
  banksOpenAt,
  offerMicroLoan,
  microLoanFor,
  microLoanOverdue,
  repayMicroLoan,
  microLoanOwedFor,
  pawnItem,
  pawnTicketFor,
  pawnForfeited,
  redeemPawn,
  tickMoneyfolk,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  isRealPlayer,
  withinTiles,
  MONEYFOLK_TYPES,
  MONEYFOLK_CHANGER,
  MONEYFOLK_SORTER,
  MONEYFOLK_LENDER,
  MONEYFOLK_PAWN,
  MONEY_PITCHES,
  MONEYFOLK_SHARE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  MICROLOAN_INTEREST_BPS,
  MICROLOAN_MIN,
  MICROLOAN_MAX,
} = mod;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// local-time constructors (never Date.UTC — the PC runs on EDT)
const NOON = new Date(2026, 9, 8, 12, 0).getTime(); // October, mid-day
const MIDNIGHT = new Date(2026, 9, 8, 2, 0).getTime();
const NEXTNIGHT = new Date(2026, 9, 9, 2, 0).getTime(); // Oct 9 02:00 — past the 3h cooldown
const EARLY = new Date(2026, 9, 8, 6, 30).getTime(); // before street hours
const EVENING = new Date(2026, 9, 8, 21, 30).getTime(); // after street hours

function rec(username, role = "commoner", kingdomId = "misthalin") {
  return { username, role, kingdomId };
}

function makeLoc(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
function makeCitizen(x, y, username = "MoneyfolkSam") {
  const said = [];
  return {
    said,
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => username,
    getLocation: () => makeLoc(x, y),
    forceChat: (t) => said.push(String(t)),
  };
}
function makePlayer(x, y, username = "TestPlayer") {
  return {
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    getUsername: () => username,
    getLocation: () => makeLoc(x, y),
    sendMessage: () => {},
  };
}

// --- pure helpers ---

{
  assert.equal(hashStr("abc"), hashStr("abc"), "hashStr deterministic");
  assert.notEqual(hashStr("abc"), hashStr("abd"), "hashStr distinguishes");
  assert.ok(typeof hashStr("x") === "number" && hashStr("x") > 0, "hashStr unsigned");
  const r = lcg(42);
  assert.equal(pickOne(r, ["only"]), "only", "pickOne single");
  assert.equal(fill("hello {name}", { name: "world" }), "hello world", "fill slots");
  assert.equal(fill("{a} {b}", { a: 1, b: 2 }), "1 2", "fill numbers");
  // weights: changer 30 / sorter 25 / lender 25 / pawn 20
  assert.equal(moneyfolkTypeFromRoll(0), MONEYFOLK_CHANGER, "roll 0 -> changer");
  assert.equal(moneyfolkTypeFromRoll(29), MONEYFOLK_CHANGER, "roll 29 -> changer");
  assert.equal(moneyfolkTypeFromRoll(30), MONEYFOLK_SORTER, "roll 30 -> sorter");
  assert.equal(moneyfolkTypeFromRoll(54), MONEYFOLK_SORTER, "roll 54 -> sorter");
  assert.equal(moneyfolkTypeFromRoll(55), MONEYFOLK_LENDER, "roll 55 -> lender");
  assert.equal(moneyfolkTypeFromRoll(79), MONEYFOLK_LENDER, "roll 79 -> lender");
  assert.equal(moneyfolkTypeFromRoll(80), MONEYFOLK_PAWN, "roll 80 -> pawn");
  assert.equal(moneyfolkTypeFromRoll(99), MONEYFOLK_PAWN, "roll 99 -> pawn");
  assert.ok(chance(() => 0, 0.5), "chance true");
  assert.ok(!chance(() => 0.999, 0.5), "chance false");
  assert.equal(WORK_START_HOUR, 7, "street hours start 07:00");
  assert.equal(WORK_END_HOUR, 21, "street hours end 21:00");
  assert.ok(isWorkHour(NOON), "noon is a work hour");
  assert.ok(!isWorkHour(MIDNIGHT), "2am is not a work hour");
  assert.ok(!isWorkHour(EARLY), "06:30 is not a work hour");
  assert.ok(!isWorkHour(EVENING), "21:30 is not a work hour");
  assert.equal(isRealPlayer(makePlayer(0, 0)), true, "real player recognized");
  assert.equal(isRealPlayer(makeCitizen(0, 0)), false, "citizen bot not real");
  assert.equal(isRealPlayer(null), false, "null not real");
  assert.ok(withinTiles(makePlayer(0, 0), makeCitizen(5, 5), 14), "near within 14");
  assert.ok(!withinTiles(makePlayer(0, 0), makeCitizen(50, 50), 14), "far not within 14");
  console.log("  pure helpers ok");
}

// --- distribution band + decile check (~45% nominal, minus pro bankers) ---

function findName(pred, prefix = "Coin") {
  for (let i = 0; i < 200000; i++) {
    const n = prefix + i;
    if (pred(n)) return n;
  }
  return null;
}

{
  const N = 10000;
  const typeCounts = {};
  for (const t of MONEYFOLK_TYPES) typeCounts[t] = 0;
  const deciles = new Array(10).fill(0);
  let total = 0;
  for (let i = 0; i < N; i++) {
    const t = moneyfolkTypeOf(rec("Decile" + i));
    if (!t) continue;
    total++;
    typeCounts[t]++;
    deciles[i % 10]++;
  }
  const rate = total / N;
  assert.ok(rate > 0.3 && rate < 0.47, `share rate ${rate.toFixed(3)} in 0.30..0.47 (post-exclusion)`);
  // weight check: changer ~30%, sorter ~25%, lender ~25%, pawn ~20%
  const expect = { [MONEYFOLK_CHANGER]: 0.30, [MONEYFOLK_SORTER]: 0.25, [MONEYFOLK_LENDER]: 0.25, [MONEYFOLK_PAWN]: 0.20 };
  for (const t of MONEYFOLK_TYPES) {
    const share = typeCounts[t] / total;
    assert.ok(Math.abs(share - expect[t]) < 0.06, `type ${t} share ${share.toFixed(3)} within 0.06 of ${expect[t]}`);
  }
  for (let d = 0; d < 10; d++) {
    const share = deciles[d] / (N / 10);
    assert.ok(Math.abs(share - rate) < 0.08, `decile ${d} uniform: ${share.toFixed(3)} vs ${rate.toFixed(3)}`);
  }
  console.log(`  distribution: ${(rate * 100).toFixed(1)}% moneyfolk over 10k names, type shares: ` +
    MONEYFOLK_TYPES.map((t) => `${t}=${(typeCounts[t] / total * 100).toFixed(1)}%`).join(" "));
}

// --- exclusion integration against the real pro module ---

{
  const ProBankers = require("./CitizenBankers");
  const proName = findName((n) => !!ProBankers.bankerTypeFor(n), "BankerPro");
  assert.ok(proName, "found a pro banker name");
  assert.equal(moneyfolkTypeOf(rec(proName)), null, `pro banker ${proName} excluded`);
  assert.equal(moneyfolkTypeOf(rec("SomeGuard", "guard")), null, "non-commoner role excluded");
  // name-first salts: the moneyfolk salt differs from the pro bank salt
  assert.notEqual(hashStr("x|moneyfolk"), hashStr("x"), "salt changes the roll");
  console.log(`  exclusion verified: pro banker ${proName} excluded`);
}

// --- venues ---

{
  const v = pitchFor(rec("anyone", "commoner", "keldagrim"));
  assert.equal(v.kingdom, "keldagrim", "kingdom-preferred pitch");
  assert.equal(pitchFor(rec("anyone", "commoner", "nowhere")).kingdom !== undefined, true, "unknown kingdom falls back");
  assert.equal(MONEY_PITCHES.length, 10, "ten pitches");
  assert.equal(pitchFor(rec("anyone")).kingdom, "misthalin", "default kingdom misthalin");
  console.log("  venues ok");
}

// --- rates/pawn/appraisal removed 2026-10-08: rateForToday/pawnItemForToday/countJobForToday/appraisalOf/taskForToday were hash-derived fabrication. ---

// --- real-data bridges to the pro bank module ---

{
  assert.equal(typeof nearestBankFor(rec("anyone", "commoner", "misthalin")), "string", "nearest bank is a string");
  assert.ok(nearestBankFor(rec("anyone", "commoner", "misthalin")).toLowerCase().includes("bank"), "nearest bank names a bank");
  assert.ok(banksOpenAt(NOON), "banks open at noon (pro hours 08-20)");
  assert.ok(!banksOpenAt(MIDNIGHT), "banks shut at 2am (pro hours 08-20)");
  console.log("  pro-bank bridges ok");
}

// --- rhythms removed 2026-10-08: assayAlertFor/lendingRushFor were hash-derived fabrication. ---

// --- micro-loan ledger ---

{
  mod._resetState();
  assert.equal(MICROLOAN_INTEREST_BPS, 2000, "street interest is 20% (bank charges 10%)");
  assert.equal(microLoanOwedFor(100), 120, "100 coins -> 120 owed at 20%");
  const loan = offerMicroLoan("TestPlayer", "Lendfolk", 100, NOON);
  assert.ok(loan, "brass note written");
  assert.equal(loan.amount, 100, "amount recorded");
  assert.equal(loan.owed, 120, "owed includes 20% interest");
  assert.equal(microLoanFor("TestPlayer", NOON).lender, "Lendfolk", "loan readable");
  assert.ok(!microLoanOverdue(microLoanFor("TestPlayer", NOON), NOON), "not overdue on day one");
  assert.ok(microLoanOverdue(microLoanFor("TestPlayer", NOON), NOON + 4 * 24 * 3600 * 1000), "overdue after 3-day term");
  assert.equal(microLoanFor("Nobody", NOON), null, "no loan for unknown");
  assert.equal(offerMicroLoan("Tiny", "L", 10, NOON), null, `below ${MICROLOAN_MIN} rejected`);
  assert.equal(offerMicroLoan("Big", "L", 99999, NOON), null, `above ${MICROLOAN_MAX} rejected`);
  assert.ok(repayMicroLoan("TestPlayer", NOON), "repayment deletes the note");
  assert.equal(microLoanFor("TestPlayer", NOON), null, "note gone after repayment");
  offerMicroLoan("Expiry", "L", 100, NOON);
  assert.equal(microLoanFor("Expiry", NOON + 8 * 24 * 3600 * 1000), null, "loan record expires after 7d TTL");
  console.log("  micro-loan ledger ok");
  mod._resetState();
}

// --- pawn ledger ---

{
  mod._resetState();
  const ticket = pawnItem("TestPlayer", "Pawnfolk", "a silver locket", 50, NOON);
  assert.ok(ticket, "pawn ticket written");
  assert.equal(ticket.item, "a silver locket", "item recorded");
  assert.equal(pawnTicketFor("TestPlayer", NOON).broker, "Pawnfolk", "ticket readable");
  assert.ok(!pawnForfeited(pawnTicketFor("TestPlayer", NOON), NOON), "not forfeited on day one");
  assert.ok(pawnForfeited(pawnTicketFor("TestPlayer", NOON), NOON + 8 * 24 * 3600 * 1000), "forfeited after 7-day term");
  assert.ok(redeemPawn("TestPlayer", NOON), "redemption deletes the ticket");
  assert.equal(pawnTicketFor("TestPlayer", NOON), null, "ticket gone after redemption");
  pawnItem("Gone", "P", "a brass compass", 20, NOON);
  assert.equal(pawnTicketFor("Gone", NOON + 8 * 24 * 3600 * 1000), null, "ticket expires after 7d TTL");
  console.log("  pawn ledger ok");
  mod._resetState();
}

// --- tick smoke test (mock director, real hash eligibility) ---

{
  mod._resetState();
  // real eligibility: find names that hash into changer and lender
  const changerName = findName((n) => moneyfolkTypeOf(rec(n)) === MONEYFOLK_CHANGER, "Changefolk");
  const lenderName = findName((n) => moneyfolkTypeOf(rec(n)) === MONEYFOLK_LENDER, "Lendfolk");
  assert.ok(changerName, "found a changer name");
  assert.ok(lenderName, "found a lender name");
  const r1 = rec(changerName);
  const r2 = rec(lenderName);
  const r3 = rec("notmoneyfolk", "guard"); // excluded by role
  const said = [];
  const citizen = makeCitizen(100, 100);
  citizen.forceChat = (t) => said.push(String(t));
  const player = makePlayer(105, 105);
  const playerRec = { username: "TestPlayer", role: "player" };
  const director = {
    roster: new Map([[changerName.toLowerCase(), r1], [lenderName.toLowerCase(), r2], ["notmoneyfolk", r3], ["testplayer", playerRec]]),
    isOnline: (r) => (r === r1 || r === r2 || r === playerRec),
    getBot: (r) => (r === r1 || r === r2 ? citizen : r === playerRec ? player : null),
    aiTickCount: 0,
    log: () => {},
  };
  // pin rng so the chance gate always passes and the test is deterministic
  const realRandom = Math.random;
  Math.random = () => 0.01;
  try {
    // changer branch at noon (banks open: bait/bank-hour/pitch lines)
    tickMoneyfolk(director, NOON, { tick: 0 });
    assert.ok(said.length >= 1, "tick fired (changer)");
    const saidNoon = said.length;
    // immediate refire blocked by the cooldown map
    tickMoneyfolk(director, NOON, { tick: 0 });
    assert.equal(said.length, saidNoon, "cooldown blocks immediate re-fire");
    // lender branch: seed an overdue brass note for the nearby player, then
    // tick at a fresh timestamp (3h cooldown keyed by username)
    offerMicroLoan("TestPlayer", "ShadyLender", 100, NOON - 4 * 24 * 3600 * 1000);
    tickMoneyfolk(director, NOON + 4 * 3600 * 1000, { tick: 0 });
    assert.ok(said.length > saidNoon, "tick fired (lender, overdue debtor callout)");
    const lastSaid = said[said.length - 1];
    assert.ok(lastSaid.includes("TestPlayer") && lastSaid.includes("120"), `callout names debtor and owed: ${lastSaid}`);
    // night hours: no work fires (fresh timestamp, past the 3h cooldown)
    const saidDay = said.length;
    tickMoneyfolk(director, NEXTNIGHT, { tick: 0 });
    assert.equal(said.length, saidDay, "no work outside street hours");
    // one bad record never kills the tick
    const badDirector = { roster: { values: () => { throw new Error("boom"); } } };
    tickMoneyfolk(badDirector, NOON, { tick: 0 });
  } finally {
    Math.random = realRandom;
  }
  console.log("  tick smoke ok (changer fired, cooldown held, lender debtor callout fired, night quiet, bad roster survived)");
  mod._resetState();
}

console.log("CitizenBankers2 tests passed");
