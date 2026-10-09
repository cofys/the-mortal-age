// CitizenAlchemists unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const A = require("./CitizenAlchemists");

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
  console.log("ok -", name);
}

check("hashStr is deterministic and distributes", () => {
  assert.equal(A.hashStr("alice"), A.hashStr("alice"));
  assert.notEqual(A.hashStr("alice"), A.hashStr("bob"));
});

check("alchemistTypeFor is stable and ~6% of names are alchemists (primary-profession partition)", () => {
  let alchemists = 0;
  for (let i = 0; i < 2000; i++) {
    const t = A.alchemistTypeFor("user" + i);
    assert.equal(t, A.alchemistTypeFor("user" + i), "stable");
    if (t !== null) {
      assert.ok(A.ALCHEMIST_TYPES.includes(t), "known type");
      alchemists++;
    }
  }
  const rate = alchemists / 2000;
  assert.ok(rate > 0.03 && rate < 0.10, "approx 6% (primary-profession partition), got " + rate);
  assert.equal(A.alchemistTypeFor(""), null);
  assert.equal(A.alchemistTypeFor(null), null);
});

check("labFor prefers the citizen's kingdom", () => {
  const lab = A.labFor("someuser", "keldagrim");
  assert.equal(lab.kingdom, "keldagrim");
  const unknown = A.labFor("someuser", "narnia");
  assert.ok(A.LABS.includes(unknown), "falls back to any lab");
  assert.equal(A.labFor("alice", "misthalin"), A.labFor("alice", "misthalin"));
});

check("brewFor is stable within a day and varies across days", () => {
  const d1 = new Date("2026-01-15T10:00:00Z").getTime();
  const d2 = new Date("2026-01-15T18:00:00Z").getTime();
  assert.equal(A.brewFor("alice", d1), A.brewFor("alice", d2), "same day");
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add(A.brewFor("alice", d1 + i * 86400000));
  assert.ok(seen.size > 1, "varies across days");
  // All brews come from the BREWS tables.
  const all = Object.values(A.BREWS).flat();
  assert.ok(all.includes(A.brewFor("alice", d1)), "brew in table");
});

check("transmutationFor and breakthroughFor return known values", () => {
  const d = new Date("2026-06-01T12:00:00Z").getTime();
  assert.ok(A.TRANSMUTATIONS.includes(A.transmutationFor("alice", d)));
  assert.ok(A.BREAKTHROUGHS.includes(A.breakthroughFor("alice", d)));
  assert.equal(A.transmutationFor("alice", d), A.transmutationFor("alice", d));
});

check("waresFor returns a remedy string", () => {
  const d = new Date("2026-03-01T12:00:00Z").getTime();
  const w = A.waresFor("alice", d);
  assert.equal(typeof w, "string");
  assert.ok(w.length > 0);
});

check("seasonFor maps months sanely", () => {
  const s = A.seasonFor(new Date("2026-07-01T12:00:00Z").getTime());
  assert.ok(["spring", "summer", "autumn", "winter"].includes(s));
});

check("ingredientsFor returns non-empty lists with fallback", () => {
  for (const s of ["spring", "summer", "autumn", "winter"]) {
    const got = A.ingredientsFor(s);
    assert.ok(Array.isArray(got) && got.length > 0, "ingredients for " + s);
  }
});

check("workLineFor covers every alchemist type", () => {
  const rng = lcg(42);
  for (const t of A.ALCHEMIST_TYPES) {
    const line = A.workLineFor(rng, t);
    assert.equal(typeof line, "string");
    assert.ok(line.length > 0, "line for " + t);
  }
});

check("hawkLineFor fills wares and lab templates", () => {
  const line = A.hawkLineFor(lcg(1), "sunbloom potion", { name: "the Varrock alchemists' tower" });
  assert.ok(line.includes("sunbloom potion"));
  assert.ok(line.includes("the Varrock alchemists' tower"));
  assert.ok(!line.includes("{wares}") && !line.includes("{lab}"));
});

