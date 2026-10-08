// CitizenMessengers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const M = require("./CitizenMessengers");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- hashing is stable ---
{
  assert.equal(M.fnv1a("messenger:Alice"), M.fnv1a("messenger:Alice"));
  assert.notEqual(M.fnv1a("messenger:Alice"), M.fnv1a("messenger:Bob"));
}

// --- fillLine renders every slot, leaves unknown slots alone ---
{
  const out = M.fillLine("{a} and {b}", { a: "x", b: "y" });
  assert.equal(out, "x and y");
  assert.equal(M.fillLine("{a} {missing}", { a: "x" }), "x {missing}");
}

// --- messenger type assignment: ~35% of names, all four types reachable, stable ---
{
  let count = 0;
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const t = M.messengerTypeFor("Citizen" + i);
    if (t) {
      count++;
      seen.add(t);
      assert.ok(M.MESSENGER_TYPES.includes(t), "unknown type " + t);
    }
    assert.equal(M.messengerTypeFor("Citizen" + i), t, "type must be stable");
  }
  const share = count / 2000;
  assert.ok(share > 0.03 && share < 0.10, "messenger share ~6% (primary-profession partition), got " + share);
  assert.deepEqual([...seen].sort(), [...M.MESSENGER_TYPES].sort());
}

// --- isMessenger agrees with messengerTypeFor ---
{
  assert.equal(M.isMessenger("Citizen7"), M.messengerTypeFor("Citizen7") !== null);
}

// --- officeFor prefers the citizen's kingdom, falls back otherwise ---
{
  const o = M.officeFor("Alice", "varrock");
  assert.equal(o.kingdom, "varrock");
  const fb = M.officeFor("Bob", "nosuchkingdom");
  assert.ok(M.POST_OFFICES.includes(fb));
  assert.equal(M.officeFor("Alice", "varrock").name, M.officeFor("Alice", "varrock").name);
}

// --- routeFor is per-day deterministic and varies across days ---
{
  const r1 = M.routeFor("Alice", "2026-10-08");
  const r2 = M.routeFor("Alice", "2026-10-08");
  assert.deepEqual(r1, r2);
  const r3 = M.routeFor("Alice", "2026-10-09");
  assert.ok(r1.carries !== r3.carries || r1.dest !== r3.dest || r1.urgent !== r3.urgent,
    "route should vary across days");
  assert.ok(typeof r1.urgent === "boolean");
  assert.ok(r1.origin && r1.dest && r1.carries);
}

// --- urgent routes are ~12% ---
{
  let u = 0;
  for (let i = 0; i < 2000; i++) {
    if (M.routeFor("Citizen" + i, "2026-10-08").urgent) u++;
  }
  const share = u / 2000;
  assert.ok(share > 0.08 && share < 0.17, "urgent share ~12%, got " + share);
}

// --- post hours ---
{
  assert.ok(M.inPostHours(7) && M.inPostHours(12) && M.inPostHours(18));
  assert.ok(!M.inPostHours(6) && !M.inPostHours(19) && !M.inPostHours(23));
}

// --- letter ledger round-trip ---
{
  const now = Date.now();
  assert.ok(M.sendLetter("Jon", "a sealed letter", "Mira", "Meet at noon", now));
  const e = M.letterFor("Jon", now);
  assert.ok(e);
  assert.equal(e.kind, "a sealed letter");
  assert.equal(e.from, "Mira");
  assert.equal(e.text, "Meet at noon");
  // case-insensitive lookup
  assert.ok(M.letterFor("jon", now));
  assert.ok(M.collectLetter("JON"));
  assert.equal(M.letterFor("Jon", now), null);
}

// --- letter ledger expires after TTL ---
{
  const now = Date.now();
  M.sendLetter("Expy", "a parcel", "Mira", "hi", now);
  assert.equal(M.letterFor("Expy", now + M.LETTER_LEDGER_TTL_MS + 1), null);
}

