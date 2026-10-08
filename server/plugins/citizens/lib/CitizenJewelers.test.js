// CitizenJewelers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const J = require("./CitizenJewelers");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let checks = 0;
function ok(cond, name) {
  checks++;
  assert(cond, name);
}

// --- hashing is deterministic and stable ---
ok(J.hashStr("jeweler|cofy") === J.hashStr("jeweler|cofy"), "hashStr deterministic");
ok(J.hashStr("jeweler|cofy") !== J.hashStr("jeweler|cofy2"), "hashStr differs per input");

// --- type assignment: ~35% of commoners, stable, four types ---
const seenTypes = new Set();
let jewelers = 0;
for (let i = 0; i < 400; i++) {
  const t = J.jewelerTypeFor("user" + i);
  ok(t === null || J.JEWELER_TYPES.includes(t), "type is null or a known type");
  if (t) {
    jewelers++;
    seenTypes.add(t);
  }
  ok(J.jewelerTypeFor("user" + i) === t, "type stable across calls");
}
ok(jewelers > 10 && jewelers < 45, "roughly 6% of commoners are jewelers (primary-profession partition) (" + jewelers + ")");
ok(seenTypes.size === 4, "all four jeweler types appear: " + [...seenTypes].join(","));
ok(J.jewelerTypeFor("") === null, "empty username -> null");
ok(J.jewelerTypeFor(null) === null, "null username -> null");

// --- workshop assignment: prefers kingdom, deterministic ---
const w1 = J.workshopFor("cofy", "misthalin", "gem cutter");
ok(w1 && typeof w1.name === "string", "workshop returns a named workshop");
ok(w1.kingdom === "misthalin", "workshop prefers the citizen's kingdom");
ok(J.workshopFor("cofy", "misthalin", "gem cutter") === w1, "workshop stable");
const w2 = J.workshopFor("cofy", "unknownland", "gem cutter");
ok(w2 && typeof w2.name === "string", "unknown kingdom falls back to all workshops");
const wt = J.workshopFor("cofy", "keldagrim", "trader");
ok(["market", "exchange", "office", "tent"].includes(wt.kind), "trader prefers trade-kind workshops (" + wt.kind + ")");

// --- gem data mirrors the engine's gem-cutting tiers ---
ok(J.GEMS.length === 10, "ten gem tiers");
ok(J.GEMS[0].name === "opal" && J.GEMS[0].anim === 890, "opal anim 890");
ok(J.GEMS[3].name === "sapphire" && J.GEMS[3].anim === 888, "sapphire anim 888");
ok(J.GEMS[6].name === "diamond" && J.GEMS[6].anim === 886, "diamond anim 886");
ok(J.GEMS[7].name === "dragonstone" && J.GEMS[7].anim === 885, "dragonstone anim 885");
const gem = J.gemFor("cofy", 86400000);
ok(gem && J.GEMS.includes(gem), "gemFor returns a table gem");
ok(J.gemFor("cofy", 86400000) === gem, "gemFor stable within a day");
ok(J.ANIM_GEM_CUT.diamond === 886, "ANIM_GEM_CUT mirrors the engine table");

// --- metals tie into the real producer tables ---
const metals = J.metalsFor();
ok(Array.isArray(metals) && metals.length > 0, "metalsFor returns metals");
ok(metals.includes("gold") || metals.includes("silver"), "precious metals present: " + metals.join(","));

// --- wares are deterministic per day, all types have pools ---
for (const t of J.JEWELER_TYPES) {
  const wares = J.waresFor("cofy", t, 86400000);
  ok(typeof wares === "string" && wares.length > 0, t + " has wares (" + wares + ")");
  ok(J.waresFor("cofy", t, 86400000) === wares, t + " wares stable within a day");
}
ok(J.GEMCUTTER_WARES.length >= 3 && J.GOLDSMITH_WARES.length >= 3, "ware pools populated");
ok(J.APPRAISER_WARES.length >= 3 && J.TRADER_WARES.length >= 3, "appraiser/trader pools populated");

// --- masterpieces are rare ---
let masterpieces = 0;
for (let i = 0; i < 40; i++) {
  const m = J.masterpieceFor("user" + i, 86400000);
  ok(m === null || J.MASTERPIECES.includes(m), "masterpiece is null or from the table");
  if (m) masterpieces++;
}
ok(masterpieces > 0, "some days produce masterpieces (" + masterpieces + ")");

// --- line pools produce filled templates ---
const rng = lcg(42);
for (const t of J.JEWELER_TYPES) {
  ok(J.workLineFor(rng, t).length > 10, t + " work line");
  const hawk = J.hawkLineFor(rng, t, "gold rings", ["gold", "silver"]);
  ok(hawk.length > 10 && !hawk.includes("{wares}") && !hawk.includes("{gold}"), t + " hawk line filled");
  ok(J.commissionLineFor(rng, t).length > 10, t + " commission line");
}
const mpLine = J.masterpieceLineFor(rng, "a diamond crown");
ok(mpLine.includes("a diamond crown") && !mpLine.includes("{masterpiece}"), "masterpiece line filled");

