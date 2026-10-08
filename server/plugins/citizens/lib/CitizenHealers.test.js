"use strict";

// CitizenHealers unit checks — pure logic + lifecycle, no running server.
const assert = require("node:assert/strict");
const H = require("./CitizenHealers");

// --- tiny mocks ---------------------------------------------------------------

function loc(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}

function makeBot(x = 100, y = 100, players = []) {
  const chats = [];
  return {
    chats,
    getLocation: () => loc(x, y),
    getLocalPlayers: () => players,
    isPlayerBot: () => true,
    getForceMovement: () => null,
    getMovementQueue: () => ({ size: () => 0 }),
    forceChat: (s) => chats.push(s),
    performAnimation: () => true,
    moveTo: () => true,
    face: () => true,
  };
}

function makePlayer(name, x = 102, y = 100) {
  return {
    getUsername: () => name,
    isPlayerBot: () => false,
    getLocation: () => loc(x, y),
  };
}

function makeDirector(records, bots = {}) {
  const roster = new Map(records.map((r) => [r.username, r]));
  return {
    roster,
    isOnline: (r) => !!bots[r.username],
    getBot: (r) => bots[r.username] ?? null,
    api: {
      core: {
        Animation: function (id) {
          this.id = id;
        },
        Location: function (x, y, z) {
          this.x = x;
          this.y = y;
          this.z = z;
        },
      },
    },
  };
}

// Find a deterministic healer + non-healer username for tests.
function findHealerName() {
  for (let i = 0; i < 5000; i++) {
    const name = `HealerProbe${i}`;
    if (H.hashUsername(name) % H.HEALER_MODULO === 0) return name;
  }
  throw new Error("no healer name found");
}
function findCommonerName() {
  for (let i = 0; i < 5000; i++) {
    const name = `CommonerProbe${i}`;
    if (H.hashUsername(name) % H.HEALER_MODULO !== 0) return name;
  }
  throw new Error("no commoner name found");
}

const HEALER_NAME = findHealerName();
const COMMONER_NAME = findCommonerName();

// --- hash / designation --------------------------------------------------------

{
  // 1. hashUsername is deterministic and case-insensitive.
  assert.equal(H.hashUsername("Mira"), H.hashUsername("mira"));
  assert.equal(H.hashUsername("Mira"), H.hashUsername("Mira"));
  // 2. isHealer is stable.
  const rec = { username: HEALER_NAME, role: "commoner" };
  assert.equal(H.isHealer(rec), true);
  assert.equal(H.isHealer(rec), true);
  // 3. Guards are never healers, even with a healer hash.
  assert.equal(H.isHealer({ username: HEALER_NAME, role: "guard" }), false);
  // 4. Non-healer hash -> false.
  assert.equal(H.isHealer({ username: COMMONER_NAME, role: "commoner" }), false);
  // 5. Missing record -> false, never throws.
  assert.equal(H.isHealer(null), false);
  assert.equal(H.isHealer({}), false);
}

{
  // 6. Healer rate is sane (~4%): count over 2000 names.
  let healers = 0;
  for (let i = 0; i < 2000; i++) {
    if (H.isHealer({ username: `RateProbe${i}`, role: "commoner" })) healers++;
  }
  assert.ok(healers > 40 && healers < 140, `healer count ${healers} out of range`);
}

{
  // 7. Specialty is one of the four, stable per citizen.
  const rec = { username: HEALER_NAME, role: "commoner" };
  const s = H.healerSpecialty(rec);
  assert.ok(H.SPECIALTIES.includes(s), `bad specialty ${s}`);
  assert.equal(H.healerSpecialty(rec), s);
  // 8. Non-healers have no specialty.
  assert.equal(H.healerSpecialty({ username: COMMONER_NAME, role: "commoner" }), null);
}

// --- specialty treatment matrix -------------------------------------------------

{
  // 9. Doctors treat sick, not injured.
  assert.equal(H.specialtyTreats("doctor", "sick"), true);
  assert.equal(H.specialtyTreats("doctor", "injured"), false);
  // 10. Surgeons treat injured, not sick.
  assert.equal(H.specialtyTreats("surgeon", "injured"), true);
  assert.equal(H.specialtyTreats("surgeon", "sick"), false);
  // 11. Herbalists treat sick.
  assert.equal(H.specialtyTreats("herbalist", "sick"), true);
  // 12. Everyone treats plague during an outbreak.
  for (const s of H.SPECIALTIES) {
    assert.equal(H.specialtyTreats(s, "plague"), true, `${s} should treat plague`);
  }
  // 13. Unknown specialty treats nothing (except plague path above).
  assert.equal(H.specialtyTreats("quack", "sick"), false);
}

// --- clinic + emotes ------------------------------------------------------------

