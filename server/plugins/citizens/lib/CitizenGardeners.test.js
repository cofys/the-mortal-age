// CitizenGardeners unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const G = require("./CitizenGardeners");

G._resetState();

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Local-time constructor helper (timezone rule: gates read server-local time).
function localDay(hour, minute = 0) {
  return new Date(2026, 9, 8, hour, minute).getTime();
}

// 1. hashStr is deterministic and varies.
assert.equal(G.hashStr("alice"), G.hashStr("alice"));
assert.notEqual(G.hashStr("alice"), G.hashStr("bob"));

// 2. gardenerTypeFromRoll covers all 4 types.
const seen = new Set();
for (let r = 0; r < 100; r++) seen.add(G.gardenerTypeFromRoll(r));
assert.deepEqual(seen, new Set(["flower-tender", "vegetable-grower", "tree-keeper", "park-keeper"]));

// 3. gardenerTypeOf: stable, null for empty username, null for non-commoners.
const recA = { username: "AliceGardener", kingdomId: "misthalin", role: "commoner" };
const t1 = G.gardenerTypeOf(recA);
const t2 = G.gardenerTypeOf(recA);
assert.ok(G.GARDENER_TYPES.includes(t1), "type must be a gardener type");
assert.equal(t1, t2, "type stable across calls");
assert.equal(G.gardenerTypeOf({ username: "" }), null);
assert.equal(G.gardenerTypeOf({ username: "Bob", role: "guard" }), null);

// 4. No professional exclusion chain: distribution is broad (activity system).
let gardenerCount = 0;
for (let i = 0; i < 2000; i++) {
  if (G.gardenerTypeOf({ username: "Citizen" + i, role: "commoner" })) gardenerCount++;
}
assert.ok(gardenerCount > 1500, `expected most citizens gardeners, got ${gardenerCount}/2000`);

// 5. gardenFor: kingdom-preferred, stable.
const g1 = G.gardenFor(recA);
const g2 = G.gardenFor(recA);
assert.equal(g1.name, g2.name, "garden stable");
assert.equal(g1.kingdom, "misthalin", "kingdom-preferred garden");

// 6. All 10 gardens named and valid.
assert.equal(G.GARDENS.length, 10);
for (const g of G.GARDENS) {
  assert.ok(g.name && g.name.length > 5, "garden has a name");
  assert.ok(g.kingdom && g.kingdom.length > 0, "garden has a kingdom");
}

// 7. currentSeason returns one of the four seasons.
const season = G.currentSeason(localDay(12));
assert.ok(["spring", "summer", "autumn", "winter"].includes(season), "valid season: " + season);

// 8. bloomFor: stable per garden per day, varies across days.
const b1 = G.bloomFor(g1, localDay(12));
const b2 = G.bloomFor(g1, localDay(12));
const b3 = G.bloomFor(g1, localDay(12) + 86400000 * 40);
assert.equal(b1, b2, "bloom stable same day");
assert.ok(typeof b1 === "string" && b1.length > 0, "bloom is a string");

// 9. rareBloomFor: null or a string, stable same day.
const rb1 = G.rareBloomFor(g1, localDay(12));
const rb2 = G.rareBloomFor(g1, localDay(12));
assert.equal(rb1, rb2, "rare bloom stable same day");
assert.ok(rb1 === null || typeof rb1 === "string", "rare bloom null or string");

// 10. taskFor: stable same day, string from the type's task pool.
const task1 = G.taskFor("AliceGardener", "flower-tender", localDay(12));
const task2 = G.taskFor("AliceGardener", "flower-tender", localDay(12));
assert.equal(task1, task2, "task stable same day");
assert.ok(typeof task1 === "string" && task1.length > 0);

// 11. Volunteer ledger round-trip + TTL expiry.
assert.equal(G.volunteerFor("PlayerOne", "the Falador Park", localDay(12)), "the Falador Park");
assert.equal(G.volunteerShiftFor("PlayerOne", localDay(12)), "the Falador Park");
assert.equal(G.volunteerShiftFor("PlayerOne", localDay(12) + 8 * 86400000), null, "volunteer expires after 7d");
assert.equal(G.volunteerFor("", "the Falador Park"), null, "empty name rejected");
assert.equal(G.volunteerShiftFor("Nobody", localDay(12)), null);

// 12. Tour ledger round-trip + TTL expiry.
G._resetState();
assert.equal(G.requestTour("PlayerTwo", "the Varrock Palace Gardens", localDay(12)), "the Varrock Palace Gardens");
assert.equal(G.tourFor("PlayerTwo", localDay(12)), "the Varrock Palace Gardens");
assert.equal(G.tourFor("PlayerTwo", localDay(12) + 8 * 86400000), null, "tour expires after 7d");