check("breakthroughLineFor fills discovery and lab templates", () => {
  // Find a template containing the lab slot (not all templates do).
  let line = null;
  for (let seed = 0; seed < 100 && !line; seed++) {
    const cand = A.breakthroughLineFor(lcg(seed), "a stable gold-tinted elixir", { name: "the Falador alchemists' guild" });
    assert.ok(cand.includes("a stable gold-tinted elixir"));
    assert.ok(!cand.includes("{find}"));
    if (cand.includes("the Falador alchemists' guild")) line = cand;
  }
  assert.ok(line, "found a lab-bearing template");
});

check("mishapLineFor returns a known mishap", () => {
  const line = A.mishapLineFor(lcg(3));
  assert.ok(A.MISHAP_LINES.includes(line));
});

check("teachLineFor fills the brew template", () => {
  const line = A.teachLineFor(lcg(4), "nettle tea draught");
  assert.ok(line.includes("nettle tea draught"));
  assert.ok(!line.includes("{brew}"));
});

check("shouldFire/shouldHawk/shouldTeach gates respect cooldowns", () => {
  const now = 10 * 3600 * 1000;
  assert.ok(A.shouldFire(0, now));
  assert.ok(!A.shouldFire(now, now));
  assert.ok(!A.shouldFire(now - 1000, now));
  assert.ok(A.shouldFire(now - 4 * 3600 * 1000, now));
  assert.ok(A.shouldHawk(0, now) && !A.shouldHawk(now, now));
  assert.ok(A.shouldTeach(0, now) && !A.shouldTeach(now, now));
});

check("animFor returns the engine-verified herblore anim", () => {
  assert.equal(A.animFor("potion-brewer"), 363);
  assert.equal(A.animFor("transmuter"), 363);
  assert.equal(A.ANIM_HERBLORE, 363);
});

check("potionsFor supply hook is self-consistent", () => {
  const d = new Date("2026-04-10T12:00:00Z").getTime();
  // Find an alchemist username deterministically.
  let name = null;
  for (let i = 0; i < 200 && !name; i++) {
    if (A.alchemistTypeFor("supply" + i)) name = "supply" + i;
  }
  assert.ok(name, "found an alchemist");
  const p = A.potionsFor(name, "misthalin", d);
  assert.ok(p);
  assert.equal(p.brew, A.brewFor(name, d));
  assert.equal(p.wares, A.waresFor(name, d));
  assert.equal(p.lab, A.labFor(name, "misthalin").name);
  // Non-alchemists get null.
  let nonAlch = null;
  for (let i = 0; i < 200 && !nonAlch; i++) {
    if (!A.alchemistTypeFor("non" + i)) nonAlch = "non" + i;
  }
  assert.ok(nonAlch, "found a non-alchemist");
  assert.equal(A.potionsFor(nonAlch, "misthalin", d), null);
});

