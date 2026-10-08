// CitizenBankers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const B = require("./CitizenBankers");

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
  // console.log("ok -", name);
}

// --- fnv1a ---
check("fnv1a is deterministic and 32-bit", () => {
  assert.equal(B.fnv1a("abc"), B.fnv1a("abc"));
  assert.ok(B.fnv1a("abc") >= 0 && B.fnv1a("abc") <= 0xffffffff);
  assert.notEqual(B.fnv1a("abc"), B.fnv1a("abd"));
});

// --- bankerTypeFor ---
check("bankerTypeFor is stable across calls", () => {
  assert.equal(B.bankerTypeFor("SomeBanker"), B.bankerTypeFor("SomeBanker"));
  assert.equal(B.bankerTypeFor("somebanker"), B.bankerTypeFor("SOMEBANKER"));
});

check("bankerTypeFor returns null for most commoners (~65%)", () => {
  let bankers = 0;
  const N = 1000;
  for (let i = 0; i < N; i++) if (B.bankerTypeFor("citizen" + i)) bankers++;
  assert.ok(bankers > 250 && bankers < 450, `bankers=${bankers}`);
});

check("bankerTypeFor distributes types among bankers", () => {
  const counts = { teller: 0, "loan-officer": 0, auditor: 0, "vault-keeper": 0 };
  for (let i = 0; i < 5000; i++) {
    const t = B.bankerTypeFor("banker" + i);
    if (t) counts[t]++;
  }
  assert.ok(counts.teller > counts["loan-officer"], JSON.stringify(counts));
  assert.ok(counts["vault-keeper"] > 0, JSON.stringify(counts));
});

// --- bankFor ---
check("bankFor prefers the citizen kingdom", () => {
  const bank = B.bankFor("somebanker", "misthalin");
  assert.equal(bank.kingdom, "misthalin");
});

check("bankFor falls back when kingdom unknown", () => {
  const bank = B.bankFor("somebanker", "narnia");
  assert.ok(bank && bank.name);
});

check("bankFor is stable", () => {
  assert.deepEqual(B.bankFor("x", "asgarnia"), B.bankFor("x", "asgarnia"));
});

check("BANKS has 10 banks with tiers", () => {
  assert.equal(B.BANKS.length, 10);
  for (const b of B.BANKS) {
    assert.ok(b.name && b.short && b.kingdom && b.tier);
    assert.ok(["village", "city", "capital"].includes(b.tier));
  }
});

// --- banksOpenAt ---
check("banksOpenAt follows 08:00-20:00", () => {
  assert.equal(B.banksOpenAt(8), true);
  assert.equal(B.banksOpenAt(19), true);
  assert.equal(B.banksOpenAt(20), false);
  assert.equal(B.banksOpenAt(7), false);
  assert.equal(B.banksOpenAt(0), false);
});

// --- loans ---
check("loanOwedFor adds 10% interest", () => {
  assert.equal(B.loanOwedFor(1000), 1100);
  assert.equal(B.loanOwedFor(0), 0);
});

check("loanAmountOk enforces min/max", () => {
  assert.equal(B.loanAmountOk(99), false);
  assert.equal(B.loanAmountOk(100), true);
  assert.equal(B.loanAmountOk(50000), true);
  assert.equal(B.loanAmountOk(50001), false);
});

check("requestLoan records a loan; second loan refused", () => {
  const now = Date.now();
  const loan = B.requestLoan("LoanPlayer", 1000, "varrock-west", now);
  assert.ok(loan);
  assert.equal(loan.owed, 1100);
  assert.equal(loan.due, now + B.LOAN_TERM_MS);
  assert.equal(B.requestLoan("LoanPlayer", 500, "varrock-west", now), null);
  assert.deepEqual(B.loanFor("loanplayer", now), loan);
});

check("requestLoan rejects bad amounts", () => {
  assert.equal(B.requestLoan("Nobody1", 50, "varrock-west", Date.now()), null);
  assert.equal(B.requestLoan("Nobody1", 999999, "varrock-west", Date.now()), null);
});

check("repayLoan reduces and clears", () => {
  const now = Date.now();
  B.requestLoan("RepayPlayer", 1000, "falador", now);
  assert.equal(B.repayLoan("RepayPlayer", 500, now), 600);
  assert.equal(B.repayLoan("repayplayer", 600, now), 0);
  assert.equal(B.loanFor("RepayPlayer", now), null);
});

check("loanOverdue detects past-due loans", () => {
  const now = Date.now();
  B.requestLoan("LatePlayer", 1000, "ardougne", now);
  assert.equal(B.loanOverdue("LatePlayer", now), false);
  assert.equal(B.loanOverdue("LatePlayer", now + B.LOAN_TERM_MS + 1), true);
});

// --- heat ---
check("raiseHeat stacks to max and decays", () => {
  const now = Date.now();
  assert.equal(B.raiseHeat("keldagrim", now), 25);
  assert.equal(B.raiseHeat("keldagrim", now), 50);
  assert.equal(B.heatFor("keldagrim", now), 50);
  // Half decayed after half the TTL.
  assert.equal(B.heatFor("keldagrim", now + B.HEAT_TTL_MS / 2), 25);
  // Gone after the TTL.
  assert.equal(B.heatFor("keldagrim", now + B.HEAT_TTL_MS + 1), 0);
  // Caps at 100.
  for (let i = 0; i < 10; i++) B.raiseHeat("darkmeyer", now);
  assert.equal(B.heatFor("darkmeyer", now), 100);
});