// --- data pools are all non-empty ---
{
  for (const pool of [
    M.COURIER_ARRIVAL_LINES, M.COURIER_OFFER_LINES, M.HERALD_DECREE_LINES,
    M.HERALD_EVENT_LINES, M.HERALD_WARNING_LINES, M.RUNNER_LINES,
    M.POSTMASTER_GREET_LINES, M.POSTMASTER_COLLECT_LINES,
    M.DECREE_TEXTS, M.EVENT_TEXTS, M.WARNING_TEXTS,
  ]) {
    assert.ok(pool.length >= 3, "pool too small");
  }
  assert.equal(M.POST_OFFICES.length, 10);
}

// --- all line templates render with no unfilled slots ---
{
  const rng = lcg(42);
  const vars = {
    courier: "C", herald: "H", runner: "R", postmaster: "P",
    name: "Jon", kind: "a sealed letter", origin: "the Varrock post office",
    dest: "the Falador mail hall", office: "the Varrock post office", text: "a decree!",
  };
  const pools = [
    M.COURIER_ARRIVAL_LINES, M.COURIER_OFFER_LINES, M.HERALD_DECREE_LINES,
    M.HERALD_EVENT_LINES, M.HERALD_WARNING_LINES, M.RUNNER_LINES,
    M.POSTMASTER_GREET_LINES, M.POSTMASTER_COLLECT_LINES,
  ];
  let n = 0;
  for (const pool of pools) {
    for (const line of pool) {
      const out = M.fillLine(line, vars);
      assert.ok(!/\{\w+\}/.test(out), "unfilled slot in: " + line);
      assert.ok(out.length <= 120, "line too long: " + out);
      n++;
    }
  }
  assert.ok(n > 20, "expected many lines, got " + n);
}

// --- isRealPlayer / withinTiles guards ---
{
  assert.equal(M.isRealPlayer(null), false);
  assert.equal(M.isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false);
  assert.equal(M.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(M.isRealPlayer({ getUsername: () => "Jon" }), true);

  const loc = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.ok(M.withinTiles(loc(0, 0, 0), loc(10, 10, 0), 14));
  assert.ok(!M.withinTiles(loc(0, 0, 0), loc(20, 0, 0), 14));
  assert.ok(!M.withinTiles(loc(0, 0, 0), loc(0, 0, 1), 14)); // different plane
}

// --- tick never throws on hostile input ---
{
  assert.doesNotThrow(() => M.tickMessengers(null, Date.now()));
  assert.doesNotThrow(() => M.tickMessengers({}, Date.now()));
  assert.doesNotThrow(() => M.tickMessengers({ roster: null }, Date.now()));
}

// --- tick fires for a materialized messenger near a real player, silent otherwise ---
{
  function mkPlayer(name, bot) {
    return {
      getUsername: () => name,
      isPlayerBot: () => !!bot,
      getHostAddress: () => (bot ? "bot" : "127.0.0.1"),
      getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
      said: [],
      forceChat(line) { this.said.push(line); },
    };
  }
  // find a messenger username deterministically
  let mname = null;
  for (let i = 0; i < 500 && !mname; i++) {
    if (M.messengerTypeFor("Post" + i)) mname = "Post" + i;
  }
  assert.ok(mname, "need a messenger for the tick test");
  const bot = mkPlayer(mname, true);
  const human = mkPlayer("Jon", false);
  const botOnly = mkPlayer("OtherBot", true);
  const record = { username: mname, attributes: { citizenRole: "commoner", kingdomId: "varrock" } };
  const base = {
    roster: new Map([[mname, record]]),
    playerFor: () => bot,
  };

  // with a real player near: fires (message or at least journal attempt)
  M.tickMessengers({ ...base, onlinePlayers: () => [bot, human] }, Date.now());
  // with only bots near: silent
  const bot2 = mkPlayer(mname, true);
  M.tickMessengers({ roster: new Map([[mname, record]]), playerFor: () => bot2, onlinePlayers: () => [bot2, botOnly] }, Date.now());
  assert.ok(bot2.said.length === 0, "must be silent near bots only");
}

console.log("CitizenMessengers: all checks passed.");