check("isRealPlayer gates bots and nulls", () => {
  assert.equal(A.isRealPlayer(null), false);
  assert.equal(A.isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false);
  assert.equal(A.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(A.isRealPlayer({ getUsername: () => "RealHuman" }), true);
});

check("withinTiles uses Chebyshev distance on the same plane", () => {
  const mk = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.ok(A.withinTiles(mk(0, 0, 0), mk(10, 5, 0), 14));
  assert.ok(!A.withinTiles(mk(0, 0, 0), mk(15, 0, 0), 14));
  assert.ok(!A.withinTiles(mk(0, 0, 0), mk(1, 1, 1), 14), "different plane");
});

check("canonical journal API is live (no journalFor — the old call was a dead no-op)", () => {
  const J = require("./CitizenJournal");
  assert.equal(typeof J.getJournal, "function");
  assert.equal(J.journalFor, undefined, "journalFor does not exist on CitizenJournal");
  assert.equal(typeof J.getJournal().log, "function");
});

check("tickAlchemists fires visible work near a real player (isOnline+getBot, bot-local players)", () => {
  A._resetState();
  // Find a stable alchemist username.
  let name = null;
  for (let i = 0; i < 500 && !name; i++) {
    if (A.alchemistTypeFor("tickalch" + i)) name = "tickalch" + i;
  }
  assert.ok(name, "found alchemist for tick test");
  const chats = [];
  const realPlayer = {
    getUsername: () => "RealHuman",
    getLocation: () => ({ getX: () => 5, getY: () => 5, getZ: () => 0 }),
  };
  const bot = {
    forceChat: (l) => chats.push(l),
    performAnimation: () => {},
    getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
    // Canonical proximity source: engine Player API on the bot.
    getLocalPlayers: () => [realPlayer],
  };
  const record = { username: name, role: "commoner", kingdomId: "misthalin" };
  const director = {
    roster: new Map([[name, record]]),
    isOnline: (rec) => rec.username === name,
    getBot: () => bot,
    api: { core: { Animation: class { constructor(id) { this.id = id; } } } },
  };
  // Force the chance gate open.
  const origRandom = Math.random;
  Math.random = () => 0.01;
  try {
    A.tickAlchemists(director, 10 * 3600 * 1000);
  } finally {
    Math.random = origRandom;
  }
  assert.ok(chats.length > 0, "a visible work line fired");
  // The visible loop journaled a work event into the real journal module.
  const J = require("./CitizenJournal");
  const recent = J.getJournal().recent(name, 3);
  assert.ok(recent.length > 0 && recent[0].kind === "work", "journal got a work event for " + name);
  // kingdomId flow (the fixed record.kingdomId field): the journaled lab
  // must be a misthalin lab, not a fallback from an undefined kingdom.
  const misthalinLabs = A.LABS.filter((l) => l.kingdom === "misthalin").map((l) => l.name);
  assert.ok(
    misthalinLabs.some((lab) => recent[0].text.includes(lab)),
    "journaled lab is kingdom-preferred: " + recent[0].text
  );
});

check("tickAlchemists stays silent when no real player is near (bots-only bot-local players)", () => {
  A._resetState();
  let name = null;
  for (let i = 0; i < 500 && !name; i++) {
    if (A.alchemistTypeFor("quiet" + i)) name = "quiet" + i;
  }
  assert.ok(name, "found alchemist for quiet test");
  const chats = [];
  const botOnly = {
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => name + "_bot",
    getLocation: () => ({ getX: () => 1, getY: () => 1, getZ: () => 0 }),
  };
  const bot = {
    forceChat: (l) => chats.push(l),
    performAnimation: () => {},
    getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
    getLocalPlayers: () => [botOnly],
  };
  const record = { username: name, role: "commoner", kingdomId: "misthalin" };
  const director = {
    roster: new Map([[name, record]]),
    isOnline: (rec) => rec.username === name,
    getBot: () => bot,
    api: { core: { Animation: class { constructor(id) { this.id = id; } } } },
  };
  const origRandom = Math.random;
  Math.random = () => 0.01;
  try {
    A.tickAlchemists(director, 20 * 3600 * 1000);
  } finally {
    Math.random = origRandom;
  }
  assert.equal(chats.length, 0, "no output near bots only");
});

check("tickAlchemists stays silent when the citizen is offline (isOnline false)", () => {
  A._resetState();
  let name = null;
  for (let i = 0; i < 500 && !name; i++) {
    if (A.alchemistTypeFor("offl" + i)) name = "offl" + i;
  }
  assert.ok(name, "found alchemist for offline test");
  const record = { username: name, role: "commoner", kingdomId: "misthalin" };
  const director = {
    roster: new Map([[name, record]]),
    isOnline: () => false,
    getBot: () => { throw new Error("getBot must not be called when offline"); },
  };
  const origRandom = Math.random;
  Math.random = () => 0.01;
  try {
    A.tickAlchemists(director, 30 * 3600 * 1000);
  } finally {
    Math.random = origRandom;
  }
});

check("tickAlchemists never throws on hostile input", () => {
  A._resetState();
  A.tickAlchemists(null, Date.now());
  A.tickAlchemists({}, Date.now());
  A.tickAlchemists({ roster: { values: () => { throw new Error("boom"); } } }, Date.now());
});

console.log("\n" + passed + " checks passed");
