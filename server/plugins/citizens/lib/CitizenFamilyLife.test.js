// CitizenFamilyLife unit checks — tick dynamics with stubbed engine deps.
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// Stub sayPublic to capture speech.
const sayPath = require.resolve("../chat/CitizenSayPublic");
const said = [];
require.cache[sayPath] = {
  exports: { sayPublic: (bot, text) => { said.push(String(text)); return true; } },
};

// Stub CitizenKinship.spouseOf — marriages are test-controlled.
const kinPath = require.resolve("./CitizenKinship");
const marriages = new Map(); // normalized name -> spouse name
require.cache[kinPath] = {
  exports: {
    spouseOf: (name) => marriages.get(String(name ?? "").toLowerCase().trim()) ?? null,
  },
};

// Stub CitizenSkilling.skillStore.
const skillPath = require.resolve("./CitizenSkilling");
const skillXp = new Map(); // "name|skill" -> xp
require.cache[skillPath] = {
  exports: {
    skillStore: {
      xp: {
        get: (name) => {
          const out = {};
          for (const [k, v] of skillXp) {
            const [n, s] = k.split("|");
            if (n === name) out[s] = v;
          }
          return Object.keys(out).length ? out : undefined;
        },
      },
      getLevel: (name, skill) => Math.floor((skillXp.get(`${String(name).toLowerCase()}|${skill}`) ?? 0) / 100),
      addXp: (name, skill, amount) => {
        const k = `${String(name).toLowerCase()}|${skill}`;
        skillXp.set(k, (skillXp.get(k) ?? 0) + amount);
        return { leveled: false, level: 0 };
      },
    },
  },
};

// Stub CitizenSites.siteTileByKingdom.
const sitesPath = require.resolve("../brain/CitizenSites");
require.cache[sitesPath] = {
  exports: { siteTileByKingdom: (kingdomId, kind) => ({ x: 3200, y: 3200, z: 0 }) },
};

// Stub CitizenNeeds.
const needsPath = require.resolve("../brain/CitizenNeeds");
require.cache[needsPath] = {
  exports: {
    ensureNeeds: () => {},
    needsSnapshot: () => ({ hp: 99 }),
  },
};

const Families = require("./CitizenFamilies");
const Life = require("./CitizenFamilyLife");

const DAY_MS = 24 * 3600 * 1000;
const always = () => 0; // rng: every chance() passes
const never = () => 0.999999; // rng: every chance() fails

let passed = 0;
function check(name, fn) {
  Families.resetForTests();
  Life.resetForTests();
  marriages.clear();
  skillXp.clear();
  said.length = 0;
  // Redirect family + home saves to tmp so tests never touch the real ones.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "famlife-"));
  Families._setSavePathForTests(path.join(dir, "families.json"));
  const Homes = require("./CitizenHomes");
  Homes._setSavePathForTests(path.join(dir, "homes.json"));
  Homes.resetForTests();
  fn();
  passed++;
  console.log("ok - " + name);
}

function rec(username, role = "commoner", kingdomId = "varrock", traits = []) {
  return {
    username,
    displayName: username,
    role,
    kingdomId,
    home: { x: 3200, y: 3200, z: 0 },
    personality: { name: username, traits },
  };
}

function directorWith(...records) {
  const roster = new Map();
  for (const r of records) roster.set(r.username.toLowerCase(), r);
  return {
    roster,
    usedNames: new Set(records.map((r) => r.username)),
    getBot: () => null,
    findWalkableHome: (anchor) => ({ x: anchor.x + 1, y: anchor.y + 1, z: 0 }),
    log: () => {},
  };
}

function marry(a, b) {
  marriages.set(a.toLowerCase(), b);
  marriages.set(b.toLowerCase(), a);
}

// --- formation ---------------------------------------------------------------

check("formFamilies: married couple gets a family", () => {
  const d = directorWith(rec("Alice Stone"), rec("Bob Stone"));
  marry("Alice Stone", "Bob Stone");
  const formed = Life.formFamilies(d, Date.now());
  assert.equal(formed, 1);
  const f = Families.familyOf("alice stone");
  assert.ok(f);
  assert.equal(f.surname, "Stone");
});

check("formFamilies: skips when already familied or unmarried", () => {
  const d = directorWith(rec("Alice Stone"), rec("Bob Stone"), rec("Cara Vale"));
  marry("Alice Stone", "Bob Stone");
  assert.equal(Life.formFamilies(d, Date.now()), 1);
  assert.equal(Life.formFamilies(d, Date.now()), 0); // idempotent
});

