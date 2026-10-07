"use strict";

/**
 * CitizenOffices.test.js — fit-weighted seating, vacancy fill, release,
 * and the duty gate. Fake director only; no engine, no disk writes that
 * matter (save() targets data/saves/, guarded by try/catch).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const CitizenOffices = require("./CitizenOffices");

function makeRecord(username, { role = "commoner", kingdomId = "asgarnia", traits = [], merchantKind = null } = {}) {
  return {
    username,
    role,
    kingdomId,
    merchantKind,
    personality: { name: username, traits, seed: 1 },
    home: { x: 3200, y: 3200, z: 0 },
  };
}

function makeDirector(records) {
  const roster = new Map();
  for (const r of records) roster.set(r.username.toLowerCase(), r);
  return {
    roster,
    getBot: () => null,
    api: { emitCustomEvent: () => {} },
  };
}

test("marshal seat goes to the guard (fit weighting)", () => {
  CitizenOffices._resetForTests();
  const director = makeDirector([
    makeRecord("Mira", { role: "merchant", traits: ["chatty"] }),
    makeRecord("Brom", { role: "guard", traits: ["gruff"] }),
  ]);
  const b = CitizenOffices.bindCitizen(director, "asgarnia:marshal", "asgarnia", "marshal", "Marshal");
  assert.ok(b);
  assert.equal(b.citizenName, "Brom");
});

test("quartermaster seat goes to the merchant", () => {
  CitizenOffices._resetForTests();
  const director = makeDirector([
    makeRecord("Brom", { role: "guard" }),
    makeRecord("Mira", { role: "merchant", merchantKind: "supplier", traits: ["methodical"] }),
  ]);
  const b = CitizenOffices.bindCitizen(director, "asgarnia:quartermaster", "asgarnia", "quartermaster", "Quartermaster");
  assert.ok(b);
  assert.equal(b.citizenName, "Mira");
});

test("no candidate in the kingdom returns null", () => {
  CitizenOffices._resetForTests();
  const director = makeDirector([makeRecord("Brom", { role: "guard", kingdomId: "misthalin" })]);
  const b = CitizenOffices.bindCitizen(director, "asgarnia:marshal", "asgarnia", "marshal", "Marshal");
  assert.equal(b, null);
});

test("one citizen holds one office; second seat goes to someone else", () => {
  CitizenOffices._resetForTests();
  const director = makeDirector([
    makeRecord("Brom", { role: "guard" }),
    makeRecord("Cade", { role: "guard" }),
  ]);
  const a = CitizenOffices.bindCitizen(director, "asgarnia:marshal", "asgarnia", "marshal", "Marshal");
  const b = CitizenOffices.bindCitizen(director, "asgarnia:steward", "asgarnia", "steward", "Steward");
  assert.ok(a && b);
  assert.notEqual(a.citizenName, b.citizenName);
});

test("fillVacancy seats and is idempotent (no double seating)", () => {
  CitizenOffices._resetForTests();
  const director = makeDirector([makeRecord("Brom", { role: "guard" })]);
  const a = CitizenOffices.fillVacancy(director, {
    officeId: "asgarnia:marshal",
    kingdomId: "asgarnia",
    title: "Marshal",
  });
  const b = CitizenOffices.fillVacancy(director, {
    officeId: "asgarnia:marshal",
    kingdomId: "asgarnia",
    title: "Marshal",
  });
  assert.ok(a && b);
  assert.equal(a.citizenName, b.citizenName);
  assert.equal(CitizenOffices.officesOfKingdom("asgarnia").length, 1);
});

test("unbindOffice releases the citizen and the office", () => {
  CitizenOffices._resetForTests();
  const director = makeDirector([makeRecord("Brom", { role: "guard" })]);
  CitizenOffices.bindCitizen(director, "asgarnia:marshal", "asgarnia", "marshal", "Marshal");
  assert.ok(CitizenOffices.officeOfCitizen("brom"));
  CitizenOffices.unbindOffice("asgarnia:marshal");
  assert.equal(CitizenOffices.officeOfCitizen("brom"), null);
  assert.equal(CitizenOffices.getBinding("asgarnia:marshal"), null);
});

test("officesOfKingdom lists only that kingdom's seated offices", () => {
  CitizenOffices._resetForTests();
  const director = makeDirector([
    makeRecord("Brom", { role: "guard", kingdomId: "asgarnia" }),
    makeRecord("Mira", { role: "guard", kingdomId: "misthalin" }),
  ]);
  CitizenOffices.bindCitizen(director, "asgarnia:marshal", "asgarnia", "marshal", "Marshal");
  CitizenOffices.bindCitizen(director, "misthalin:marshal", "misthalin", "marshal", "Marshal");
  const list = CitizenOffices.officesOfKingdom("asgarnia");
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Marshal");
  assert.equal(list[0].citizenName, "Brom");
});

test("tickOffices performs a duty when due (lastDutyMs updates)", () => {
  CitizenOffices._resetForTests();
  const director = makeDirector([makeRecord("Brom", { role: "guard" })]);
  const b = CitizenOffices.bindCitizen(
    director,
    "asgarnia:marshal",
    "asgarnia",
    "marshal",
    "Marshal",
    { quiet: true }
  );
  b.lastDutyMs = 0;
  // Force the duty gate: advance the clock ~70s per tick so each tick rolls
  // in a fresh rng window (the gate rolls once per 65s window by design).
  const realNow = Date.now;
  try {
    let fake = realNow();
    Date.now = () => fake;
    let ran = 0;
    for (let i = 0; i < 200 && b.lastDutyMs === 0; i++) {
      fake += 70_000;
      CitizenOffices.tickOffices(director, 12);
      ran++;
    }
    assert.ok(b.lastDutyMs > 0, `duty never ran in ${ran} ticks`);
  } finally {
    Date.now = realNow;
  }
});

test("tickOffices clears bindings for citizens who left the realm", () => {
  CitizenOffices._resetForTests();
  const director = makeDirector([makeRecord("Brom", { role: "guard" })]);
  CitizenOffices.bindCitizen(director, "asgarnia:marshal", "asgarnia", "marshal", "Marshal", { quiet: true });
  assert.equal(CitizenOffices.officesOfKingdom("asgarnia").length, 1);
  director.roster.clear();
  CitizenOffices.tickOffices(director, 12);
  assert.equal(CitizenOffices.officesOfKingdom("asgarnia").length, 0);
});
