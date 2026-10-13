"use strict";

// stripSelfNarration (Jon 2026-10-13): the model sometimes narrates itself in
// third person ("Sidney Parker, a commoner from Misthalin, humbly responds:
// ..."). The game shows the name above the head; a player never does this.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { stripSelfNarration } = require("./AiBotNarration");

test("strips a full third-person self-introduction", () => {
  assert.equal(
    stripSelfNarration(
      "Sidney Parker, a commoner from Misthalin, humbly responds: Of course, kind stranger!",
      "Sidney Parker"
    ),
    "Of course, kind stranger!"
  );
});

test("strips other narrator verbs", () => {
  assert.equal(
    stripSelfNarration("Petra Lane, a fisher, says: nice catch today", "Petra Lane"),
    "nice catch today"
  );
  assert.equal(
    stripSelfNarration("Harold nods: aye, that works", "Harold Finch"),
    "aye, that works"
  );
});

test("strips a bare name prefix", () => {
  assert.equal(stripSelfNarration("Mira: hey there", "Mira"), "hey there");
  assert.equal(stripSelfNarration("Mira, hey there", "Mira"), "hey there");
});

test("leaves normal first-person lines alone", () => {
  assert.equal(stripSelfNarration("hey, nice to meet you", "Mira"), "hey, nice to meet you");
  assert.equal(stripSelfNarration("i'm heading to the bank", "Mira"), "i'm heading to the bank");
});

test("does not strip other people's names", () => {
  assert.equal(
    stripSelfNarration("Petra said she's coming too", "Mira"),
    "Petra said she's coming too"
  );
});

test("handles empty input safely", () => {
  assert.equal(stripSelfNarration("", "Mira"), "");
  assert.equal(stripSelfNarration(null, "Mira"), "");
  assert.equal(stripSelfNarration("hello", null), "hello");
});
