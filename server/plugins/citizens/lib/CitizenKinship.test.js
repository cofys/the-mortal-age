// CitizenKinship unit checks — pure logic + deterministic event machine.
// From server/plugins/citizens: node lib/CitizenKinship.test.js (plain node)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const K = require("./CitizenKinship");

function fresh() {
  K.resetKinshipForTests();
  return K.getKinship();
}

function rec(username, kingdomId = "asgarnia", traits = ["cheerful"]) {
  return {
    username,
    displayName: username[0].toUpperCase() + username.slice(1),
    kingdomId,
    role: "commoner",
    personality: { traits },
    currentActivityId: "tavern_social",
  };
}

function makeBot(name) {
  const said = [];
  const moved = [];
  return {
    username: name,
    said,
    moved,
    forceChat(l) { said.push(l); },
    moveTo(loc) { moved.push(loc); },
    getLocation() { return { x: 10, y: 10, getDistance: () => 5 }; },
  };
}

function fakeDirector(records, onlineNames) {
  const roster = new Map(records.map((r) => [r.username, r]));
  const bots = new Map();
  for (const n of onlineNames) bots.set(n, makeBot(n));
  return {
    roster,
    api: { core: { Location: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z ?? 0; } } } },
    isOnline: (r) => bots.has(r.username),
    getBot: (r) => bots.get(r.username) ?? null,
    log: () => {},
    _bots: bots,
  };
}

// --- pair keys -------------------------------------------------------------
assert.equal(K.pairKey("bob", "Ann"), "ann|bob", "pair key sorted+normalized");
assert.equal(K.pairKey(" Ann ", "BOB"), "ann|bob", "pair key trims");

// --- trait chemistry ---------------------------------------------------------
assert.ok(
  K.compatScore(["cheerful"], ["cheerful"]) > K.compatScore(["cheerful"], ["gruff"]),
  "shared warm traits beat warm/cold clash"
);
assert.ok(
  K.clashScore(["proud"], ["proud"]) > K.clashScore(["cheerful"], ["easygoing"]),
  "proud+proud clashes harder than cheerful+easygoing"
);
assert.ok(
  K.reconcileMod(["proud"]) < K.reconcileMod(["easygoing"]),
  "proud reconciles slower than easygoing"
);

// --- store basics --------------------------------------------------------------
{
  const s = fresh();
  const r = s.add("ann", "bob", "friend", "friend", "asgarnia");
  assert.ok(r, "add returns record");
  assert.equal(K.getKinship().get("ann", "bob").bond.type, "friend");
  assert.equal(K.getKinship().get("bob", "ann").bond.stage, "friend", "lookup symmetric");
  const of = s.of("ann");
  assert.equal(of.length, 1);
  assert.equal(of[0].other, "bob");
  assert.ok(s.remove("ann", "bob"), "remove true");
  assert.equal(s.get("ann", "bob"), null, "gone after remove");
  assert.equal(s.remove("ann", "bob"), false, "double remove false");
}

// --- constraints -----------------------------------------------------------------
{
  const s = fresh();
  assert.equal(s.add("ann", "ann", "friend", "friend", "asgarnia"), null, "no self bonds");
  assert.equal(s.add("ann", "bob", "friend", "married", "asgarnia"), null, "stage must fit type");
  s.add("ann", "bob", "friend", "friend", "asgarnia");
  assert.equal(s.add("ann", "bob", "feud", "cold", "asgarnia"), null, "no duplicate pair");
  // One romance per citizen — married is for life.
  s.add("ann", "cara", "romance", "courting", "asgarnia");
  assert.equal(s.add("ann", "dave", "romance", "courting", "asgarnia"), null, "ann already courting");
  assert.equal(s.add("cara", "dave", "romance", "courting", "asgarnia"), null, "cara already courting");
  assert.ok(s.add("dave", "erin", "romance", "courting", "asgarnia"), "unattached pair can court");
  // Per-citizen cap.
  const s2 = fresh();
  for (let i = 0; i < 12; i++) s2.add("ann", `pal${i}`, "friend", "friend", "asgarnia");
  assert.equal(s2.add("ann", "pal12", "friend", "friend", "asgarnia"), null, "cap enforced");
}

