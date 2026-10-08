// CitizenApprentices unit checks — pure logic + mocked director, no running server.
// Run: cd server/plugins/citizens && node lib/CitizenApprentices.test.js

// Isolate filesystem writes: point process.cwd() at a temp dir BEFORE requires.
const os = require("os");
const path = require("path");
const fs = require("fs");
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "apprentice-test-"));
process.chdir(testDir);

const assert = require("node:assert/strict");
const {
  tickApprenticeships,
  tickApprenticeLife,
  eligibleMaster,
  eligibleApprentice,
  xpPerTick,
  hasGraduated,
  tradeTitle,
  apprenticeQuestion,
  masterTeaching,
  pickOne,
  isRealPlayer,
  withinTiles,
  _pairs,
} = require("./CitizenApprentices");
const { skillStore } = require("./CitizenSkilling");
const { getJournal } = require("./CitizenJournal");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let n = 0;

// --- tradeTitle ---
assert.equal(tradeTitle("woodcutting"), "woodcutter"); n++;
assert.equal(tradeTitle("fishing"), "fisher"); n++;
assert.equal(tradeTitle("mining"), "miner"); n++;
assert.equal(tradeTitle("cooking"), "cook"); n++;
assert.equal(tradeTitle("mystery"), "mystery"); n++; // unknown skills pass through

// --- pickOne deterministic ---
const rngA = lcg(42);
assert.equal(pickOne(rngA, ["a", "b", "c"]), pickOne(lcg(42), ["a", "b", "c"])); n++;

// --- xpPerTick bounds ---
const rngB = lcg(7);
for (let i = 0; i < 200; i++) {
  const xp = xpPerTick(rngB);
  assert.ok(xp >= 6 && xp <= 12, `xpPerTick out of bounds: ${xp}`);
}
n++;

// --- chatter pools return non-empty strings ---
const rngC = lcg(99);
const q = apprenticeQuestion(rngC, "woodcutting");
const t = masterTeaching(rngC, "woodcutting");
assert.ok(typeof q === "string" && q.length > 5); n++;
assert.ok(typeof t === "string" && t.length > 5); n++;

// --- eligibleMaster ---
skillStore.addXp("Testmaster One", "woodcutting", 300000); // level 60+
const masterRec = { username: "Testmaster One", role: "commoner", kingdomId: "asgarnia" };
const em = eligibleMaster(masterRec, new Set(), new Set());
assert.ok(em && em.skills.includes("woodcutting")); n++;
assert.equal(eligibleMaster({ username: "Guard Guy", role: "guard", kingdomId: "k" }, new Set(), new Set()), null); n++; // guards don't take apprentices
assert.equal(eligibleMaster({ username: "Novice Ned", role: "commoner", kingdomId: "k" }, new Set(), new Set()), null); n++; // no mastered trade
assert.equal(eligibleMaster(masterRec, new Set(["testmaster one"]), new Set()), null); n++; // already teaching
assert.equal(eligibleMaster(masterRec, new Set(), new Set(["testmaster one"])), null); n++; // is an apprentice

// --- eligibleApprentice ---
const youthRec = { username: "Testyouth One", role: "commoner", kingdomId: "asgarnia" };
const ea = eligibleApprentice(youthRec, new Set(), new Set());
assert.ok(ea && ea.name === "testyouth one"); n++;
assert.equal(eligibleApprentice({ username: "Refugee Rae", role: "refugee", kingdomId: "k" }, new Set(), new Set())?.name, "refugee rae"); n++;
skillStore.addXp("Skilled Sam", "mining", 300000);
assert.equal(eligibleApprentice({ username: "Skilled Sam", role: "commoner", kingdomId: "k" }, new Set(), new Set()), null); n++; // too skilled
assert.equal(eligibleApprentice(youthRec, new Set(["testmaster one"]), new Set(["testyouth one"])), null); n++; // already apprenticed

// --- hasGraduated ---
assert.equal(hasGraduated("Testyouth One", "woodcutting"), false); n++;
skillStore.addXp("Testyouth One", "woodcutting", 40000); // level 40+
assert.equal(hasGraduated("Testyouth One", "woodcutting"), true); n++;

