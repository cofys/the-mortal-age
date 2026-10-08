// CitizenToasts unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/CitizenToasts.test.js (plain node)
const assert = require("node:assert/strict");

const Toasts = require("./CitizenToasts");
const Hangouts = require("./CitizenHangouts");
const { getJournal } = require("./CitizenJournal");

const NOW = 1790000000000;

function mockPlayer(name, x = 3200, y = 3200) {
  return {
    getUsername: () => name,
    getHostAddress: () => "127.0.0.1",
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
  };
}

function mockBot(name, locals = [], x = 3200, y = 3200) {
  const chats = [];
  return {
    getUsername: () => name,
    getHostAddress: () => "bot",
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    getLocalPlayers: () => locals,
    forceChat: (m) => chats.push(m),
    _chats: chats,
  };
}

function record(name, traits = ["cheerful"]) {
  return {
    username: name,
    personality: { traits },
    role: "commoner",
    kingdomId: "varrock",
  };
}

function hangoutAt(kind, members) {
  return {
    kingdomId: "varrock",
    anchorTile: { x: 3200, y: 3200, z: 0 },
    anchorKind: kind,
    members: members.map((r) => ({ record: r, ringTile: { x: 3201, y: 3200, z: 0 }, arrived: true })),
    ticksLeft: 5,
    lineCooldown: 0,
  };
}

function fresh() {
  getJournal().resetForTests();
  Toasts._resetForTests();
  Toasts._test.setToastChance(1); // deterministic: eligible taverns always roll the toast
  Hangouts._test.active.clear();
}

function stubDirector(botsByName) {
  return {
    getBot: (rec) => botsByName[rec.username] ?? null,
    isOnline: () => true,
    roster: new Map(),
  };
}

// --- isToastable: pure unit checks ---
{
  const ok = { at: NOW, kind: "work", text: "Reached level 60 Woodcutting." };
  assert.ok(Toasts.isToastable(ok, NOW), "fresh level-up is news");
  assert.ok(!Toasts.isToastable({ ...ok, at: NOW - Toasts.TOAST_FRESH_MS - 1 }, NOW), "stale news is not news");
  assert.ok(!Toasts.isToastable({ ...ok, kind: "met" }, NOW), "small-talk kinds are not news");
  assert.ok(!Toasts.isToastable({ ...ok, kind: "social", text: "Raised a toast to Bram at the tavern." }, NOW), "toasts are not re-toastable");
  assert.ok(!Toasts.isToastable({ ...ok, kind: "social", text: 'chatted at the tavern: "hi"' }, NOW), "hangout chatter is not news");
  assert.ok(!Toasts.isToastable(null, NOW), "null event is not news");
}

// --- toast fires when a real player is near ---
{
  fresh();
  const player = mockPlayer("Jon");
  const bram = mockBot("Bram", [player]);
  const sella = mockBot("Sella", [player]);
  const director = stubDirector({ Bram: bram, Sella: sella });
  Hangouts._test.active.set("varrock", hangoutAt("tavern", [record("Bram"), record("Sella", ["gruff"])]));
  getJournal().log("Bram", "work", "Reached level 60 Woodcutting.", { at: NOW - 1000 });

  Toasts.tickToasts(director, NOW);

  const said = [...bram._chats, ...sella._chats];
  assert.equal(said.length, 1, "exactly one toast is raised");
  assert.ok(said[0].includes("Bram"), "toast names the celebrated citizen");
  assert.ok(said[0].includes("reached level 60 Woodcutting"), "toast quotes the highlight");
  assert.ok(said[0].length <= 120, "toast fits overhead chat");
  const logged = getJournal().recent(bram.getUsername(), 5).concat(getJournal().recent("Sella", 5));
  assert.ok(
    logged.some((e) => e.kind === "social" && /^raised a toast/i.test(e.text)),
    "the toast is journaled so the LLM mouth can speak truthfully"
  );
}

// --- two-tier gate: silent when no real player is near ---
{
  fresh();
  const bram = mockBot("Bram", []); // nobody in view
  const director = stubDirector({ Bram: bram });
  Hangouts._test.active.set("varrock", hangoutAt("tavern", [record("Bram")]));
  getJournal().log("Bram", "work", "Reached level 60 Woodcutting.", { at: NOW - 1000 });

  Toasts.tickToasts(director, NOW);
  assert.equal(bram._chats.length, 0, "no toast without a real player in earshot");
}

// --- cooldowns: one toast per tavern per window, one per citizen per window ---
{
  fresh();
  const player = mockPlayer("Jon");
  const bram = mockBot("Bram", [player]);
  const director = stubDirector({ Bram: bram });
  Hangouts._test.active.set("varrock", hangoutAt("tavern", [record("Bram")]));
  getJournal().log("Bram", "work", "Reached level 60 Woodcutting.", { at: NOW - 1000 });
  getJournal().log("Bram", "work", "Finished the fishing haul with 12 shrimps.", { at: NOW - 500 });

  Toasts.tickToasts(director, NOW);
  assert.equal(bram._chats.length, 1, "first toast lands");
  Toasts.tickToasts(director, NOW + 1000);
  assert.equal(bram._chats.length, 1, "hangout cooldown blocks an immediate second toast");

  // Lift the per-hangout cooldown but keep the per-citizen one: still silent,
  // and the watermark must not re-toast the older highlight either.
  Toasts._test.lastToastByHangout.clear();
  Toasts.tickToasts(director, NOW + 2000);
  assert.equal(bram._chats.length, 1, "citizen cooldown + watermark block re-toasts");
}

// --- stale news is never toasted ---
{
  fresh();
  const player = mockPlayer("Jon");
  const bram = mockBot("Bram", [player]);
  const director = stubDirector({ Bram: bram });
  Hangouts._test.active.set("varrock", hangoutAt("tavern", [record("Bram")]));
  getJournal().log("Bram", "work", "Reached level 60 Woodcutting.", { at: NOW - Toasts.TOAST_FRESH_MS - 60000 });

  Toasts.tickToasts(director, NOW);
  assert.equal(bram._chats.length, 0, "stale highlights stay in the journal, unspoken");
}

// --- only taverns raise glasses ---
{
  fresh();
  const player = mockPlayer("Jon");
  const bram = mockBot("Bram", [player]);
  const director = stubDirector({ Bram: bram });
  Hangouts._test.active.set("varrock", hangoutAt("square", [record("Bram")]));
  getJournal().log("Bram", "work", "Reached level 60 Woodcutting.", { at: NOW - 1000 });

  Toasts.tickToasts(director, NOW);
  assert.equal(bram._chats.length, 0, "square hangouts keep their news to themselves");
}

// --- no hangouts, no crash, no toast ---
{
  fresh();
  const director = stubDirector({});
  Toasts.tickToasts(director, NOW);
  Toasts.tickToasts(null, NOW);
}

fresh();
console.log("CitizenToasts.test.js: all assertions passed");
