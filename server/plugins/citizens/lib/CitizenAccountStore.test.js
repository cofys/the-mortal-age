// CitizenAccountStore round-trip checks — per-citizen account files.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "citizen-account-store-test-"));
fs.mkdirSync(path.join(tmpDir, "data", "saves", "citizens"), { recursive: true });
process.chdir(tmpDir); // store resolves its dir from process.cwd()

const Store = require("./CitizenAccountStore");

let passed = 0;
function check(name, fn) {
  Store.clearCache();
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// 1. createAccount -> load round-trip preserves identity/appearance.
check("createAccount/load round-trip", () => {
  const created = Store.createAccount({
    username: "Maude Limber",
    gender: "female",
    role: "commoner",
    kingdomId: "asgarnia",
    home: { x: 3200, y: 3200, z: 0 },
    traits: ["kind"],
    appearance: { gender: "female" },
  });
  assert.equal(created.normalizedName, "maude limber");
  const loaded = Store.load("Maude Limber");
  assert.ok(loaded, "account should load");
  assert.equal(loaded.username, "Maude Limber");
  assert.equal(loaded.gender, "female");
  assert.equal(loaded.identity.role, "commoner");
  assert.equal(loaded.identity.kingdomId, "asgarnia");
  assert.deepEqual(loaded.identity.home, { x: 3200, y: 3200, z: 0 });
  assert.equal(loaded.appearance.gender, "female");
  assert.equal(loaded.version, Store.ACCOUNT_VERSION);
  // File landed on disk with the kebab-case name.
  assert.ok(
    fs.existsSync(path.join(tmpDir, "data", "saves", "citizens", "maude-limber.json")),
    "account file should exist on disk"
  );
});

// 2. setBlock/getBlock namespaced writes.
check("setBlock/getBlock round-trip", () => {
  Store.createAccount({ username: "Borin Oak", gender: "male" });
  Store.setBlock("Borin Oak", "skills", { woodcutting: 1500, firemaking: 200 });
  assert.deepEqual(Store.getBlock("borin oak", "skills"), { woodcutting: 1500, firemaking: 200 });
  assert.deepEqual(Store.getBlock("borin oak", "nope"), {});
  const loaded = Store.load("borin oak");
  assert.deepEqual(loaded.skills, { woodcutting: 1500, firemaking: 200 });
});

// 3. hasChanged: identical -> false, modified -> true, unknown -> true.
check("hasChanged dirty detection", () => {
  const created = Store.createAccount({ username: "Sera Vane", gender: "female", role: "guard" });
  assert.equal(Store.hasChanged("sera vane", { ...created }), false);
  assert.equal(Store.hasChanged("sera vane", { ...created, gender: "male" }), true);
  assert.equal(Store.hasChanged("sera vane", { ...created, skills: { mining: 10 } }), true);
  assert.equal(Store.hasChanged("nobody here", { ...created }), true);
  // updatedAt alone never counts as a change.
  assert.equal(Store.hasChanged("sera vane", { ...created, updatedAt: Date.now() + 99999 }), false);
});

// 4. save() updates updatedAt and listAccounts sees the file.
check("save/listAccounts", () => {
  const before = Date.now();
  Store.save("tomas reed", {
    username: "Tomas Reed",
    gender: "male",
    identity: { role: "merchant" },
  });
  const loaded = Store.load("tomas reed");
  assert.ok(loaded.updatedAt >= before, "updatedAt should be stamped on save");
  assert.ok(Store.listAccounts().includes("tomas reed"), "listAccounts should include the new file");
  assert.equal(Store.exists("Tomas Reed"), true);
  assert.equal(Store.exists("ghost person"), false);
});

// 5. Corrupt file -> load returns null, never throws.
check("corrupt file returns null", () => {
  const bad = path.join(tmpDir, "data", "saves", "citizens", "corrupt-ed.json");
  fs.writeFileSync(bad, "{ not json");
  assert.equal(Store.load("corrupt ed"), null);
});

console.log(`\n${passed} CitizenAccountStore checks passed`);
