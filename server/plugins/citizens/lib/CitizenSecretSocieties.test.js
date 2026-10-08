// CitizenSecretSocieties unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  societyOf,
  chapterKey,
  agendaLevel,
  meetingActive,
  initiatedSociety,
  isInitiated,
  trustedStanding,
  isRealPlayer,
  withinTiles,
  pickOne,
  fnv1a,
  SOCIETIES,
  _setSky,
  _state,
  tickSocieties,
} = require("./CitizenSecretSocieties");

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function resetState() {
  for (const m of Object.values(_state)) m.clear();
  _setSky(null);
}

// --- hashing ---
assert.equal(typeof fnv1a("test"), "number");
assert.equal(fnv1a("same"), fnv1a("same"), "hash is deterministic");
assert.notEqual(fnv1a("alice"), fnv1a("bob"), "hash differs per name");

// --- society definitions ---
assert.equal(SOCIETIES.length, 3, "three societies");
for (const s of SOCIETIES) {
  assert.ok(s.id && s.name && s.kind && s.agenda, "society has id/name/kind/agenda");
  assert.ok(s.milestones.length >= 3, "society has milestones");
}
const kinds = SOCIETIES.map((s) => s.kind).sort();
assert.deepEqual(kinds, ["economic", "mysterious", "traditionalist"]);

// --- membership: deterministic and stable ---
const a1 = societyOf("Alice", "commoner");
const a2 = societyOf("Alice", "commoner");
assert.equal(a1, a2, "membership stable for same name+role");
assert.equal(societyOf("alice", "commoner"), societyOf("ALICE", "commoner"), "case-insensitive");
assert.equal(societyOf("", "commoner"), null, "empty name -> null");
assert.equal(societyOf(null, "commoner"), null, "null name -> null");
// Roughly MEMBER_PCT of names should be members.
let members = 0;
const N = 2000;
for (let i = 0; i < N; i++) {
  if (societyOf("citizen" + i, "commoner")) members++;
}
const pct = members / N;
assert.ok(pct > 0.08 && pct < 0.25, `membership pct ~15% (got ${(pct * 100).toFixed(1)}%)`);
// All assigned ids are valid.
for (let i = 0; i < N; i++) {
  const sid = societyOf("citizen" + i, "commoner");
  if (sid) assert.ok(SOCIETIES.some((s) => s.id === sid), "valid society id");
}

// --- chapter keys + agenda ---
assert.equal(chapterKey("asgarnia", "gilded-ledger"), "asgarnia:gilded-ledger");
assert.equal(chapterKey(undefined, "shadow-circle"), "wild:shadow-circle");
assert.equal(agendaLevel("asgarnia", "gilded-ledger"), 0, "agenda starts at 0");

// --- trust standings ---
assert.ok(trustedStanding("favorite"), "favorite is trusted");
assert.ok(trustedStanding("regular"), "regular is trusted");
assert.ok(!trustedStanding("neutral"), "neutral is not trusted");
assert.ok(!trustedStanding("warm"), "warm is not trusted enough");
assert.ok(!trustedStanding("cold"), "cold is not trusted");
assert.ok(!trustedStanding("hostile"), "hostile is not trusted");

// --- initiated players ---
resetState();
assert.ok(!isInitiated("SomePlayer"), "not initiated by default");
assert.equal(initiatedSociety("SomePlayer"), null);

// --- meeting active ---
resetState();
assert.ok(!meetingActive("asgarnia", "gilded-ledger", Date.now()), "no meeting by default");

// --- isRealPlayer ---
assert.ok(!isRealPlayer(null));
assert.ok(!isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), "bots excluded");
assert.ok(!isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), "bot host excluded");
assert.ok(isRealPlayer({ getUsername: () => "Jon" }), "real player passes");

// --- withinTiles ---
function ent(x, y, z = 0) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}
assert.ok(withinTiles(ent(0, 0), ent(3, 4), 5), "chebyshev within");
assert.ok(!withinTiles(ent(0, 0), ent(6, 0), 5), "chebyshev outside");
assert.ok(!withinTiles(ent(0, 0, 0), ent(0, 0, 1), 5), "different plane excluded");

// --- pickOne ---
const rng = lcg(42);
assert.ok(["a", "b"].includes(pickOne(rng, ["a", "b"])));