// --- births ------------------------------------------------------------------

check("maybeBirth: eligible family has a child with always-rng", () => {
  const d = directorWith(rec("Alice Stone"), rec("Bob Stone"));
  marry("Alice Stone", "Bob Stone");
  Life.formFamilies(d, Date.now());
  const f = Families.familyOf("alice stone");
  const child = Life.maybeBirth(d, f, d.roster.get("alice stone"), d.roster.get("bob stone"), always, Date.now());
  assert.ok(child);
  assert.equal(child.surname, "Stone");
  assert.deepEqual(child.parents, ["alice stone", "bob stone"]);
  assert.ok(child.traits.length <= 2);
});

check("maybeBirth: never-rng means no birth; caps enforced", () => {
  const d = directorWith(rec("Alice Stone"), rec("Bob Stone"));
  marry("Alice Stone", "Bob Stone");
  Life.formFamilies(d, Date.now());
  const f = Families.familyOf("alice stone");
  const none = Life.maybeBirth(d, f, d.roster.get("alice stone"), d.roster.get("bob stone"), never, Date.now());
  assert.equal(none, null);
  // Fill to cap, then even always-rng refuses.
  for (let i = 0; i < Families.MAX_CHILDREN_PER_FAMILY; i++) {
    Families.recordBirth(f.id, `Kid${i}`, [], Date.now());
  }
  const capped = Life.maybeBirth(d, f, d.roster.get("alice stone"), d.roster.get("bob stone"), always, Date.now());
  assert.equal(capped, null);
});

// --- aging -------------------------------------------------------------------

check("tickAging: children advance stages and coming-of-age is journaled", () => {
  const d = directorWith(rec("Alice Stone"), rec("Bob Stone"));
  marry("Alice Stone", "Bob Stone");
  Life.formFamilies(d, Date.now());
  const f = Families.familyOf("alice stone");
  const now = Date.now();
  const teen = Families.recordBirth(f.id, "Mara", [], now - 30 * DAY_MS);
  Families.refreshStage(teen, now);
  assert.equal(teen.stage, Families.STAGE_TEEN);
  // Age to adult.
  teen.bornAt = now - 40 * DAY_MS;
  Life.tickAging(d, always, now);
  assert.equal(teen.stage, Families.STAGE_ADULT);
});

// --- coming of age → roster ----------------------------------------------------

check("tickComingOfAge: adult child joins roster with identity intact", () => {
  const d = directorWith(rec("Alice Stone"), rec("Bob Stone"));
  marry("Alice Stone", "Bob Stone");
  Life.formFamilies(d, Date.now());
  const f = Families.familyOf("alice stone");
  const now = Date.now();
  const grown = Families.recordBirth(f.id, "Mara", ["kind", "brave"], now - 40 * DAY_MS);
  Families.refreshStage(grown, now);
  Families.addLearnedXp(grown.id, "woodcutting", 250);
  Life.tickComingOfAge(d, never, now);
  const joined = d.roster.get("mara stone");
  assert.ok(joined, "grown child is in the roster");
  assert.equal(joined.username, "Mara Stone");
  assert.equal(joined.kingdomId, "varrock");
  assert.deepEqual(joined.personality.traits, ["kind", "brave"]);
  assert.deepEqual(joined.grownChildOf, ["alice stone", "bob stone"]);
  assert.equal(Families.getChild(grown.id).joinedRoster, true);
  // Learned XP converted to real skill XP.
  assert.equal(skillXp.get("mara stone|woodcutting"), 250);
});

check("tickComingOfAge: no room means no join (waits, doesn't crash)", () => {
  const records = [rec("Alice Stone"), rec("Bob Stone")];
  for (let i = 0; i < 120; i++) records.push(rec(`Filler ${i}`));
  const d = directorWith(...records);
  marry("Alice Stone", "Bob Stone");
  Life.formFamilies(d, Date.now());
  const f = Families.familyOf("alice stone");
  const now = Date.now();
  const grown = Families.recordBirth(f.id, "Mara", [], now - 40 * DAY_MS);
  Families.refreshStage(grown, now);
  Life.tickComingOfAge(d, never, now);
  assert.equal(d.roster.has("mara stone"), false);
  assert.equal(Families.getChild(grown.id).joinedRoster, false);
});

// --- teaching ------------------------------------------------------------------

