// CitizenHomes unit checks — pure data logic, no running server.
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Homes = require("./CitizenHomes");

let passed = 0;
function check(name, fn) {
  Homes.resetForTests();
  Homes._setSavePathForTests(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "homes-")), "homes.json"));
  fn();
  passed++;
  console.log("ok - " + name);
}

// --- sizes --------------------------------------------------------------------

check("sizeForRole derives size from role", () => {
  assert.equal(Homes.sizeForRole("courtier"), Homes.SIZE_MANOR);
  assert.equal(Homes.sizeForRole("merchant"), Homes.SIZE_HOUSE);
  assert.equal(Homes.sizeForRole("guard"), Homes.SIZE_HOUSE);
  assert.equal(Homes.sizeForRole("commoner"), Homes.SIZE_COTTAGE);
  assert.equal(Homes.sizeForRole("refugee"), Homes.SIZE_COTTAGE);
  assert.equal(Homes.sizeForRole(null), Homes.SIZE_COTTAGE);
});

// --- plots --------------------------------------------------------------------

check("plotFor is deterministic and never stacks", () => {
  const a = Homes.plotFor("asgarnia", 1);
  const b = Homes.plotFor("asgarnia", 1);
  const c = Homes.plotFor("asgarnia", 2);
  assert.deepEqual(a, b);
  assert.ok(a.x !== c.x || a.y !== c.y, "adjacent plots differ");
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const p = Homes.plotFor("asgarnia", i);
    const k = `${p.x},${p.y}`;
    assert.ok(!seen.has(k), `plot ${i} collides`);
    seen.add(k);
  }
});

// --- creation -------------------------------------------------------------------

check("createHome assigns a home with a real plot", () => {
  const home = Homes.createHome("Alice Smith", "Alice Smith", "asgarnia", Homes.SIZE_COTTAGE);
  assert.ok(home);
  assert.equal(home.owner, "alice smith");
  assert.equal(home.size, Homes.SIZE_COTTAGE);
  assert.ok(Number.isFinite(home.tile.x) && Number.isFinite(home.tile.y));
  assert.equal(Homes.homeOf("Alice Smith")?.id, home.id);
  assert.equal(Homes.homeOf("alice smith")?.id, home.id); // normalized
  assert.deepEqual(Homes.homeTile("Alice Smith"), { x: home.tile.x, y: home.tile.y, z: home.tile.z });
});

check("createHome enforces one home per citizen", () => {
  const a = Homes.createHome("Bob Jones", "Bob Jones", "asgarnia");
  assert.ok(a);
  const b = Homes.createHome("Bob Jones", "Bob Jones", "asgarnia");
  assert.equal(b, null);
});

check("createHome caps homes per kingdom", () => {
  for (let i = 0; i < Homes.MAX_HOMES_PER_KINGDOM; i++) {
    const h = Homes.createHome(`Owner${i}`, `Owner${i}`, "kandarin");
    assert.ok(h, `home ${i} created`);
  }
  const extra = Homes.createHome("OwnerX", "OwnerX", "kandarin");
  assert.equal(extra, null);
  // A different kingdom still works.
  const other = Homes.createHome("OwnerY", "OwnerY", "misthalin");
  assert.ok(other);
});

// --- comfort / status ------------------------------------------------------------

check("comfortOf and statusOf reflect size and furnishings", () => {
  const home = Homes.createHome("Cara Lee", "Cara Lee", "asgarnia", Homes.SIZE_COTTAGE);
  assert.equal(Homes.comfortOf(home), 1);
  assert.equal(Homes.statusOf(home), 0);
  Homes.addFurnishing(home.id, "bookshelf"); // +2 comfort
  assert.equal(Homes.comfortOf(home), 3);
  Homes.addFurnishing(home.id, "rug");
  Homes.addFurnishing(home.id, "lantern");
  assert.equal(Homes.statusOf(home), 1, "3+ furnishings add status");
  const manor = Homes.createHome("Duke Dan", "Duke Dan", "asgarnia", Homes.SIZE_MANOR);
  assert.equal(Homes.comfortOf(manor), 3);
  assert.equal(Homes.statusOf(manor), 2);
});

check("addFurnishing rejects dupes and unknown keys", () => {
  const home = Homes.createHome("Eve Kim", "Eve Kim", "asgarnia");
  assert.ok(Homes.addFurnishing(home.id, "rug"));
  assert.equal(Homes.addFurnishing(home.id, "rug"), false);
  assert.equal(Homes.addFurnishing(home.id, "nope"), false);
  assert.equal(Homes.addFurnishing("home_999", "rug"), false);
});

