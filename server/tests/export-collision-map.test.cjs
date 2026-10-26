// Run after `yarn build`: node --test tests/export-collision-map.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const AdmZip = require("adm-zip");

const SCRIPT = path.join(__dirname, "..", "scripts", "export-collision-map.cjs");
const COMMITTED = path.join(__dirname, "..", "..", "client", "public", "shortestpath", "collision-map.zip");
// Lumbridge, Lumbridge Castle's north side and Varrock's south gate: walls, doors and upper floors.
const REGIONS = [12850, 12851, 12853];

function exportRegions(out) {
  execFileSync(process.execPath, [SCRIPT, "--out", out, "--regions", REGIONS.join(",")], { stdio: "pipe" });
  return fs.readFileSync(out);
}

function flag(bytes, x, y, z, flagIndex) {
  const bit = ((z * 64 + (y & 63)) * 64 + (x & 63)) * 4 + flagIndex;
  return ((bytes[bit >> 3] ?? 0) >> (bit & 7) & 1) === 1;
}

test("a rerun writes identical bytes, matching the committed collision map", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collision-map-"));
  try {
    const first = exportRegions(path.join(dir, "a.zip"));
    const second = exportRegions(path.join(dir, "b.zip"));
    assert.ok(first.equals(second), "two exports differ");

    const exported = new AdmZip(first);
    const committed = new AdmZip(COMMITTED);
    const names = exported.getEntries().map((entry) => entry.entryName);
    assert.deepEqual(names, ["50_50", "50_51", "50_53"]);
    for (const name of names) {
      assert.ok(committed.getEntry(name).getData().equals(exported.getEntry(name).getData()),
        `${name} is stale in client/public/shortestpath/collision-map.zip: rerun the exporter`);
    }

    const lumbridge = exported.getEntry("50_50").getData();
    // A house door east of Lumbridge Castle (loc 1535 at 3226, 3214, on its east edge) is opened
    // for routing but keeps its wall bit; the wall either side of it stays shut.
    assert.equal(flag(lumbridge, 3226, 3214, 0, 1), true, "door is passable");
    assert.equal(flag(lumbridge, 3226, 3214, 0, 3), true, "door is still a wall edge");
    assert.equal(flag(lumbridge, 3226, 3213, 0, 1), false, "wall south of the door is blocked");
    assert.equal(flag(lumbridge, 3226, 3215, 0, 1), false, "wall north of the door is blocked");
    // The castle's Recipe for Disaster door (12348) is an excluded door: shut, crossed by transport.
    assert.equal(flag(lumbridge, 3207, 3217, 0, 0), false, "excluded door stays shut");
    assert.equal(flag(lumbridge, 3207, 3217, 0, 2), true, "excluded door is a wall edge");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
