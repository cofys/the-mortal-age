"use strict";

/**
 * CitizenArtLife.test.js — slow tick tests. Plain node, no engine needed.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const Art = require("./CitizenArt");
const { tickArt, _resetTickForTests } = require("./CitizenArtLife");

const TMP_SAVE = path.join(os.tmpdir(), `citizen-artlife-test-${process.pid}.json`);

function makeDirector(roster = []) {
  const said = [];
  const journaled = [];
  return {
    roster: new Map(roster.map((r) => [r.username, r])),
    sayPublic: (msg) => said.push(msg),
    getJournal: () => ({ log: (k, v) => journaled.push([k, v]) }),
    isOnline: () => false,
    getBot: () => null,
    _said: said,
    _journaled: journaled,
  };
}

beforeEach(() => {
  Art._setSavePathForTests(TMP_SAVE);
  Art.resetForTests();
  _resetTickForTests();
  try { fs.unlinkSync(TMP_SAVE); } catch { /* ignore */ }
});

afterEach(() => {
  try { fs.unlinkSync(TMP_SAVE); } catch { /* ignore */ }
});

describe("CitizenArtLife", () => {
  test("tickArt never throws with empty director", () => {
    expect(() => tickArt({}, Date.now())).not.toThrow();
    expect(() => tickArt(null, Date.now())).not.toThrow();
  });

  test("tickArt throttles (second immediate tick is a no-op)", () => {
    const director = makeDirector();
    const now = Date.now();
    tickArt(director, now);
    // Create art after first tick, then tick again immediately — no exhibition.
    Art.createArtwork("Alice", "painting", 99, 1, "varrock", now);
    Art.createArtwork("Bob", "painting", 99, 1, "varrock", now);
    Art.createArtwork("Carol", "painting", 99, 1, "varrock", now);
    tickArt(director, now + 1000);
    expect(director._said).toHaveLength(0);
  });

  test("tickArt hosts exhibition when 3+ unexhibited works exist", () => {
    const director = makeDirector([
      { username: "Alice", role: "commoner", kingdomId: "varrock" },
    ]);
    const now = Date.now();
    Art.createArtwork("Alice", "painting", 99, 1, "varrock", now);
    Art.createArtwork("Bob", "painting", 80, 0.8, "varrock", now);
    Art.createArtwork("Carol", "sculpture", 70, 0.7, "varrock", now);
    // Force past the throttle.
    tickArt(director, now - 10 * 60 * 1000);
    tickArt(director, now);
    expect(director._said.length).toBeGreaterThan(0);
    expect(director._said[0]).toMatch(/exhibition/i);
    // Journal got the exhibition.
    const keys = director._journaled.map(([k]) => k);
    expect(keys).toContain("art-exhibition");
  });

  test("tickArt expires stale listings", () => {
    const director = makeDirector();
    const now = Date.now();
    const art = Art.createArtwork("Alice", "painting", 50, 0.5, "varrock", now);
    const old = now - 20 * 24 * 60 * 60 * 1000;
    Art.listForSale(art.id, 100, old);
    expect(Art.marketListings("varrock")).toHaveLength(1);
    tickArt(director, now - 10 * 60 * 1000);
    tickArt(director, now);
    expect(Art.marketListings("varrock")).toHaveLength(0);
  });

  test("tickArt handles director without sayPublic", () => {
    const director = { roster: new Map() }; // no sayPublic, no journal
    expect(() => tickArt(director, Date.now())).not.toThrow();
  });
});
