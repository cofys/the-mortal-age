"use strict";

// Plain-node tests for CitizenMusicDanceLife (slow tick).
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const MD = require("./CitizenMusicDance");
const { tickMusicDance } = require("./CitizenMusicDanceLife");

const SAVE = path.join(os.tmpdir(), `citizen-music-dance-life-test-${process.pid}.json`);
MD._setSavePathForTests(SAVE);

function fresh() {
  try { require("node:fs").unlinkSync(SAVE); } catch { /* no file yet */ }
  MD.resetForTests();
}

function mockDirector() {
  const roster = new Map();
  return {
    roster,
    log() {},
    isOnline() { return false; },
    getBot() { return null; },
    addCitizen(username, kingdomId) {
      roster.set(username.toLowerCase(), { username, kingdomId, role: "commoner" });
    },
  };
}

// --- never throws on empty director ---
{
  fresh();
  const d = mockDirector();
  tickMusicDance(d, 1000000);
  tickMusicDance(null, 1000000);
  tickMusicDance({}, 1000000);
  console.log("ok: never-throws");
}

// --- schedules a concert when an ensemble exists ---
{
  fresh();
  const d = mockDirector();
  d.addCitizen("Maestro", "misthalin");
  MD.addMusic("Maestro", 80); MD.addMusic("Vio", 70); MD.addMusic("Cel", 70);
  const ens = MD.formEnsemble("Maestro", ["Vio", "Cel"]);
  assert.ok(ens, "ensemble forms");
  tickMusicDance(d, 1000000);
  const c = MD.concertFor("misthalin");
  assert.ok(c, "concert scheduled");
  assert.strictEqual(c.ensembleId, ens.id, "scheduled for the ensemble");
  // Second tick: no double booking.
  tickMusicDance(d, 2000000);
  assert.strictEqual(MD.concerts().filter((x) => x.kingdomId === "misthalin" && x.status === "scheduled").length, 1, "no double booking");
  console.log("ok: scheduling");
}

// --- no ensemble, no concert ---
{
  fresh();
  const d = mockDirector();
  tickMusicDance(d, 1000000);
  assert.strictEqual(MD.concertFor("asgarnia"), null, "no ensemble means no concert");
  console.log("ok: no-ensemble-no-concert");
}

// --- concert resolves after showtime ---
{
  fresh();
  const d = mockDirector();
  d.addCitizen("Maestro2", "kandarin");
  MD.addMusic("Maestro2", 80); MD.addMusic("Vio2", 70); MD.addMusic("Cel2", 70);
  MD.formEnsemble("Maestro2", ["Vio2", "Cel2"]);
  tickMusicDance(d, 1000000);
  const c = MD.concertFor("kandarin");
  assert.ok(c, "concert scheduled");
  // 3h later (> 2h showtime): resolves.
  tickMusicDance(d, 1000000 + 3 * 3600 * 1000);
  assert.strictEqual(MD.concertFor("kandarin"), null, "concert resolved");
  const played = MD.recentConcerts(1);
  assert.strictEqual(played.length, 1, "concert in history");
  assert.strictEqual(played[0].status, "played", "marked played");
  console.log("ok: resolution");
}

// --- rehearsals raise proficiency ---
{
  fresh();
  const d = mockDirector();
  MD.addMusic("RM", 50); MD.addMusic("RM2", 50); MD.addMusic("RM3", 50);
  const ens = MD.formEnsemble("RM", ["RM2", "RM3"]);
  const before = MD.musicOf("RM2");
  tickMusicDance(d, 5000000);
  assert.ok(MD.musicOf("RM2") > before, "rehearsal raises proficiency");
  console.log("ok: rehearsals");
}

console.log("ALL CitizenMusicDanceLife TESTS PASSED");