check("furnitureByKey finds catalog pieces", () => {
  const p = Homes.furnitureByKey("wardrobe");
  assert.ok(p);
  assert.equal(p.name, "teak wardrobe");
  assert.equal(Homes.furnitureByKey("bogus"), null);
});

// --- guests ----------------------------------------------------------------------

check("inviteGuest / isGuestAllowed / revokeGuest", () => {
  const home = Homes.createHome("Finn Moss", "Finn Moss", "asgarnia");
  const now = Date.now();
  assert.ok(Homes.isGuestAllowed(home, "Finn Moss", now), "owner always allowed");
  assert.ok(!Homes.isGuestAllowed(home, "Stranger", now));
  assert.ok(Homes.inviteGuest(home.id, "Stranger", now));
  assert.ok(Homes.isGuestAllowed(home, "Stranger", now));
  assert.ok(!Homes.isGuestAllowed(home, "Stranger", now + Homes.GUEST_VISIT_MS + 1), "invites expire");
  Homes.inviteGuest(home.id, "Stranger", now);
  assert.ok(Homes.revokeGuest(home.id, "Stranger"));
  assert.ok(!Homes.isGuestAllowed(home, "Stranger", now));
});

// --- rent --------------------------------------------------------------------------

check("rentDue / recordRentPaid / addRentDebt / evictable", () => {
  const home = Homes.createHome("Gus Hall", "Gus Hall", "asgarnia", Homes.SIZE_COTTAGE);
  assert.ok(!Homes.rentDue(home, Date.now()), "not due right after creation");
  home.rentDueAt = Date.now() - 1;
  assert.ok(Homes.rentDue(home, Date.now()));
  assert.ok(!Homes.evictable(home));
  Homes.recordRentPaid(home, Date.now());
  assert.ok(!Homes.rentDue(home, Date.now()));
  assert.equal(home.rentDebt, 0);
  for (let i = 0; i < Homes.EVICT_DEBT_DAYS; i++) Homes.addRentDebt(home, Date.now());
  assert.ok(Homes.evictable(home), "4 unpaid days evicts");
});

// --- removal --------------------------------------------------------------------------

check("removeHome deletes and journals", () => {
  const home = Homes.createHome("Hana Ivy", "Hana Ivy", "asgarnia");
  assert.ok(Homes.removeHome(home.id, "test"));
  assert.equal(Homes.getHome(home.id), null);
  assert.equal(Homes.homeOf("Hana Ivy"), null);
  assert.equal(Homes.removeHome("home_999"), false);
});

// --- persistence ------------------------------------------------------------------------

check("save writes and reloads homes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "homes-persist-"));
  const file = path.join(dir, "homes.json");
  Homes._setSavePathForTests(file);
  const home = Homes.createHome("Ivy Jones", "Ivy Jones", "asgarnia", Homes.SIZE_HOUSE);
  Homes.addFurnishing(home.id, "table");
  assert.ok(Homes.save(), "dirty save returns true");
  assert.ok(!Homes.save(), "clean save returns false");
  Homes.resetForTests();
  Homes._setSavePathForTests(file);
  const reloaded = Homes.homeOf("Ivy Jones");
  assert.ok(reloaded, "home survives reload");
  assert.equal(reloaded.size, Homes.SIZE_HOUSE);
  assert.equal(reloaded.furnishings.length, 1);
  assert.equal(reloaded.furnishings[0].key, "table");
});

check("transferHome: ownership passes, debt cleared, furnishings kept", () => {
  const home = Homes.createHome("Ivy Jones", "Ivy Jones", "asgarnia", Homes.SIZE_HOUSE);
  Homes.addFurnishing(home.id, "table");
  Homes.addRentDebt(Homes.getHome(home.id));
  assert.equal(Homes.transferHome(home.id, "Bob Stone", "Bob Stone"), true);
  const after = Homes.getHome(home.id);
  assert.equal(after.owner, "bob stone");
  assert.equal(after.ownerDisplay, "Bob Stone");
  assert.equal(after.rentDebt, 0);
  assert.equal(after.furnishings.length, 1);
  assert.equal(Homes.homeOf("Bob Stone")?.id, home.id);
  assert.equal(Homes.homeOf("Ivy Jones"), null);
  assert.equal(Homes.transferHome("home_999", "Nobody", "Nobody"), false);
});

console.log(`\n${passed} checks passed.`);
