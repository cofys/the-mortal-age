"use strict";
// CitizenBlacksmiths unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const B = require("./CitizenBlacksmiths");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- hashStr: stable, unsigned, case-sensitive input diff ---
{
  const a = B.hashStr("smith|cofyg");
  assert.equal(B.hashStr("smith|cofyg"), a, "hashStr deterministic");
  assert.ok(a >= 0 && a <= 0xffffffff, "hashStr unsigned 32-bit");
  assert.notEqual(B.hashStr("smith|cofyg"), B.hashStr("smith|other"), "hashStr discriminates input");
  assert.notEqual(B.hashStr("smith|cofyg"), B.hashStr("tailor|cofyg"), "salt differs from other features");
}

// --- smithTypeFor: ~35% of usernames, one of 4 types, stable ---
{
  const types = new Set();
  let smithCount = 0;
  for (let i = 0; i < 1000; i++) {
    const t = B.smithTypeFor("citizen" + i);
    if (t) {
      smithCount++;
      types.add(t);
      assert.ok(B.SMITH_TYPES.includes(t), "type in SMITH_TYPES");
    }
  }
  const ratio = smithCount / 1000;
  assert.ok(ratio > 0.28 && ratio < 0.42, `~35% smiths, got ${ratio}`);
  assert.deepEqual([...types].sort(), [...B.SMITH_TYPES].sort(), "all four types occur");
  assert.equal(B.smithTypeFor("Citizen5"), B.smithTypeFor("citizen5"), "case-insensitive assignment");
  assert.equal(B.smithTypeFor(null), null, "null username -> null");
  assert.equal(B.smithTypeFor(""), null, "empty username -> null");
  assert.equal(B.smithTypeFor("citizen5"), B.smithTypeFor("citizen5"), "stable across calls");
}

// --- forgeFor: prefers the citizen's kingdom ---
{
  const f = B.forgeFor("cofyg", "keldagrim");
  assert.ok(f && f.name && f.kingdom === "keldagrim", "kingdom-preferred forge");
  const f2 = B.forgeFor("cofyg", "unknownkingdom");
  assert.ok(B.FORGES.includes(f2), "unknown kingdom falls back to full list");
  assert.equal(B.forgeFor("cofyg", "keldagrim"), B.forgeFor("cofyg", "keldagrim"), "stable assignment");
}

// --- metalFor: derived, falls back gracefully ---
{
  const m = B.metalFor("cofyg", Date.UTC(2026, 5, 1));
  assert.ok(B.METALS.includes(m), `metal in METALS, got ${m}`);
  assert.equal(B.metalFor("cofyg", Date.UTC(2026, 5, 1)), B.metalFor("cofyg", Date.UTC(2026, 5, 1)), "stable per day");
}

// --- wareFor: label built from metal + item ---
{
  const w = B.wareFor("cofyg", "weaponsmith", Date.UTC(2026, 5, 1));
  assert.ok(w.metal && w.item && w.label, "ware has metal, item, label");
  assert.equal(w.label, `${w.metal} ${w.item}`, "label composed correctly");
  const f = B.wareFor("cofyg", "farrier", Date.UTC(2026, 5, 1));
  assert.ok(f.item.includes("hammer") || f.item.includes("shoe") || f.item.includes("rasp") || f.item.includes("adze") || f.item.includes("chisel") || f.item.includes("spike"), "farrier wares are tools/shoes");
}

// --- jobFor: pairs a label with a forge name ---
{
  const j = B.jobFor("cofyg", "armorsmith", Date.UTC(2026, 5, 1));
  assert.ok(j.label && j.forge, "job has label and forge");
  assert.ok(j.forge.includes("forge") || j.forge.includes("furnace") || j.forge.includes("smithy") || j.forge.includes("anvil") || j.forge.includes("hall"), "forge name is forge-y");
}

// --- masterworkFor: rare, derived per day ---
{
  let hits = 0;
  for (let i = 0; i < 2000; i++) {
    const mw = B.masterworkFor("smith" + i, Date.UTC(2026, 5, 1));
    if (mw) {
      hits++;
      assert.equal(typeof mw, "string", "masterwork is a string");
    }
  }
  const ratio = hits / 2000;
  assert.ok(ratio > 0.03 && ratio < 0.15, `masterwork rate ~8%, got ${ratio}`);
}

// --- shouldFire: cooldown + chance ---
{
  const now = 20_000_000; // well past the 3h work cooldown
  assert.equal(B.shouldFire(lcg(1), now - 60 * 1000, now), false, "cooldown blocks");
  assert.equal(B.shouldFire(() => 0.99, 0, now), false, "high rng roll blocks");
  assert.equal(B.shouldFire(() => 0.0, 0, now), true, "low rng roll fires after cooldown");
}

// --- pickOne: bounded ---
{
  const rng = lcg(42);
  for (let i = 0; i < 50; i++) {
    const p = B.pickOne(rng, ["a", "b", "c"]);
    assert.ok(["a", "b", "c"].includes(p), "pickOne within array");
  }
}