{
  // 14. clinicTile is null-safe (unknown kingdom falls back, never throws).
  const t = H.clinicTile("no-such-kingdom", "doctor");
  assert.ok(t === null || (Number.isFinite(t.x) && Number.isFinite(t.y)));
  // 15. Different specialties get different offsets.
  const a = H.clinicTile("asgarnia", "doctor");
  const b = H.clinicTile("asgarnia", "surgeon");
  assert.ok(a && b && (a.x !== b.x || a.y !== b.y), "specialties should spread out");
}

{
  // 16. treatEmote fills {patient} and picks from the specialty pool.
  const rng = () => 0; // first entry
  const line = H.treatEmote(rng, "surgeon", "injured", "Mira");
  assert.ok(line.includes("Mira"), `patient name missing: ${line}`);
  assert.ok(!line.includes("{patient}"), `template not filled: ${line}`);
  // 17. Plague uses the plague pool regardless of specialty.
  const pl = H.treatEmote(rng, "midwife", "plague", "Mira");
  assert.ok(H.TREAT_EMOTES.plague.some((p) => p.replace("{patient}", "Mira") === pl));
}

// --- eligibility ------------------------------------------------------------------

{
  // 18. Non-healers are never eligible.
  const d = makeDirector([{ username: COMMONER_NAME, role: "commoner", kingdomId: "asgarnia" }], {});
  assert.equal(
    H.eligibleHealer({ username: COMMONER_NAME, role: "commoner" }, d),
    false
  );
  // 19. Offline healers are not eligible.
  const rec = { username: HEALER_NAME, role: "commoner", kingdomId: "asgarnia" };
  const d2 = makeDirector([rec], {}); // no bot -> offline
  assert.equal(H.eligibleHealer(rec, d2), false);
  // 20. Online healer, not mid-treatment -> eligible.
  const bot = makeBot();
  const d3 = makeDirector([rec], { [HEALER_NAME]: bot });
  assert.equal(H.eligibleHealer(rec, d3), true);
}

// --- treatment lifecycle ------------------------------------------------------------

{
  // 21. startTreatment registers the treatment, walks, emotes, animates.
  const rec = { username: HEALER_NAME, role: "commoner", kingdomId: "asgarnia" };
  const bot = makeBot(100, 100);
  const d = makeDirector([rec], { [HEALER_NAME]: bot });
  const specialty = H.healerSpecialty(rec);
  H._ailments.set("mira", { kind: "sick", since: Date.now(), kingdomId: "asgarnia" });
  H.startTreatment(d, rec, bot, specialty, { name: "mira", ailment: { kind: "sick" }, tile: { x: 105, y: 100, z: 0 } }, Date.now());
  const key = HEALER_NAME.toLowerCase();
  assert.ok(H._activeTreatments.has(key), "treatment should be active");
  assert.ok(bot.chats.length > 0, "healer should emote");
  // 22. finishTreatment clears the ailment and the active treatment.
  H.finishTreatment(d, rec, Date.now());
  assert.ok(!H._activeTreatments.has(key), "treatment should be done");
  assert.ok(!H._ailments.has("mira"), "patient should be cured");
  H._ailments.clear();
}

// --- tickHealers safety ---------------------------------------------------------------

{
  // 23. tickHealers never throws on an empty/broken director.
  assert.doesNotThrow(() => H.tickHealers(null));
  assert.doesNotThrow(() => H.tickHealers({}));
  assert.doesNotThrow(() => H.tickHealers({ roster: new Map() }));
  // 24. A full tick with a healer + nearby player + patient runs clean.
  const rec = { username: HEALER_NAME, role: "commoner", kingdomId: "asgarnia" };
  const patientRec = { username: COMMONER_NAME, role: "commoner", kingdomId: "asgarnia" };
  const player = makePlayer("Jon", 102, 100);
  const healerBot = makeBot(100, 100, [player]);
  const patientBot = makeBot(105, 100, [player]);
  const d = makeDirector([rec, patientRec], { [HEALER_NAME]: healerBot, [COMMONER_NAME]: patientBot });
  H._ailments.set(COMMONER_NAME.toLowerCase(), { kind: "sick", since: Date.now(), kingdomId: "asgarnia" });
  assert.doesNotThrow(() => H.tickHealers(d, Date.now()));
  H._ailments.clear();
  H._activeTreatments.clear();
}

// --- outbreak bookkeeping ---------------------------------------------------------------

{
  // 25. tickOutbreakContainment ends an outbreak with no remaining patients.
  H._outbreaks.set("asgarnia", { startedAt: Date.now(), patientNames: new Set(["ghost"]) });
  assert.doesNotThrow(() => H.tickHealers({ roster: new Map() }, Date.now()));
  assert.ok(!H._outbreaks.has("asgarnia"), "empty outbreak should be contained");
}

console.log("CitizenHealers: 25 assertions passed");
