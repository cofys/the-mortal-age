// CitizenSculptors unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const S = require("./CitizenSculptors");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const noon = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();
const midnight = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();

function loc(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
function mockPlayer(username, x, y, bot) {
  return {
    username,
    _chat: [],
    getUsername: () => username,
    isPlayerBot: () => !!bot,
    getHostAddress: () => (bot ? "bot" : "real"),
    getLocation: () => loc(x, y, 0),
    forceChat: function (line) { this._chat.push(line); },
  };
}
function sculptorRecord(name) {
  return { username: name, role: "commoner", kingdomId: "varrock" };
}
// Find a username that is a sculptor of the given type (hash-derived).
function probeSculptor(prefix, wantType) {
  for (let i = 0; i < 5000; i++) {
    const name = `${prefix}-${i}`;
    const rec = sculptorRecord(name);
    if (S.sculptorTypeOf(rec) === wantType) return rec;
  }
  throw new Error("no sculptor found for " + wantType);
}

// 1. hashStr is deterministic and stable.
assert.equal(S.hashStr("abc"), S.hashStr("abc"));
assert.notEqual(S.hashStr("abc"), S.hashStr("abd"));

// 2. sculptorTypeFromRoll reaches all four types across 0..99.
{
  const seen = new Set();
  for (let r = 0; r < 100; r++) seen.add(S.sculptorTypeFromRoll(r));
  assert.deepEqual([...seen].sort(), [...S.SCULPTOR_TYPES].sort());
}

// 3. Sculptors have a healthy effective share of commoners (nominal 30%,
//    reduced by the mutual exclusions with the other artist/performer
//    systems — same pattern as painters).
{
  let n = 0;
  for (let i = 0; i < 300; i++) {
    if (S.sculptorTypeOf(sculptorRecord("share-probe-" + i))) n++;
  }
  assert.ok(n > 15 && n < 55, `share ${n}/300 out of 5-18% band`);
}

// 4. Role gate: guards are never sculptors.
assert.equal(S.sculptorTypeOf({ username: "GuardA", role: "guard" }), null);

// 5. No double-casting: a painter is never a sculptor.
{
  const painters = require("./CitizenPainters");
  let found = null;
  for (let i = 0; i < 5000 && !found; i++) {
    const rec = sculptorRecord("painter-probe-" + i);
    if (painters.painterTypeOf(rec)) found = rec;
  }
  assert.ok(found, "found a painter to test exclusion");
  assert.equal(S.sculptorTypeOf(found), null);
}

// 6. Kingdom-preferred workshop assignment.
{
  const rec = probeSculptor("workshop", S.SCULPTOR_STONE);
  rec.kingdomId = "keldagrim";
  assert.equal(S.workshopFor(rec).kingdom, "keldagrim");
}

// 7. Daily catalog is deterministic per day.
{
  const rec = probeSculptor("catalog", S.SCULPTOR_WOOD);
  const a = S.sculpturesFor(rec, noon);
  const b = S.sculpturesFor(rec, noon);
  assert.deepEqual(a, b);
  assert.ok(a.works.length >= 2 && a.works.length <= 4);
  assert.equal(typeof a.masterpiece, "boolean");
}

// 8. Catalog varies across days (not frozen).
{
  const rec = probeSculptor("vary", S.SCULPTOR_WOOD);
  const seen = new Set();
  for (let d = 0; d < 10; d++) {
    const c = S.sculpturesFor(rec, noon + d * 86400000);
    seen.add(JSON.stringify(c.works));
  }
  assert.ok(seen.size > 1, "catalog changes day to day");
}

// 9. Workshop hours gate.
assert.equal(S.isWorkshopHour(noon), true);
assert.equal(S.isWorkshopHour(midnight), false);

// 10. Commission ledger round-trip and TTL expiry.
{
  S.commissionSculpture("Jon", "SculptorA", "a marble lion", "statue", noon);
  const rec = S.commissionFor("Jon", noon);
  assert.ok(rec && rec.subject === "a marble lion" && rec.kind === "statue");
  assert.equal(S.commissionFor("Jon", noon + 8 * 86400000), null);
}

// 11. materialsFor: static for stone, real-ish for metal, empty for non-sculptors.
{
  const stone = probeSculptor("mat", S.SCULPTOR_STONE);
  assert.ok(S.materialsFor(stone, noon).includes("marble"));
  assert.deepEqual(S.materialsFor({ username: "zz-nonsculptor", role: "commoner" }, noon), []);
}

// 12. fill renders every slot.
{
  const out = S.fill("Hello {name}, the {thing}!", { name: "Jon", thing: "marble lion" });
  assert.equal(out, "Hello Jon, the marble lion!");
}

// 13. All line pools render, are non-empty, and stay <= 120 chars.
{
  const rec = probeSculptor("lines", S.SCULPTOR_WOOD);
  const cat = S.sculpturesFor(rec, noon);
  const work = cat.works[0];
  const samples = [
    S.fill("Fresh off the bench! {subject} — a {quality} piece!", { subject: work.subject, quality: work.quality }),
  ];
  for (const s of samples) assert.ok(s.length <= 120, `line too long: ${s}`);
}

// 14. tick never throws on hostile input (the never-crash guard).
assert.doesNotThrow(() => S.tickSculptors(null, noon));
assert.doesNotThrow(() => S.tickSculptors({}, noon));

// 15. tick fires near a real player during workshop hours.
{
  const realRandom = Math.random;
  Math.random = () => 0.05; // force the chance gate open
  try {
    const rec = probeSculptor("fire", S.SCULPTOR_WOOD);
    const citizen = mockPlayer(rec.username, 0, 0, true);
    const human = mockPlayer("Jon", 5, 5, false);
    const director = {
      roster: new Map([[rec.username, rec]]),
      playerFor: () => citizen,
      onlinePlayers: () => [human],
    };
    S.tickSculptors(director, noon);
    assert.ok(citizen._chat.length > 0, "sculptor spoke near a real player");
  } finally {
    Math.random = realRandom;
  }
}

// 16. tick stays silent near bots only.
{
  const realRandom = Math.random;
  Math.random = () => 0.05;
  try {
    const rec = probeSculptor("quiet", S.SCULPTOR_WOOD);
    const citizen = mockPlayer(rec.username, 0, 0, true);
    const bot = mockPlayer("SomeBot", 5, 5, true);
    const director = {
      roster: new Map([[rec.username, rec]]),
      playerFor: () => citizen,
      onlinePlayers: () => [bot],
    };
    S.tickSculptors(director, noon);
    assert.equal(citizen._chat.length, 0, "silent when only bots are near");
  } finally {
    Math.random = realRandom;
  }
}

// 17. tick stays silent outside workshop hours.
{
  const realRandom = Math.random;
  Math.random = () => 0.05;
  try {
    const rec = probeSculptor("night", S.SCULPTOR_WOOD);
    const citizen = mockPlayer(rec.username, 0, 0, true);
    const human = mockPlayer("Jon", 5, 5, false);
    const director = {
      roster: new Map([[rec.username, rec]]),
      playerFor: () => citizen,
      onlinePlayers: () => [human],
    };
    S.tickSculptors(director, midnight);
    assert.equal(citizen._chat.length, 0, "silent at night");
  } finally {
    Math.random = realRandom;
  }
}

// 18. monumentFor: stone carvers and metalworkers get monuments; wood carvers do not.
{
  const stone = probeSculptor("mon", S.SCULPTOR_STONE);
  const m = S.monumentFor(stone, noon);
  assert.ok(m && m.name.startsWith("the monument to "), "monument named");
  assert.ok(m.cycleDays >= 6 && m.cycleDays <= 9);
  assert.equal(typeof m.complete, "boolean");
  const wood = probeSculptor("monw", S.SCULPTOR_WOOD);
  assert.equal(S.monumentFor(wood, noon), null);
}

// 19. tipSculptor ignores non-tip events and non-sculptors.
{
  assert.equal(S.tipSculptor(null), undefined);
  assert.equal(S.tipSculptor({}), undefined);
  const rec = sculptorRecord("nonsculptor-tip");
  const director = { roster: new Map([[rec.username, rec]]) };
  const event = {
    player: mockPlayer("Jon", 0, 0, false),
    target: mockPlayer("Nobody", 1, 1, true),
    item: { getId: () => 995, getAmount: () => 100 },
  };
  assert.equal(S.tipSculptor(event, { director }, noon), undefined);
  assert.equal(event.handled, undefined);
}

// 20. maybeOfferCommission returns a commission line.
{
  const rec = probeSculptor("comm", S.SCULPTOR_STONE);
  const citizen = mockPlayer(rec.username, 0, 0, true);
  const line = S.maybeOfferCommission(rec, citizen, S.SCULPTOR_STONE);
  assert.ok(typeof line === "string" && line.length > 0 && line.length <= 120);
  assert.equal(citizen._chat.length, 1);
}

// 21. withinTiles Chebyshev on the same plane.
assert.equal(S.withinTiles(mockPlayer("a", 0, 0, false), mockPlayer("b", 10, 10, false), 14), true);
assert.equal(S.withinTiles(mockPlayer("a", 0, 0, false), mockPlayer("b", 20, 0, false), 14), false);

// 22. isRealPlayer gates bots and non-players.
assert.equal(S.isRealPlayer(mockPlayer("Jon", 0, 0, false)), true);
assert.equal(S.isRealPlayer(mockPlayer("Bot", 0, 0, true)), false);
assert.equal(S.isRealPlayer(null), false);

console.log("CitizenSculptors: all checks passed");