// --- suspicion ---
check("noteSuspicion / suspicionFor round-trip with TTL", () => {
  const now = Date.now();
  assert.equal(B.noteSuspicion("ShadyPlayer", "varrock-west", now), true);
  const s = B.suspicionFor("shadyplayer", now);
  assert.ok(s);
  assert.equal(s.bank, "varrock-west");
  assert.equal(B.suspicionFor("ShadyPlayer", now + B.SUSPICION_TTL_MS + 1), null);
});

// --- helpers ---
check("fillLine fills slots", () => {
  assert.equal(B.fillLine("Hello {name}, welcome to {bank}.", { name: "Jon", bank: "the bank" }),
    "Hello Jon, welcome to the bank.");
});

check("shouldFire respects cooldown and chance", () => {
  const rng = lcg(42);
  const now = 1_000_000;
  assert.equal(B.shouldFire(rng, now - 1000, now, 60_000, 1), false); // cooldown
  assert.equal(B.shouldFire(rng, 0, now, 60_000, 1), true); // chance 1
  assert.equal(B.shouldFire(rng, 0, now, 60_000, 0), false); // chance 0
});

check("isRealPlayer gates bots and nulls", () => {
  assert.equal(B.isRealPlayer(null), false);
  assert.equal(B.isRealPlayer({ isPlayerBot: () => true }), false);
  assert.equal(B.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(B.isRealPlayer({ getUsername: () => "Jon" }), true);
});

check("pickOne is deterministic with injected rng", () => {
  const rng = lcg(7);
  assert.equal(B.pickOne(rng, ["a", "b", "c"]), B.pickOne(lcg(7), ["a", "b", "c"]));
});

check("line pools are non-empty", () => {
  const pools = [
    "TELLER_GREET_LINES", "TELLER_DEPOSIT_LINES", "TELLER_WITHDRAW_LINES", "TELLER_IDLE_LINES",
    "VAULT_SEAL_LINES", "VAULT_OPEN_LINES", "VAULT_LOITER_LINES", "VAULT_HEAT_LINES",
    "LOAN_OFFER_LINES", "LOAN_GRANTED_LINES", "LOAN_DENIED_LINES", "LOAN_COLLECT_LINES",
    "LOAN_REPAID_LINES", "AUDIT_START_LINES", "AUDIT_CLEAR_LINES", "AUDIT_DISCREPANCY_LINES",
    "SUSPICION_LINES",
  ];
  for (const p of pools) {
    assert.ok(Array.isArray(B[p]) && B[p].length > 0, p);
  }
});

// --- tickBankers: never throws, gates correctly ---
function mockBot(x, y) {
  const said = [];
  return {
    said,
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    getLocalPlayers: () => [],
    forceChat: (line) => said.push(line),
  };
}

check("tickBankers never throws on hostile input", () => {
  B.tickBankers(null, Date.now());
  B.tickBankers({}, Date.now());
  B.tickBankers({ roster: null }, Date.now());
  B.tickBankers({ roster: new Map() }, Date.now());
});

check("tickBankers skips non-commoners and non-bankers", () => {
  const bot = mockBot(0, 0);
  const roster = new Map([
    ["guard1", { username: "guard1", role: "guard" }],
    ["commoner1", { username: "zzznonbankerxyz", role: "commoner" }],
  ]);
  const director = { roster, playerFor: () => bot };
  B.tickBankers(director, Date.now());
  assert.equal(bot.said.length, 0);
});

check("tickBankers fires for a banker near a real player", () => {
  // Find a username that hashes to a banker.
  let bankerName = null;
  for (let i = 0; i < 5000 && !bankerName; i++) {
    if (B.bankerTypeFor("bankerprobe" + i)) bankerName = "bankerprobe" + i;
  }
  assert.ok(bankerName, "found a banker username");
  const said = [];
  const bot = mockBot(100, 100);
  const real = {
    getLocation: () => ({ getX: () => 101, getY: () => 100, getZ: () => 0 }),
    getUsername: () => "Jon",
  };
  bot.getLocalPlayers = () => [real];
  bot.forceChat = (line) => said.push(line);
  const roster = new Map([[bankerName, { username: bankerName, role: "commoner", kingdom: "misthalin" }]]);
  const director = { roster, playerFor: () => bot };
  // Midday so banks are open; run several ticks to beat chance gates.
  const noon = new Date(2026, 5, 1, 12, 0, 0).getTime();
  for (let i = 0; i < 40; i++) B.tickBankers(director, noon + i * 21 * 60 * 1000);
  assert.ok(said.length > 0, "banker said something near a real player");
});

check("tickBankers stays silent with no real player near", () => {
  let bankerName = null;
  for (let i = 0; i < 5000 && !bankerName; i++) {
    if (B.bankerTypeFor("silentprobe" + i)) bankerName = "silentprobe" + i;
  }
  const bot = mockBot(100, 100); // getLocalPlayers returns []
  const roster = new Map([[bankerName, { username: bankerName, role: "commoner", kingdom: "misthalin" }]]);
  const director = { roster, playerFor: () => bot };
  const noon = new Date(2026, 5, 1, 12, 0, 0).getTime();
  B.tickBankers(director, noon);
  assert.equal(bot.said.length, 0);
});

console.log(`CitizenBankers: ${passed} checks passed`);
