"use strict";

// Plain-node tests for CitizenMusicDance (data tier).
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const MD = require("./CitizenMusicDance");

const SAVE = path.join(os.tmpdir(), `citizen-music-dance-test-${process.pid}.json`);
MD._setSavePathForTests(SAVE);

function fresh() {
  MD.resetForTests();
}

function fakePlayer(coins) {
  // Mocks the REAL engine ItemContainer API (getAmount/deleteNumber/adds).
  // The old mock used count/remove/add, which do not exist on the engine
  // container — the fake API masked the no-op ticket/lesson bugs in tests.
  const inv = {
    coins,
    getAmount(id) { return id === 995 ? this.coins : 0; },
    deleteNumber(id, n) { if (id === 995 && this.coins >= n) { this.coins -= n; return true; } return false; },
    adds(id, n) { if (id === 995) this.coins += n; return true; },
  };
  return { inventory: inv, username: "testplayer" };
}

// --- instruments ---
fresh();
{
  const insts = MD.instruments();
  assert.ok(insts.length >= 4, "instrument catalog");
  assert.strictEqual(MD.instrumentById("lyre").itemId, 3689, "lyre is real item 3689");
  assert.strictEqual(MD.instrumentById("horn").itemId, 9735, "goat horn is real item 9735");
  assert.strictEqual(MD.instrumentById("nope"), null, "unknown instrument null");
  assert.ok(MD.setInstrument("Muso", "lyre"), "set instrument");
  assert.strictEqual(MD.instrumentOf("Muso").id, "lyre", "instrumentOf");
  assert.ok(!MD.setInstrument("Muso", "kazoo"), "bad instrument rejected");
  const p = fakePlayer(0);
  p.inventory.getAmount = (id) => (id === 3689 ? 1 : 0);
  assert.ok(MD.playerHasInstrument(p, "lyre"), "real lyre detected in inventory");
  assert.ok(!MD.playerHasInstrument(p, "horn"), "no horn in inventory");
  console.log("ok: instruments");
}

// --- proficiency ---
fresh();
{
  assert.strictEqual(MD.musicOf("Newbie"), 0, "fresh citizen 0 music");
  assert.strictEqual(MD.addMusic("Newbie", 45), 45, "addMusic");
  assert.strictEqual(MD.addMusic("Newbie", 100), 100, "music caps at 100");
  assert.strictEqual(MD.addDance("Newbie", 30), 30, "addDance");
  console.log("ok: proficiency");
}

// --- ensembles ---
fresh();
{
  // Below threshold: cannot form.
  MD.addMusic("Lead", 45); MD.addMusic("M2", 45); MD.addMusic("M3", 45);
  const e1 = MD.formEnsemble("Lead", ["M2"]);
  assert.strictEqual(e1, null, "needs 3+ members");
  const e2 = MD.formEnsemble("Lead", ["M2", "M3"]);
  assert.ok(e2, "ensemble forms with 3 skilled members");
  assert.ok(e2.name.startsWith("The "), "ensemble has a name");
  assert.strictEqual(MD.ensembleOf("M2").id, e2.id, "ensembleOf finds member");
  assert.strictEqual(MD.formEnsemble("Lead", ["M2", "M3"]), null, "one ensemble per citizen");
  // Skill gate: unskilled member skipped.
  MD.addMusic("Lead2", 90); MD.addMusic("M4", 90);
  const e3 = MD.formEnsemble("Lead2", ["M4", "Unskilled"]);
  assert.strictEqual(e3, null, "unskilled member cannot fill roster");
  console.log("ok: ensembles");
}

// --- troupes ---
fresh();
{
  MD.addDance("DL", 50); MD.addDance("D2", 50); MD.addDance("D3", 50); MD.addDance("D4", 50);
  const t = MD.formTroupe("DL", ["D2", "D3", "D4"]);
  assert.ok(t, "troupe forms");
  assert.strictEqual(MD.troupeOf("D3").id, t.id, "troupeOf finds member");
  console.log("ok: troupes");
}

// --- dance halls ---
fresh();
{
  const hall = MD.danceHallOfKingdom("misthalin");
  assert.ok(hall, "misthalin has a dance hall");
  assert.strictEqual(hall.name, "The Velvet Step", "hall name");
  assert.strictEqual(MD.danceHallOfKingdom("nope"), null, "unknown kingdom null");
  console.log("ok: dance halls");
}

// --- lessons ---
fresh();
{
  MD.addMusic("Teacher", 80);
  const r1 = MD.giveLesson("Teacher", "Pupil", "music", 1000);
  assert.ok(r1.ok, "lesson works");
  assert.strictEqual(r1.price, MD.LESSON_PRICE, "lesson price");
  assert.strictEqual(MD.musicOf("Pupil"), MD.LESSON_GAIN, "pupil gains");
  const r2 = MD.giveLesson("Teacher", "Pupil", "music", 2000);
  assert.ok(!r2.ok && r2.reason === "cooldown", "daily lesson cooldown");
  const r3 = MD.giveLesson("Novice", "Pupil2", "music", 3000);
  assert.ok(!r3.ok && r3.reason === "not-skilled", "unskilled cannot teach");
  const r4 = MD.giveLesson("Teacher", "Pupil2", "music", 100000000);
  assert.ok(r4.ok, "second pupil lesson works");
  console.log("ok: lessons");
}