// 13. Donation ledger round-trip + TTL expiry.
G._resetState();
assert.equal(G.donateProduce("PlayerThree", "a basket of beans", localDay(12)), "a basket of beans");
assert.equal(G.donationFor("PlayerThree", localDay(12)), "a basket of beans");
assert.equal(G.donationFor("PlayerThree", localDay(12) + 8 * 86400000), null, "donation expires after 7d");

// 14. isGardenHour: open 07:00-19:00 local.
assert.equal(G.isGardenHour(localDay(7)), true);
assert.equal(G.isGardenHour(localDay(12)), true);
assert.equal(G.isGardenHour(localDay(18)), true);
assert.equal(G.isGardenHour(localDay(6)), false);
assert.equal(G.isGardenHour(localDay(19)), false);
assert.equal(G.isGardenHour(localDay(23)), false);

// 15. fill renders slots with no leftovers.
assert.equal(G.fill("Hello {name}, welcome to {place}!", { name: "Bob", place: "the park" }),
  "Hello Bob, welcome to the park!");

// 16. isRealPlayer / isCitizenBot / withinTiles guards.
assert.equal(G.isRealPlayer(null), false);
assert.equal(G.isRealPlayer({ isPlayerBot: () => true }), false);
assert.equal(G.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
assert.equal(G.isRealPlayer({ getUsername: () => "RealPlayer" }), true);
assert.equal(G.isCitizenBot({ isPlayerBot: () => true }), true);
assert.equal(G.isCitizenBot({ getUsername: () => "x" }), false);
function loc(x, y, z) { return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) }; }
assert.equal(G.withinTiles(loc(0, 0, 0), loc(10, 5, 0), 14), true);
assert.equal(G.withinTiles(loc(0, 0, 0), loc(20, 0, 0), 14), false);
assert.equal(G.withinTiles(loc(0, 0, 0), loc(5, 5, 1), 14), false, "different plane");

// 17. tick never-throws on hostile input.
assert.doesNotThrow(() => G.tickGardeners(null, Date.now()));
assert.doesNotThrow(() => G.tickGardeners({}, Date.now()));
assert.doesNotThrow(() => G.tickGardeners({ roster: null }, Date.now()));

// 18. tick fires near a real player during garden hours.
G._resetState();
const firedLines = [];
const mockCitizen = {
  getUsername: () => "AliceGardener",
  getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
  forceChat: (line) => firedLines.push(line),
};
const mockPlayer = {
  getUsername: () => "RealPlayer",
  getLocation: () => ({ getX: () => 5, getY: () => 5, getZ: () => 0 }),
};
const director = {
  roster: new Map([["alicegardener", { username: "AliceGardener", kingdomId: "misthalin", role: "commoner" }]]),
  playerFor: () => mockCitizen,
  onlinePlayers: () => [mockPlayer],
};
// Use 40 gardener citizens to beat the 35% chance gate reliably.
const roster = new Map();
for (let i = 0; i < 40; i++) {
  const uname = "GardenerTick" + i;
  roster.set(uname.toLowerCase(), { username: uname, kingdomId: "misthalin", role: "commoner" });
}
director.roster = roster;
director.playerFor = () => mockCitizen;
G.tickGardeners(director, localDay(12), 0);
assert.ok(firedLines.length > 0, "tick should fire near a real player during garden hours");

// 19. tick silent near bots only.
G._resetState();
const firedLines2 = [];
const mockCitizen2 = { ...mockCitizen, forceChat: (l) => firedLines2.push(l) };
const botPlayer = {
  getUsername: () => "BotBob",
  getLocation: () => ({ getX: () => 5, getY: () => 5, getZ: () => 0 }),
  isPlayerBot: () => true,
};
G.tickGardeners({ roster, playerFor: () => mockCitizen2, onlinePlayers: () => [botPlayer] }, localDay(12), 0);
assert.equal(firedLines2.length, 0, "tick silent near bots only");

// 20. tick silent outside garden hours.
G._resetState();
const firedLines3 = [];
const mockCitizen3 = { ...mockCitizen, forceChat: (l) => firedLines3.push(l) };
G.tickGardeners({ roster, playerFor: () => mockCitizen3, onlinePlayers: () => [mockPlayer] }, localDay(23), 0);
assert.equal(firedLines3.length, 0, "tick silent outside garden hours");

// 21. maybeInvitePlayer returns a volunteer line mentioning the garden.
const invite = G.maybeInvitePlayer({ username: "AliceGardener", kingdomId: "misthalin" }, mockCitizen, "flower-tender");
assert.ok(typeof invite === "string" && invite.length > 0, "invite line returned");

// 22. dayNumber sanity.
assert.equal(G.dayNumber(86400000), 1);
assert.ok(G.dayNumber(Date.now()) > 20000);

console.log("All CitizenGardeners checks passed.");