// --- stages & queries ----------------------------------------------------------------
{
  const s = fresh();
  s.add("ann", "bob", "friend", "friend", "asgarnia");
  assert.ok(s.setStage("ann", "bob", "close"), "friend -> close");
  assert.equal(s.get("ann", "bob").bond.stage, "close");
  assert.ok(!s.setStage("ann", "bob", "married"), "friend can't become married");
  assert.equal(K.spouseOf("ann"), null, "no spouse yet");
  s.add("ann", "cara", "romance", "courting", "asgarnia");
  assert.deepEqual(K.partnerOf("ann"), { other: "cara", stage: "courting" });
  s.setStage("ann", "cara", "married");
  assert.equal(K.spouseOf("ann"), "cara");
  assert.equal(K.isOpenFeud("ann", "bob"), false);
  s.add("bob", "dave", "feud", "cold", "asgarnia");
  assert.equal(K.isOpenFeud("bob", "dave"), false, "cold isn't open");
  s.setStage("bob", "dave", "open");
  assert.equal(K.isOpenFeud("bob", "dave"), true);
}

// --- kinSummary (chat context) ---------------------------------------------------------
{
  fresh();
  const s = K.getKinship();
  s.add("ann", "cara", "romance", "courting", "asgarnia");
  s.add("ann", "bob", "friend", "close", "asgarnia");
  s.add("ann", "dave", "feud", "open", "asgarnia");
  const roster = new Map([
    ["ann", rec("ann")], ["cara", rec("cara")],
    ["bob", rec("bob")], ["dave", rec("dave")],
  ]);
  const line = K.kinSummary("ann", roster);
  assert.ok(line.includes("courting Cara"), `courting line, got: ${line}`);
  assert.ok(line.includes("close friends with Bob"), `close line, got: ${line}`);
  assert.ok(line.includes("feuding with Dave"), `feud line, got: ${line}`);
  s.setStage("ann", "cara", "married");
  assert.ok(K.kinSummary("ann", roster).includes("married to Cara"), "married line");
  assert.equal(K.kinSummary("zed", roster), "", "stranger gets nothing");
}

// --- persistence round-trip ----------------------------------------------------------------
{
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kin-")), "citizen-kin.json");
  const s1 = new K.CitizenKinshipStore();
  s1._savePath = tmp;
  s1.add("ann", "bob", "romance", "serious", "asgarnia");
  s1.get("ann", "bob").bond.data.event = { type: "wedding", phase: "announced", at: 123 };
  assert.ok(s1.saveIfDirty(), "saved");
  const s2 = new K.CitizenKinshipStore();
  s2._savePath = tmp;
  const loaded = s2.get("ann", "bob");
  assert.ok(loaded, "bond survived round-trip");
  assert.equal(loaded.bond.stage, "serious");
  assert.equal(loaded.bond.data.event.phase, "announced", "event state survived");
  assert.equal(s2.saveIfDirty(), false, "clean store doesn't rewrite");
}

