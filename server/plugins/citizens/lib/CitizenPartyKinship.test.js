// CitizenPartyKinship unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  kinOrder,
  refusalLine,
  stormOffLine,
  stormOffCandidate,
  _resetStateForTests,
} = require("./CitizenPartyKinship");

_resetStateForTests();

// Deterministic rng: always picks the first line.
const first = () => 0;

// Stub kinship adapter.
function stubKin({ feuds = [], spouse = null, partner = null } = {}) {
  const norm = (s) => String(s).toLowerCase();
  const key = (a, b) => [norm(a), norm(b)].sort().join("|");
  const set = new Set(feuds.map(([a, b]) => key(a, b)));
  return {
    isOpenFeud: (a, b) => set.has(key(a, b)),
    spouseOf: () => spouse,
    partnerOf: () => partner,
  };
}

function rec(name, traits = []) {
  return { username: name, displayName: name, personality: { traits } };
}

// 1. Spouse moves to the front of the candidate order.
{
  const cands = [rec("bryn"), rec("mara"), rec("hilde")];
  const { kept, excluded } = kinOrder("aled", cands, stubKin({ spouse: "mara" }));
  assert.deepEqual(kept.map((c) => c.username), ["mara", "bryn", "hilde"]);
  assert.deepEqual(excluded, []);
}

// 2. Open feud with the leader excludes the candidate.
{
  const cands = [rec("bryn"), rec("mara"), rec("hilde")];
  const { kept, excluded } = kinOrder("aled", cands, stubKin({ feuds: [["aled", "hilde"]] }));
  assert.deepEqual(kept.map((c) => c.username), ["bryn", "mara"]);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].record.username, "hilde");
  assert.equal(excluded[0].feudWith, "aled");
}

// 3. Open feud between two companions: the later one is excluded too.
{
  const cands = [rec("bryn"), rec("mara"), rec("hilde")];
  const { kept, excluded } = kinOrder("aled", cands, stubKin({ feuds: [["bryn", "mara"]] }));
  assert.deepEqual(kept.map((c) => c.username), ["bryn", "hilde"]);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].record.username, "mara");
}

// 4. Cold/bitter feuds (not open) do NOT exclude.
{
  const cands = [rec("bryn"), rec("mara")];
  const { kept, excluded } = kinOrder("aled", cands, stubKin({ feuds: [] }));
  assert.equal(kept.length, 2);
  assert.deepEqual(excluded, []);
}

// 5. refusalLine is personality-gated and substitutes the name.
{
  const warm = refusalLine(rec("aled", ["cheerful"]), "Hilde", first);
  assert.ok(warm.includes("Hilde"), `expected Hilde in: ${warm}`);
  assert.ok(!warm.includes("{feud}"));
  const gruff = refusalLine(rec("aled", ["gruff"]), "Hilde", first);
  assert.ok(gruff.includes("Hilde"));
  assert.notEqual(warm, gruff); // different voices
  const neutral = refusalLine(rec("aled", []), "Hilde", first);
  assert.ok(neutral.includes("Hilde"));
}

// 6. stormOffLine substitutes and gates by personality.
{
  const line = stormOffLine(rec("bryn", ["surly"]), "Aled", first);
  assert.ok(line.includes("Aled"), `expected Aled in: ${line}`);
  assert.ok(!line.includes("{other}"));
  const kind = stormOffLine(rec("bryn", ["kind"]), "Aled", first);
  assert.notEqual(line, kind);
}

// 7. stormOffCandidate prefers the member feuding with the leader.
{
  const kin = stubKin({ feuds: [["aled", "bryn"], ["mara", "hilde"]] });
  const pick = stormOffCandidate(["bryn", "mara", "hilde"], "aled", kin);
  assert.deepEqual(pick, { stormer: "bryn", other: "aled" });
}

// 8. stormOffCandidate falls back to the first non-leader pair.
{
  const kin = stubKin({ feuds: [["mara", "hilde"]] });
  const pick = stormOffCandidate(["bryn", "mara", "hilde"], "aled", kin);
  assert.deepEqual(pick, { stormer: "hilde", other: "mara" });
}

// 9. stormOffCandidate skips already-stormed pairs and returns null when done.
{
  const norm = (s) => String(s).toLowerCase();
  const pk = [norm("mara"), norm("hilde")].sort().join("|");
  const kin = stubKin({ feuds: [["mara", "hilde"]] });
  const pick = stormOffCandidate(["bryn", "mara", "hilde"], "aled", kin, [pk]);
  assert.equal(pick, null);
  const none = stormOffCandidate(["bryn", "mara"], "aled", stubKin());
  assert.equal(none, null);
}

// 10. Kinship adapter failure is tolerated: isOpenFeud throwing keeps everyone.
{
  const bad = { isOpenFeud: () => { throw new Error("boom"); }, spouseOf: () => null, partnerOf: () => null };
  const cands = [rec("bryn"), rec("mara")];
  const { kept, excluded } = kinOrder("aled", cands, bad);
  assert.equal(kept.length, 2);
  assert.deepEqual(excluded, []);
  const pick = stormOffCandidate(["bryn"], "aled", bad);
  assert.equal(pick, null);
}

// 11. A spouse in open feud with the leader is excluded, not prioritized.
{
  const cands = [rec("bryn"), rec("mara")];
  const { kept, excluded } = kinOrder("aled", cands, stubKin({ spouse: "mara", feuds: [["aled", "mara"]] }));
  assert.deepEqual(kept.map((c) => c.username), ["bryn"]);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].record.username, "mara");
}

console.log("CitizenPartyKinship: all assertions passed.");