fresh();
{
  MD.addDance("DanceTeacher", 80);
  const rd = MD.giveLesson("DanceTeacher", "DancePupil", "dance", 1000);
  assert.ok(rd.ok, "dance lessons work");
  assert.strictEqual(MD.danceOf("DancePupil"), MD.LESSON_GAIN, "dance pupil gains");
  console.log("ok: dance lessons");
}
fresh();
{
  const r1 = MD.practice("Prac", null, "music", 1000);
  assert.ok(r1.ok && r1.gain === 1, "practice gains 1");
  const r2 = MD.practice("Prac", null, "music", 2000);
  assert.ok(!r2.ok && r2.reason === "cooldown", "practice cooldown");
  console.log("ok: practice");
}

// --- concerts & tickets ---
fresh();
{
  MD.addMusic("CL", 60); MD.addMusic("CM2", 60); MD.addMusic("CM3", 60);
  const ens = MD.formEnsemble("CL", ["CM2", "CM3"]);
  assert.ok(ens, "ensemble for concert");
  const c = MD.scheduleConcert("misthalin", 1000000);
  assert.ok(c, "concert scheduled");
  assert.strictEqual(c.ticketPrice, MD.TICKET_PRICE, "ticket price");
  assert.strictEqual(MD.concertFor("misthalin").id, c.id, "concertFor");
  assert.strictEqual(MD.scheduleConcert("misthalin", 2000000), null, "no double booking");
  const buyer = fakePlayer(100);
  const t1 = MD.buyTicket("Fan", c.id, buyer, 2000000);
  assert.ok(t1.ok, "ticket bought");
  assert.strictEqual(buyer.inventory.coins, 75, "real coins taken");
  const broke = fakePlayer(5);
  const t2 = MD.buyTicket("BrokeFan", c.id, broke, 2000000);
  assert.ok(!t2.ok && t2.reason === "broke", "broke fan cannot buy");
  const t3 = MD.buyTicket("Fan", c.id, buyer, 2000000);
  assert.ok(!t3.ok && t3.reason === "already", "no double tickets");
  // Festival concerts are free.
  const cf = MD.scheduleConcert("asgarnia", 9000000, { force: true, festival: true });
  assert.ok(cf && cf.ticketPrice === 0, "festival concert is free");
  const freebie = fakePlayer(0);
  assert.ok(MD.buyTicket("PoorFan", cf.id, freebie, 9000000).ok, "free ticket works broke");
  // Resolve: payouts computed.
  const res = MD.resolveConcert(c.id, 3000000);
  assert.ok(res, "concert resolves");
  assert.ok(res.payouts.length >= 3, "ensemble members get payouts");
  assert.ok(res.hallShare >= 0, "hall share computed");
  assert.strictEqual(MD.concertFor("misthalin"), null, "resolved concert no longer scheduled");
  console.log("ok: concerts & tickets");
}

// --- persistence ---
fresh();
{
  MD.addMusic("Saver", 77);
  assert.ok(MD.save(), "save returns true when dirty");
  MD.resetForTests();
  assert.strictEqual(MD.musicOf("Saver"), 77, "proficiency survives reload");
  console.log("ok: persistence");
}

// --- hall tile regression (dead require path) ---
fresh();
{
  // The old hallTile required lib/CitizenSites, which does not exist, so it
  // always returned null and dance halls never had a real world tile.
  const tile = MD.hallTile("misthalin");
  assert.ok(tile && Number.isFinite(tile.x) && Number.isFinite(tile.y),
    "hallTile resolves a real world tile near the market");
  assert.ok(MD.hallTile("nosuchkingdom") === null, "unknown kingdom still null");
  console.log("ok: hall tile");
}

// --- honest coin movement regression ---
fresh();
{
  // The old takeCoins called inv.remove, a silent no-op on the engine
  // container that still returned true — tickets and lessons were free.
  const rich = fakePlayer(100);
  assert.ok(MD.takeCoins(rich, 25), "takeCoins succeeds when funded");
  assert.strictEqual(rich.inventory.coins, 75, "takeCoins moved 25 coins");
  const poor = fakePlayer(5);
  assert.ok(!MD.takeCoins(poor, 25), "takeCoins refuses when broke");
  assert.strictEqual(poor.inventory.coins, 5, "broke balance untouched");
  // An inventory missing the canonical API must not pretend success.
  const fakeApi = { inventory: { coins: 100 } };
  assert.ok(!MD.takeCoins(fakeApi, 25), "no canonical deleteNumber -> honest failure");
  assert.ok(!MD.giveCoins(fakeApi, 25), "no canonical adds -> honest failure");
  const earner = fakePlayer(0);
  assert.ok(MD.giveCoins(earner, 40), "giveCoins succeeds");
  assert.strictEqual(earner.inventory.coins, 40, "giveCoins moved 40 coins");
  console.log("ok: honest coins");
}

console.log("ALL CitizenMusicDance TESTS PASSED");
