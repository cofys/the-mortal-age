// CitizenHomeLife unit checks — tick dynamics with stubbed director/bots.
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Homes = require("./CitizenHomes");
const { tickHomes, COINS } = require("./CitizenHomeLife");
const Bonds = require("./CitizenBonds");

let passed = 0;
function check(name, fn) {
  Homes.resetForTests();
  Homes._setSavePathForTests(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "homelife-")), "homes.json"));
  Bonds.resetForTests?.();
  fn();
  passed++;
  console.log("ok - " + name);
}

function rec(username, role = "commoner", kingdomId = "asgarnia") {
  return {
    username,
    displayName: username,
    role,
    kingdomId,
    personality: { traits: [] },
    home: { x: 3200, y: 3200, z: 0 },
  };
}

// Minimal fake bot: inventory with real coin accounting, silent speech.
function fakeBot(coins) {
  let pouch = coins;
  return {
    _coins: () => pouch,
    getInventory: () => ({
      getAmount: (id) => (id === COINS ? pouch : 0),
      deleted: (id, amount) => {
        if (id === COINS && pouch >= amount) pouch -= amount;
      },
    }),
    forceChat: () => {},
    getLocalPlayers: () => [],
  };
}

function fakeDirector(records, botsByName = {}) {
  const roster = new Map();
  for (const r of records) roster.set(r.username.toLowerCase(), r);
  return {
    roster,
    getBot: (record) => {
      if (!record) return null;
      return botsByName[record.username.toLowerCase()] ?? null;
    },
    log: () => {},
  };
}

// --- assignment ---------------------------------------------------------------

check("tickHomes assigns homes sized by role and points spawn anchor at home", () => {
  const records = [rec("Alice"), rec("Bob", "merchant"), rec("Cara", "courtier")];
  const d = fakeDirector(records);
  tickHomes(d, Date.now());
  const alice = Homes.homeOf("Alice");
  const bob = Homes.homeOf("Bob");
  const cara = Homes.homeOf("Cara");
  assert.ok(alice && bob && cara, "everyone housed");
  assert.equal(alice.size, Homes.SIZE_COTTAGE);
  assert.equal(bob.size, Homes.SIZE_HOUSE);
  assert.equal(cara.size, Homes.SIZE_MANOR);
  assert.deepEqual(records[0].home, { x: alice.tile.x, y: alice.tile.y, z: alice.tile.z });
});

check("tickHomes does not rehouse citizens who already have homes", () => {
  const records = [rec("Dave")];
  const d = fakeDirector(records);
  tickHomes(d, Date.now());
  const first = Homes.homeOf("Dave");
  tickHomes(d, Date.now());
  assert.equal(Homes.homeOf("Dave")?.id, first.id);
  assert.equal(Homes.homeCount(), 1);
});

check("tickHomes is a no-op without a director roster", () => {
  tickHomes(null, Date.now());
  tickHomes({}, Date.now());
  assert.equal(Homes.homeCount(), 0);
});

// --- rent ---------------------------------------------------------------------

check("online owner pays rent from real coins", () => {
  const records = [rec("Erin")];
  const bot = fakeBot(5000);
  const d = fakeDirector(records, { erin: bot });
  tickHomes(d, Date.now());
  const home = Homes.homeOf("Erin");
  home.rentDueAt = Date.now() - 1; // force due
  const before = bot._coins();
  tickHomes(d, Date.now());
  assert.ok(bot._coins() < before, "coins were taken");
  assert.equal(before - bot._coins(), home.rentPerDay, "exact rent deducted");
  assert.equal(home.rentDebt, 0);
  assert.ok(home.rentDueAt > Date.now(), "clock reset");
});

check("broke owner accrues debt; four missed days evicts", () => {
  const records = [rec("Finn")];
  const bot = fakeBot(10); // can't afford 50
  const d = fakeDirector(records, { finn: bot });
  tickHomes(d, Date.now());
  const home = Homes.homeOf("Finn");
  for (let day = 0; day < 3; day++) {
    home.rentDueAt = Date.now() - 1;
    tickHomes(d, Date.now());
    assert.ok(Homes.homeOf("Finn"), `still housed after ${day + 1} missed days`);
  }
  assert.ok(home.rentDebt > 0, "debt accrued");
  home.rentDueAt = Date.now() - 1;
  tickHomes(d, Date.now());
  assert.equal(Homes.homeOf("Finn"), null, "evicted on the 4th missed day");
  assert.ok(records[0].home, "spawn anchor still set (fell back to market)");
});

check("offline owner accrues debt without crashing", () => {
  const records = [rec("Gus")];
  const d = fakeDirector(records, {}); // nobody online
  tickHomes(d, Date.now());
  const home = Homes.homeOf("Gus");
  home.rentDueAt = Date.now() - 1;
  tickHomes(d, Date.now());
  assert.ok(home.rentDebt > 0, "debt accrued while offline");
});

// --- furnishing -----------------------------------------------------------------

check("wealthy owner buys furniture with real coins", () => {
  const records = [rec("Hana")];
  const bot = fakeBot(1000000); // plenty of rent buffer for the long soak
  const d = fakeDirector(records, { hana: bot });
  tickHomes(d, Date.now());
  const home = Homes.homeOf("Hana");
  const before = bot._coins();
  // Step past the rng seed bucket (2^18 ms) each iteration so every tick
  // draws fresh; 400 ticks at p=0.03 all but guarantees a purchase.
  let t = Date.now();
  for (let i = 0; i < 400 && home.furnishings.length === 0; i++) {
    t += 270000;
    tickHomes(d, t);
  }
  assert.ok(home.furnishings.length > 0, "bought at least one furnishing");
  assert.ok(bot._coins() < before, "coins were spent");
  assert.ok(Homes.homeOf("Hana"), "still housed (rent stayed paid)");
});

// --- gatherings -------------------------------------------------------------------

check("gatherings invite online friends as guests", () => {
  const records = [rec("Ivy"), rec("Jack"), rec("Kim")];
  const d = fakeDirector(records, { ivy: fakeBot(5000), jack: fakeBot(100), kim: fakeBot(100) });
  // Ivy befriends Jack and Kim in the bonds graph.
  try {
    Bonds.bonds("Ivy").friends.push("jack", "kim");
  } catch {
    // If the bonds API differs, the gathering simply won't fire — still valid.
  }
  tickHomes(d, Date.now());
  const home = Homes.homeOf("Ivy");
  // Step past the rng seed bucket each iteration so every tick draws fresh.
  let t = Date.now();
  for (let i = 0; i < 400 && home.guests.length === 0; i++) {
    t += 270000;
    tickHomes(d, t);
  }
  assert.ok(home.guests.length > 0, "online friends were invited over");
  assert.ok(
    home.guests.every((g) => g.until > t),
    "invitations carry an expiry"
  );
});

console.log(`\n${passed} checks passed.`);