// --- isRealPlayer / withinTiles ---
{
  const mkLoc = (x, y, z) => ({ getX: () => x, getY: () => y, getZ: () => z });
  const mkPlayer = (x, y, z, bot) => ({
    getUsername: () => "real",
    isPlayerBot: () => bot === true,
    getHostAddress: () => (bot ? "bot" : "127.0.0.1"),
    getLocation: () => mkLoc(x, y, z),
  });
  assert.equal(B.isRealPlayer(mkPlayer(0, 0, 0, false)), true, "real player passes");
  assert.equal(B.isRealPlayer(mkPlayer(0, 0, 0, true)), false, "bot fails");
  assert.equal(B.isRealPlayer(null), false, "null fails");
  assert.equal(B.withinTiles(mkPlayer(0, 0, 0), mkPlayer(10, 10, 0), 14), true, "14 tiles Chebyshev passes");
  assert.equal(B.withinTiles(mkPlayer(0, 0, 0), mkPlayer(15, 0, 0), 14), false, "15 tiles fails");
  assert.equal(B.withinTiles(mkPlayer(0, 0, 0), mkPlayer(0, 0, 1), 14), false, "different plane fails");
}

// --- waresFor: supply hook shape ---
{
  const w = B.waresFor("citizen5", "misthalin", Date.UTC(2026, 5, 1));
  // citizen5 may or may not be a smith — either way the shape holds
  if (w) {
    assert.ok(w.type && w.label && w.metal && w.item && w.forge, "waresFor returns full record");
    assert.ok(B.FORGES.some((f) => f.name === w.forge), "forge name from FORGES");
  } else {
    assert.equal(w, null, "non-smith -> null");
  }
  // find a guaranteed smith and check
  let found = null;
  for (let i = 0; i < 200 && !found; i++) {
    const t = B.smithTypeFor("sm" + i);
    if (t) found = { u: "sm" + i, t };
  }
  assert.ok(found, "test seed produced a smith");
  const w2 = B.waresFor(found.u, "asgarnia", Date.UTC(2026, 5, 1));
  assert.ok(w2 && w2.type === found.t, "waresFor honors smith type");
}

// --- tickSmiths: never throws on hostile input ---
{
  assert.doesNotThrow(() => B.tickSmiths(null, Date.now()), "null director safe");
  assert.doesNotThrow(() => B.tickSmiths({}, Date.now()), "empty director safe");
  assert.doesNotThrow(() => B.tickSmiths({ roster: new Map() }, Date.now()), "empty roster safe");
}

// --- tickSmiths: fires near real players, silent near bots only ---
{
  // Build a fake director with one smith citizen materialized.
  let smithName = null;
  for (let i = 0; i < 200 && !smithName; i++) {
    if (B.smithTypeFor("tsm" + i)) smithName = "tsm" + i;
  }
  assert.ok(smithName, "seed produced a smith");
  const forced = [];
  const citizenBot = {
    forceChat: (line) => forced.push(line),
    performAnimation: () => {},
    getLocation: () => ({ getX: () => 3000, getY: () => 3000, getZ: () => 0 }),
  };
  const mkHuman = (x) => ({
    getUsername: () => "human",
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    getLocation: () => ({ getX: () => x, getY: () => 3000, getZ: () => 0 }),
  });
  const mkBot = () => ({
    getUsername: () => "botty",
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getLocation: () => ({ getX: () => 3005, getY: () => 3000, getZ: () => 0 }),
  });
  const mkDirector = (online) => ({
    roster: new Map([[smithName, { username: smithName, role: "commoner" }]]),
    playerFor: () => citizenBot,
    onlinePlayers: () => online,
    api: { core: { Animation: function (id) { this.id = id; } } },
  });

  // Only a bot online -> no visible work, nothing said.
  B.tickSmiths(mkDirector([mkBot()]), Date.now());
  assert.equal(forced.length, 0, "silent when only bots are near");

  // A real player near -> chance-gated; force chance high by repeating.
  let fired = false;
  const real = Math.random;
  Math.random = () => 0.0; // force all chance gates open
  try {
    for (let i = 0; i < 5 && !fired; i++) {
      B.tickSmiths(mkDirector([mkHuman(3005)]), Date.now());
      fired = forced.length > 0;
    }
  } finally {
    Math.random = real;
  }
  assert.ok(fired, "visible work fires near a real player");
}

// --- guards never smith ---
{
  const record = { username: "someguard", role: "guard" };
  const director = {
    roster: new Map([["someguard", record]]),
    playerFor: () => ({ forceChat: () => { throw new Error("should not fire"); }, performAnimation: () => {} }),
    onlinePlayers: () => [
      {
        getUsername: () => "human",
        isPlayerBot: () => false,
        getHostAddress: () => "127.0.0.1",
        getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
      },
    ],
  };
  const real = Math.random;
  Math.random = () => 0.0;
  try {
    assert.doesNotThrow(() => B.tickSmiths(director, Date.now()), "guard record never fires");
  } finally {
    Math.random = real;
  }
}

console.log("CitizenBlacksmiths: all checks passed.");