// --- wedding machine: announced -> gather -> vows -> cheers -> married -------------------------
{
  fresh();
  const s = K.getKinship();
  const now = Date.now();
  const a = rec("ann");
  const b = rec("bob");
  s.add("ann", "bob", "romance", "serious", "asgarnia", now - 10 * 24 * 3600 * 1000);
  s.get("ann", "bob").bond.data.event = { type: "wedding", phase: "announced", at: now - 21 * 3600 * 1000 };
  const d = fakeDirector([a, b], ["ann", "bob"]);

  K.tickKinship(d, 12, now);
  let ev = s.get("ann", "bob").bond.data.event;
  assert.equal(ev.phase, "gather", "announced -> gather when both online");
  assert.equal(d._bots.get("ann").moved.length, 1, "bride moved to square");
  assert.equal(d._bots.get("bob").moved.length, 1, "groom moved to square");
  assert.ok(d._bots.get("ann").said.join(" ").includes("wedding of"), "announcement spoken");

  K.tickKinship(d, 12, now + 61 * 1000);
  ev = s.get("ann", "bob").bond.data.event;
  assert.equal(ev.phase, "vows", "gather -> vows");
  assert.ok(d._bots.get("ann").said.length >= 2, "vow spoken");

  K.tickKinship(d, 12, now + 122 * 1000);
  ev = s.get("ann", "bob").bond.data.event;
  assert.equal(ev.phase, "cheers", "vows -> cheers");

  K.tickKinship(d, 12, now + 183 * 1000);
  ev = s.get("ann", "bob").bond.data.event;
  assert.equal(ev.phase, "done", "cheers -> done");
  assert.equal(s.get("ann", "bob").bond.stage, "married", "now married");
  assert.equal(K.spouseOf("ann"), "bob");
}

// --- wedding machine: quiet marriage when a partner is away too long ------------------------------
{
  fresh();
  const s = K.getKinship();
  const now = Date.now();
  s.add("ann", "bob", "romance", "serious", "asgarnia", now - 10 * 24 * 3600 * 1000);
  s.get("ann", "bob").bond.data.event = { type: "wedding", phase: "announced", at: now - 80 * 3600 * 1000 };
  const d = fakeDirector([rec("ann"), rec("bob")], ["ann"]); // bob offline
  K.tickKinship(d, 12, now);
  const bond = s.get("ann", "bob").bond;
  assert.equal(bond.stage, "married", "married quietly after long wait");
  assert.equal(bond.data.event.quiet, true);
}

// --- feud arguments: public shouting match, then cooldown ----------------------------------------------
{
  fresh();
  const s = K.getKinship();
  const now = Date.now();
  s.add("ann", "bob", "feud", "open", "asgarnia", now - 5 * 24 * 3600 * 1000);
  const d = fakeDirector([rec("ann", "asgarnia", ["gruff"]), rec("bob", "asgarnia", ["proud"])], ["ann", "bob"]);
  K.tickKinship(d, 12, now);
  const said = [...d._bots.get("ann").said, ...d._bots.get("bob").said];
  assert.ok(said.length > 0, "argument spoken aloud");
  assert.ok(s.get("ann", "bob").bond.data.lastArgueAt > 0, "cooldown stamped");
  const before = said.length;
  K.tickKinship(d, 12, now + 61 * 1000);
  const after = [...d._bots.get("ann").said, ...d._bots.get("bob").said].length;
  assert.equal(after, before, "cooldown suppresses repeat shouting");
}

// --- pruning: bonds to citizens who left the roster ------------------------------------------------------
{
  fresh();
  const s = K.getKinship();
  s.add("ann", "zed", "friend", "friend", "asgarnia");
  const d = fakeDirector([rec("ann")], ["ann"]);
  K.tickKinship(d, 12, Date.now());
  assert.equal(s.get("ann", "zed"), null, "dead bond pruned");
}

// --- formation smoke: runs clean, never crosses kingdoms ---------------------------------------------------
{
  fresh();
  const citizens = [];
  for (let i = 0; i < 8; i++) citizens.push(rec(`a${i}`, "asgarnia"));
  for (let i = 0; i < 8; i++) citizens.push(rec(`m${i}`, "misthalin"));
  const d = fakeDirector(citizens, []);
  for (let t = 0; t < 5; t++) K.tickKinship(d, 12, Date.now() + t * 61 * 1000);
  for (const { a, b } of K.getKinship().bonds.values()) {
    const ra = d.roster.get(a);
    const rb = d.roster.get(b);
    assert.equal(ra.kingdomId, rb.kingdomId, "no cross-kingdom bonds");
  }
}

console.log("CitizenKinship: all checks passed");
