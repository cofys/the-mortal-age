"use strict";

// CitizenNewspaper unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  editionDue, editionIdFor, hash32, crierFor, headlineFor, gossipItemFor,
  compileEdition, crierShoutLine, shouldShout, isRealPlayer, withinTiles,
  paperName, EDITION_INTERVAL_MS, _resetForTests,
} = require("./CitizenNewspaper");

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

_resetForTests();

assert.equal(editionDue(0, 1000), true, "first edition always due");
assert.equal(editionDue(1000, 1000 + 3600 * 1000), false, "not due within the week");
assert.equal(editionDue(1000, 1000 + EDITION_INTERVAL_MS + 1), true, "due after a week");
assert.match(editionIdFor(Date.UTC(2026, 9, 7, 12)), /^\d{4}-\d{2}-\d{2}$/, "edition id is YYYY-MM-DD");
assert.equal(hash32("asgarnia:2026-10-07"), hash32("asgarnia:2026-10-07"), "hash stable");
assert.notEqual(hash32("asgarnia:x"), hash32("kandarin:x"), "hash differs per kingdom");

const roster = [
  { username: "alice", kingdom: "asgarnia", role: "commoner" },
  { username: "bob", kingdom: "asgarnia", role: "merchant" },
  { username: "cara", kingdom: "asgarnia", role: "guard" },
  { username: "dave", kingdom: "kandarin", role: "commoner" },
];
const c1 = crierFor("asgarnia", roster, "2026-10-07");
assert.equal(c1.username, crierFor("asgarnia", roster, "2026-10-07").username, "crier stable within week");
assert.ok(["alice", "bob"].includes(crierFor("asgarnia", roster, "2026-10-14").username), "crier is commoner/merchant");
assert.equal(crierFor("kandarin", roster, "2026-10-07").username, "dave", "per-kingdom crier");
assert.equal(crierFor("asgarnia", [], "2026-10-07"), null, "no crier without citizens");

const h1 = headlineFor({ kind: "quest", text: "cleared the catacombs", display: "Alice" });
assert.ok(h1.includes("Alice") && h1.includes("catacombs"), "quest headline");
assert.equal(headlineFor({ kind: "rested", text: "nap", display: "Bob" }), null, "rest is not news");
assert.equal(headlineFor({ kind: "kill", text: "", display: "Bob" }), null, "empty text not news");
assert.equal(gossipItemFor({ text: "baker hides gold" }), "baker hides gold", "gossip passthrough");
assert.equal(gossipItemFor(null), null, "null rumor -> null");

const edition = compileEdition(
  {
    journalEvents: [
      { kind: "quest", text: "saved the mill", display: "Alice", at: Date.now() },
      { kind: "kill", text: "a hill giant", display: "Bob", at: Date.now() },
    ],
    rumors: [{ text: "the baker hides gold" }],
    announcements: [{ text: "Harvest Home begins soon" }],
    retired: [{ display: "Elder Mara", role: "merchant" }],
  },
  "asgarnia", Date.UTC(2026, 9, 7, 12)
);
assert.equal(edition.paper, "The Falador Herald", "kingdom paper name");
assert.equal(edition.headlines.length, 2, "two headlines");
assert.equal(edition.gossip.length, 1, "one gossip");
assert.equal(edition.announcements.length, 1, "one announcement");
assert.ok(edition.obituaries[0].includes("Elder Mara"), "obituary names elder");

const quiet = compileEdition({}, "misthalin", Date.UTC(2026, 9, 7, 12));
assert.ok(quiet.headlines[0].toLowerCase().includes("quiet week"), "quiet-week fallback");

const capped = compileEdition({
  journalEvents: Array.from({ length: 20 }, (_, i) => ({ kind: "quest", text: `deed ${i}`, display: "X", at: Date.now() })),
}, "asgarnia", Date.now());
assert.ok(capped.headlines.length <= 5, "headlines capped");

const shout = crierShoutLine(lcg(42), edition);
assert.ok(shout.includes(edition.paper), "shout names paper");
assert.ok(shout.includes(edition.headlines[0].slice(0, 20)), "shout carries headline");

const now = Date.now();
assert.equal(shouldShout(lcg(1), now - 1000, now), false, "cooldown blocks");
assert.equal(shouldShout(() => 0.0, 0, now), true, "fires when due");
assert.equal(shouldShout(() => 0.99999, 0, now), false, "chance can block");

assert.equal(isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false, "bot rejected");
assert.equal(isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false, "bot host rejected");
assert.equal(isRealPlayer({ isPlayerBot: () => false, getHostAddress: () => "1.2.3.4", getUsername: () => "Jon" }), true, "human accepted");

const at = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
assert.equal(withinTiles(at(0, 0, 0), at(10, 5, 0), 14), true, "in range");
assert.equal(withinTiles(at(0, 0, 0), at(30, 0, 0), 14), false, "out of range");
assert.equal(withinTiles(at(0, 0, 0), at(5, 5, 1), 14), false, "different plane");
assert.equal(paperName("nonsense"), "The Realm Reporter", "fallback paper");

console.log("CitizenNewspaper: 28/28 assertions passed");