// --- isRealPlayer / withinTiles ---
const realPlayer = { getUsername: () => "Jon" };
assert.equal(isRealPlayer(realPlayer), true); n++;
assert.equal(isRealPlayer({ getUsername: () => "Bot", isPlayerBot: () => true }), false); n++;
assert.equal(isRealPlayer({ getUsername: () => "Bot", getHostAddress: () => "bot" }), false); n++;
const tile = (x, y, z = 0) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
assert.equal(withinTiles(tile(0, 0), tile(5, 5), 12), true); n++;
assert.equal(withinTiles(tile(0, 0), tile(50, 0), 12), false); n++;
assert.equal(withinTiles(tile(0, 0, 1), tile(0, 0, 0), 12), false); n++;

// --- tickApprenticeships: pairing ---
_pairs.clear();
skillStore.addXp("Pairmaster Pam", "fishing", 300000);
skillStore.addXp("Pairyouth Pat", "fishing", 0);
const roster = new Map([
  ["pairmaster pam", { username: "Pairmaster Pam", role: "merchant", kingdomId: "kandarin" }],
  ["pairyouth pat", { username: "Pairyouth Pat", role: "commoner", kingdomId: "kandarin" }],
  ["faryouth far", { username: "Faryouth Far", role: "commoner", kingdomId: "morytania" }], // wrong kingdom
]);
tickApprenticeships({ roster }, Date.now());
assert.ok(_pairs.has("pairyouth pat"), "expected pairing to form"); n++;
assert.equal(_pairs.get("pairyouth pat").master, "pairmaster pam"); n++;
assert.equal(_pairs.get("pairyouth pat").skill, "fishing"); n++;
// Journal entries for both master and apprentice.
const mj = getJournal().recent("Pairmaster Pam", 3).map((e) => e.text).join(" ");
const aj = getJournal().recent("Pairyouth Pat", 3).map((e) => e.text).join(" ");
assert.ok(mj.includes("apprentice"), `master journal missing: ${mj}`); n++;
assert.ok(aj.includes("apprentice"), `apprentice journal missing: ${aj}`); n++;

// --- tickApprenticeships: graduation ---
skillStore.addXp("Pairyouth Pat", "fishing", 40000); // push past 40
tickApprenticeships({ roster }, Date.now());
assert.ok(!_pairs.has("pairyouth pat"), "expected graduation to clear the pair"); n++;
const gj = getJournal().recent("Pairyouth Pat", 2).map((e) => e.text).join(" ");
assert.ok(gj.toLowerCase().includes("graduated"), `graduation journal missing: ${gj}`); n++;

// --- tickApprenticeLife: visible chatter ---
_pairs.clear();
_pairs.set("chatyouth", { master: "chatmaster", skill: "cooking", since: 0 });
const chatLines = { youth: [], master: [] };
const botAt = (x, y) => ({
  getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
  forceChat: (line) => chatLines.youth.push(line),
});
const masterBotAt = (x, y) => ({
  getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
  forceChat: (line) => chatLines.master.push(line),
});
const mockDirector = {
  roster: new Map([
    ["chatyouth", { username: "Chatyouth", role: "commoner", kingdomId: "k" }],
    ["chatmaster", { username: "Chatmaster", role: "merchant", kingdomId: "k" }],
  ]),
  playerFor: (rec) =>
    rec?.username === "Chatyouth" ? botAt(100, 100) : rec?.username === "Chatmaster" ? masterBotAt(102, 100) : null,
  onlinePlayers: () => [{ getUsername: () => "RealPlayer", getLocation: () => ({ getX: () => 105, getY: () => 100, getZ: () => 0 }) }],
};
const zeroRng = () => 0; // always under CHATTER_CHANCE
tickApprenticeLife(mockDirector, Date.now(), zeroRng);
assert.equal(chatLines.youth.length, 1, "apprentice should ask a question"); n++;
assert.equal(chatLines.master.length, 1, "master should answer"); n++;
// Cooldown: same nowMs fires nothing more.
tickApprenticeLife(mockDirector, Date.now(), zeroRng);
assert.equal(chatLines.youth.length, 1, "cooldown should suppress repeat chatter"); n++;
// No real player near: silence.
_pairs.set("lone youth", { master: "chatmaster", skill: "mining", since: 0 });
const lonelyDirector = {
  ...mockDirector,
  roster: new Map([["lone youth", { username: "Lone Youth", role: "commoner", kingdomId: "k" }]]),
  playerFor: () => botAt(900, 900),
  onlinePlayers: () => [],
};
tickApprenticeLife(lonelyDirector, Date.now() + 3600 * 1000, zeroRng);
assert.equal(chatLines.youth.length, 1, "no chatter without a real player nearby"); n++;

console.log(`CitizenApprentices: ${n} assertions passed`);