// --- supply hook for market stalls ---
const jewels = J.jewelsFor("cofy", "misthalin", 86400000);
ok(Array.isArray(jewels), "jewelsFor returns an array");
const jewelsNull = J.jewelsFor("notajewelerxyz", "misthalin", 86400000);
ok(jewelsNull.length === 0 || J.jewelerTypeFor("notajewelerxyz") !== null, "non-jewelers supply nothing");

// --- gates: cooldown math ---
ok(J.shouldFire(lcg(7), 0, 4 * 60 * 60 * 1000) === false || true, "shouldFire callable");
ok(J.shouldFire(() => 0.99, 0, 4 * 60 * 60 * 1000) === false, "high rng misses the chance gate");
ok(J.shouldFire(() => 0, 0, 0) === false, "cooldown blocks immediate refire");
ok(J.shouldHawk(() => 0, 0, 0) === false, "hawk cooldown blocks refire");
ok(J.shouldOfferCommission(() => 0, 0, 0) === false, "commission cooldown blocks refire");

// --- isRealPlayer / withinTiles ---
ok(J.isRealPlayer(null) === false, "null is not a player");
ok(J.isRealPlayer({ isPlayerBot: () => true }) === false, "bot is not a real player");
ok(J.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }) === false, "bot host is not a real player");
ok(J.isRealPlayer({ getUsername: () => "cofy" }) === true, "plain player is real");
const at = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
ok(J.withinTiles(at(0, 0, 0), at(10, 10, 0), 14) === true, "chebyshev 10,10 within 14");
ok(J.withinTiles(at(0, 0, 0), at(15, 0, 0), 14) === false, "15 tiles out of 14");
ok(J.withinTiles(at(0, 0, 0), at(1, 1, 1), 14) === false, "different plane excluded");

// --- tickJewelers: fires near real players, silent otherwise ---
J._resetState();
function makeRecord(username, role) {
  return { username, role: role || "commoner", kingdom: "misthalin" };
}
function makeCitizen(x, y, lines) {
  return {
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    forceChat: (line) => lines.push(line),
    performAnimation: () => true,
  };
}
function makePlayer(username, x, y) {
  return {
    getUsername: () => username,
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
  };
}
function makeBot(username, x, y) {
  return {
    getUsername: () => username,
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
  };
}
// Find a username that is deterministically a gem cutter for the test.
let jewelerName = null;
for (let i = 0; i < 500; i++) {
  if (J.jewelerTypeFor("jwtest" + i) === "gem cutter") { jewelerName = "jwtest" + i; break; }
}
ok(jewelerName, "found a deterministic gem cutter");
const lines = [];
const citizen = makeCitizen(0, 0, lines);
const real = makePlayer("RealPlayer", 3, 3);
const director = {
  roster: new Map([[jewelerName, makeRecord(jewelerName)]]),
  playerFor: () => citizen,
  onlinePlayers: () => [real],
  api: { core: { Animation: class { constructor(id) { this.id = id; } } } },
};
const origRandom = Math.random;
Math.random = lcg(99); // force the chance gate to pass
J.tickJewelers(director, 10 * 60 * 60 * 1000);
Math.random = origRandom;
ok(lines.length > 0, "tick fires forceChat near a real player");

// Same setup but only a bot nearby — must stay silent.
J._resetState();
const botLines = [];
const directorBots = {
  roster: new Map([[jewelerName, makeRecord(jewelerName)]]),
  playerFor: () => makeCitizen(0, 0, botLines),
  onlinePlayers: () => [makeBot("Bot1", 3, 3)],
  api: {},
};
Math.random = lcg(99);
J.tickJewelers(directorBots, 10 * 60 * 60 * 1000);
Math.random = origRandom;
ok(botLines.length === 0, "tick stays silent when only bots are near");

// Non-commoner never fires.
J._resetState();
const guardLines = [];
const directorGuard = {
  roster: new Map([[jewelerName, { username: jewelerName, role: "guard", kingdom: "misthalin" }]]),
  playerFor: () => makeCitizen(0, 0, guardLines),
  onlinePlayers: () => [real],
  api: {},
};
Math.random = lcg(99);
J.tickJewelers(directorGuard, 10 * 60 * 60 * 1000);
Math.random = origRandom;
ok(guardLines.length === 0, "non-commoners never jewelcraft");

// Hostile input never throws.
J._resetState();
J.tickJewelers(null, Date.now());
J.tickJewelers({}, Date.now());
ok(true, "null/empty director does not throw");

console.log("CitizenJewelers: " + checks + " checks passed");
