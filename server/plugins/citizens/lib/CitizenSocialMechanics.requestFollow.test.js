// requestFollow return-type checks — { ok, reason }, never silent booleans.
const assert = require("node:assert/strict");

const SocialMechanics = require("./CitizenSocialMechanics");
const { requestFollow, requestStopFollow } = SocialMechanics;
const Bonds = require("./CitizenBonds");

// With no bonds data, nobody is friend/enemy — strangers get the
// personality willingness path.
{
  const r = requestFollow("TestCitizenA", "Jon", { personality: { traits: [] } });
  assert.equal(typeof r, "object", "returns an object, not a boolean");
  assert.equal(r.ok, true, "neutral citizen accepts");
  assert.equal(r.reason, "willing", "reason is 'willing' for strangers");
}

{
  const r = requestFollow("TestCitizenB", "Jon", { personality: { traits: ["suspicious"] } });
  assert.equal(r.ok, false, "suspicious citizen refuses strangers");
  assert.equal(r.reason, "refused", "reason is 'refused'");
}

{
  const r = requestFollow("TestCitizenC", "Jon", { personality: { traits: ["HOSTILE"] } });
  assert.equal(r.ok, false, "hostile citizen refuses (case-insensitive)");
  assert.equal(r.reason, "refused");
}

// Already following the same player → already.
{
  requestFollow("TestCitizenD", "Jon", { personality: { traits: [] } });
  const r = requestFollow("TestCitizenD", "Jon", { personality: { traits: [] } });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "already");
  requestStopFollow("TestCitizenD", "Jon");
}

// Enemy → enemy reason.
{
  Bonds.addEnemy("TestCitizenE", "Jon");
  const r = requestFollow("TestCitizenE", "Jon", { personality: { traits: [] } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "enemy");
  Bonds.removeEnemy("TestCitizenE", "Jon");
}

// Friend → friend reason.
{
  Bonds.addFriend("TestCitizenF", "Jon");
  const r = requestFollow("TestCitizenF", "Jon", { personality: { traits: [] } });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "friend");
  Bonds.removeFriend("TestCitizenF", "Jon");
}

console.log("requestFollow tests passed.");