// --- tick: meetings fire at night, agendas advance, journals written ---
resetState();
const journalLogs = [];
// Drive tickSocieties with a fake night sky and a fake director.
// The module calls getJournal() (destructured at load) -> singleton -> .log(),
// so monkey-patching the singleton's log method intercepts journal writes.
const { getJournal } = require("./CitizenJournal");
const realLog = getJournal().log.bind(getJournal());
getJournal().log = (n, k, t, o) => journalLogs.push({ name: n, kind: k, text: t });

_setSky({ getTimeOfDay: () => "night", T: { NIGHT: "night" } });

function mkCitizen(x, y) {
  return {
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    forceChat: function (line) {
      this.said = this.said || [];
      this.said.push(line);
    },
  };
}
function mkPlayer(name, x, y) {
  return {
    getUsername: () => name,
    getHostAddress: () => "1.2.3.4",
    isPlayerBot: () => false,
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
  };
}

// Find member names deterministically.
const memberNames = [];
for (let i = 0; i < 500 && memberNames.length < 6; i++) {
  const n = "socmember" + i;
  if (societyOf(n, "commoner")) memberNames.push(n);
}
assert.ok(memberNames.length >= 3, "found member citizens");

const records = memberNames.map((n, i) => ({
  username: n,
  kingdomId: "asgarnia",
  role: "commoner",
}));
const citizens = new Map(records.map((r) => [r.username, mkCitizen(3000, 3000)]));
const director = {
  roster: new Map(records.map((r) => [r.username, r])),
  playerFor: (r) => citizens.get(r.username),
  onlinePlayers: () => [],
};

const now = Date.now();
tickSocieties(director, now);
assert.ok(journalLogs.length >= 2, `meeting journaled attendees (got ${journalLogs.length})`);
assert.ok(
  journalLogs.every((e) => e.kind === "society"),
  "journal kind is society"
);
const sids = new Set(memberNames.map((n) => societyOf(n, "commoner")));
for (const sid of sids) {
  assert.ok(agendaLevel("asgarnia", sid) > 0, `agenda advanced for ${sid}`);
  assert.ok(meetingActive("asgarnia", sid, now), `meeting active for ${sid}`);
}
// Second tick immediately: no duplicate meeting (interval gate).
const before = journalLogs.length;
tickSocieties(director, now + 1000);
assert.equal(journalLogs.length, before, "no duplicate meeting within interval");

// --- tick: no meeting during day ---
resetState();
journalLogs.length = 0;
_setSky({ getTimeOfDay: () => "day", T: { NIGHT: "night" } });
tickSocieties(director, now);
assert.equal(journalLogs.length, 0, "no meetings during the day");

// --- tick: initiation invite for trusted player ---
resetState();
journalLogs.length = 0;
_setSky({ getTimeOfDay: () => "night", T: { NIGHT: "night" } });
const { getMemory } = require("./CitizenMemory");
const mem = getMemory();
const target = records[0];
const player = mkPlayer("TrustedJon", 3001, 3001);
director.onlinePlayers = () => [player];
// Make standing "regular": record meetings.
mem.recordMeeting(target.username, "TrustedJon", now - 1000);
mem.recordMeeting(target.username, "TrustedJon", now - 2000);
mem.recordMeeting(target.username, "TrustedJon", now - 3000);
assert.ok(
  ["regular", "favorite"].includes(mem.standing(target.username, "TrustedJon", now)),
  "standing is regular+"
);
tickSocieties(director, now);
// Initiation is chance-gated; run several ticks to force it.
let invited = false;
for (let t = 0; t < 40 && !invited; t++) {
  // reset citizen cooldown to re-roll chance
  _state.lastInitiateByCitizen.clear();
  tickSocieties(director, now + t * 61000);
  for (const c of citizens.values()) {
    if (c.said && c.said.length) {
      invited = true;
      break;
    }
  }
}
assert.ok(invited, "trusted player eventually gets an initiation invite");
assert.ok(isInitiated("TrustedJon"), "initiated player recorded");
assert.ok(
  journalLogs.some((e) => e.text.includes("sounded out")),
  "initiation journaled"
);

// Restore journal.
getJournal().log = realLog;
_setSky(null);

console.log("CitizenSecretSocieties: all assertions passed");