check("tickTeaching: minor children bank learnedXp from a parent's best skill", () => {
  const d = directorWith(rec("Alice Stone"), rec("Bob Stone"));
  marry("Alice Stone", "Bob Stone");
  skillXp.set("alice stone|woodcutting", 600); // level 6
  Life.formFamilies(d, Date.now());
  const f = Families.familyOf("alice stone");
  const kid = Families.recordBirth(f.id, "Mara", [], Date.now() - 10 * DAY_MS);
  Families.refreshStage(kid, Date.now());
  Life.tickTeaching(d, always);
  const learned = Families.getChild(kid.id).learnedXp;
  assert.ok((learned.woodcutting ?? 0) > 0, "child learned woodcutting");
});

// --- inheritance ---------------------------------------------------------------

check("tickInheritance: vanished family member triggers home transfer", () => {
  const Homes = require("./CitizenHomes");
  const d = directorWith(rec("Alice Stone"), rec("Bob Stone"));
  marry("Alice Stone", "Bob Stone");
  Life.formFamilies(d, Date.now());
  // Alice owns a home.
  const home = Homes.createHome("Alice Stone", "Alice Stone", "varrock", Homes.SIZE_HOUSE);
  assert.ok(home);
  // First tick seeds knownAlive; then Alice vanishes (permanent death).
  Life.tickInheritance(d, Date.now());
  d.roster.delete("alice stone");
  Life.tickInheritance(d, Date.now());
  const after = Homes.getHome(home.id);
  assert.equal(after.owner, "bob stone", "home transferred to spouse");
});

check("tickInheritance: restart doesn't false-fire (seeds from current roster)", () => {
  const Homes = require("./CitizenHomes");
  const d = directorWith(rec("Bob Stone")); // Alice already gone at boot
  marry("Alice Stone", "Bob Stone");
  const f = Families.createFamily("Alice Stone", "Alice Stone", "Bob Stone", "Bob Stone", "varrock");
  const home = Homes.createHome("Alice Stone", "Alice Stone", "varrock", Homes.SIZE_HOUSE);
  Life.tickInheritance(d, Date.now()); // seeds knownAlive = {bob stone}
  const after = Homes.getHome(home.id);
  assert.equal(after.owner, "alice stone", "no false inheritance on first tick");
  void f;
});

check("handleInheritance: spouse-less parent passes home to eldest child", () => {
  const Homes = require("./CitizenHomes");
  const d = directorWith(rec("Alice Stone"), rec("Bob Stone"));
  marry("Alice Stone", "Bob Stone");
  Life.formFamilies(d, Date.now());
  const f = Families.familyOf("alice stone");
  const now = Date.now();
  // Grown child joins the roster first.
  const grown = Families.recordBirth(f.id, "Mara", [], now - 40 * DAY_MS);
  Families.refreshStage(grown, now);
  Life.tickComingOfAge(d, never, now);
  assert.ok(d.roster.has("mara stone"));
  // Bob dies with no spouse in the picture (Alice already gone).
  d.roster.delete("alice stone");
  const home = Homes.createHome("Bob Stone", "Bob Stone", "varrock", Homes.SIZE_HOUSE);
  const done = Life.handleInheritance(d, "bob stone", rec("Bob Stone"), now);
  assert.equal(done, true);
  assert.equal(Homes.getHome(home.id).owner, "mara stone");
});

// --- bequest flush ----------------------------------------------------------------

check("tickBequestFlush: owed coins land in the heir's real inventory", () => {
  const d = directorWith(rec("Alice Stone"), rec("Bob Stone"));
  marry("Alice Stone", "Bob Stone");
  Life.formFamilies(d, Date.now());
  const f = Families.familyOf("alice stone");
  const now = Date.now();
  const grown = Families.recordBirth(f.id, "Mara", [], now - 40 * DAY_MS);
  Families.refreshStage(grown, now);
  Families.addBequest(grown.id, 500);
  Life.tickComingOfAge(d, never, now);
  // Materialize Mara with a fake inventory.
  let coins = 0;
  const bot = {
    getInventory: () => ({
      add: (id, amt) => { if (id === 995) coins += amt; },
      getAmount: () => coins,
    }),
  };
  d.getBot = () => bot;
  Life.tickBequestFlush(d);
  assert.equal(coins, 500);
  assert.equal(Families.getChild(grown.id).bequest, 0);
});

console.log(`\n${passed} checks passed`);
