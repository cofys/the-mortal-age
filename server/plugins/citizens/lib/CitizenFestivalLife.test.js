"use strict";

/**
 * CitizenFestivalLife.test.js — festival calendar, kingdom state reads,
 * and tick dynamics. Plain node, no engine.
 */

const assert = require("node:assert");
const { describe, it, beforeEach } = require("node:test");

const Life = require("./CitizenFestivalLife");
const Festivals = require("./CitizenFestivals");

const DAY = 24 * 3600 * 1000;

function at(y, m, d) {
  return new Date(y, m, d, 12, 0, 0).getTime(); // noon, local
}

beforeEach(() => {
  Life.resetForTests();
  Festivals._test.resetForTests();
});

describe("religious feasts", () => {
  it("defines one feast per god", () => {
    assert.equal(Life.GOD_FEASTS.length, 6);
    const gods = new Set(Life.GOD_FEASTS.map((f) => f.god));
    assert.equal(gods.size, 6);
  });

  it("shapes feast defs like the seasonal calendar", () => {
    const feasts = Life.religiousFestivals(2026);
    assert.equal(feasts.length, 6);
    for (const f of feasts) {
      assert.ok(f.id && f.name && typeof f.month === "number");
      assert.equal(f.durationDays, 2);
      assert.equal(f.kind, "religious");
    }
  });
});

describe("merged calendar", () => {
  it("merges seasonal + religious, sorted by date", () => {
    const all = Life.allFestivals(2026);
    // 5 seasonal + 6 feasts
    assert.equal(all.length, 11);
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const cur = all[i];
      assert.ok(
        cur.month > prev.month ||
          (cur.month === prev.month && cur.startDay >= prev.startDay),
        "calendar sorted"
      );
    }
  });

  it("nextFestival finds the next upcoming festival", () => {
    // Jan 1 2026: Light's Vigil starts Jan 10.
    const next = Life.nextFestival(at(2026, 0, 1));
    assert.ok(next);
    assert.equal(next.id, "feast-lights-vigil");
    assert.equal(Life.daysUntil(next, at(2026, 0, 1)), 9);
  });

  it("nextFestival returns a running festival with daysUntil 0", () => {
    // Founding Day: Jan 15-17.
    const next = Life.nextFestival(at(2026, 0, 16));
    assert.ok(next);
    assert.equal(next.id, "founding-day");
    assert.equal(Life.daysUntil(next, at(2026, 0, 16)), 0);
  });

  it("festivalsComing returns the next n", () => {
    const coming = Life.festivalsComing(3, at(2026, 0, 1));
    assert.equal(coming.length, 3);
    assert.equal(coming[0].id, "feast-lights-vigil");
  });
});

describe("feast source registration", () => {
  it("registers feasts into the seasonal calendar", () => {
    assert.ok(Life.registerFeastSource());
    // Hearthtide: Dec 1-2.
    const active = Festivals.activeFestival(at(2026, 11, 1, 12));
    assert.ok(active);
    assert.equal(active.id, "feast-hearthtide");
  });

  it("returns null outside any feast", () => {
    Life.registerFeastSource();
    // Feb 1: nothing on.
    const active = Festivals.activeFestival(at(2026, 1, 1, 12));
    assert.equal(active, null);
  });

  it("seasonal festivals still work with the source registered", () => {
    Life.registerFeastSource();
    // Harvest Home: Oct 7-9.
    const active = Festivals.activeFestival(at(2026, 9, 8, 12));
    assert.ok(active);
    assert.equal(active.id, "harvest-home");
  });
});

describe("kingdom festival state", () => {
  // Stub the government module in require cache.
  const govPath = require.resolve("./CitizenGovernment");
  let lawsByKingdom = {};
  let unrestCalls = [];

  function stubGov() {
    const orig = require.cache[govPath];
    require.cache[govPath] = {
      id: govPath,
      filename: govPath,
      loaded: true,
      exports: {
        hasLaw: (kingdomId, lawId) =>
          (lawsByKingdom[kingdomId] ?? []).includes(lawId),
        activeLaws: (kingdomId) =>
          (lawsByKingdom[kingdomId] ?? []).map((id) => ({
            id,
            passedAtMs: 1000,
          })),
        adjustUnrest: (kingdomId, delta) =>
          unrestCalls.push({ kingdomId, delta }),
      },
    };
    return () => {
      if (orig) require.cache[govPath] = orig;
      else delete require.cache[govPath];
    };
  }

  beforeEach(() => {
    lawsByKingdom = {};
    unrestCalls = [];
  });

  it("councilFestivalActive reads the festival law", () => {
    const restore = stubGov();
    try {
      lawsByKingdom = { varrock: ["festival"] };
      assert.equal(Life.councilFestivalActive("varrock", Date.now()), true);
      assert.equal(Life.councilFestivalActive("falador", Date.now()), false);
    } finally {
      restore();
    }
  });

  it("marketDayActive reads the market-day law", () => {
    const restore = stubGov();
    try {
      lawsByKingdom = { varrock: ["market-day"] };
      assert.equal(Life.marketDayActive("varrock", Date.now()), true);
      assert.equal(Life.marketDayActive("varrock2", Date.now()), false);
    } finally {
      restore();
    }
  });

  it("festivalMood is festive during council weeks", () => {
    const restore = stubGov();
    try {
      lawsByKingdom = { varrock: ["festival"] };
      assert.equal(Life.festivalMood("varrock", at(2026, 1, 1)), "festive");
      assert.equal(Life.festivalMood("falador", at(2026, 1, 1)), "ordinary");
    } finally {
      restore();
    }
  });

  it("festivalMood is festive during religious feasts", () => {
    const restore = stubGov();
    try {
      // Hearthtide Dec 1, no council needed.
      assert.equal(
        Life.festivalMood("varrock", at(2026, 11, 1, 12)),
        "festive"
      );
    } finally {
      restore();
    }
  });

  it("tradeBoost is 1 on market days and festivals", () => {
    const restore = stubGov();
    try {
      lawsByKingdom = { a: ["market-day"], b: ["festival"], c: [] };
      assert.equal(Life.tradeBoost("a", at(2026, 1, 1)), 1);
      assert.equal(Life.tradeBoost("b", at(2026, 1, 1)), 1);
      assert.equal(Life.tradeBoost("c", at(2026, 1, 1)), 0);
    } finally {
      restore();
    }
  });
});

describe("tickFestivalLife", () => {
  const govPath = require.resolve("./CitizenGovernment");
  let lawsByKingdom = {};
  let unrestCalls = [];
  const journalLines = [];

  function stubAll() {
    const orig = require.cache[govPath];
    require.cache[govPath] = {
      id: govPath,
      filename: govPath,
      loaded: true,
      exports: {
        hasLaw: (kingdomId, lawId) =>
          (lawsByKingdom[kingdomId] ?? []).includes(lawId),
        activeLaws: (kingdomId) =>
          (lawsByKingdom[kingdomId] ?? []).map((id) => ({
            id,
            name: id,
            passedAtMs: 1000,
          })),
        adjustUnrest: (kingdomId, delta) =>
          unrestCalls.push({ kingdomId, delta }),
      },
    };
    return () => {
      if (orig) require.cache[govPath] = orig;
      else delete require.cache[govPath];
    };
  }

  function makeDirector(records) {
    return {
      roster: new Map(records.map((r) => [r.username, r])),
      isOnline: () => false,
      getBot: () => null,
      log: () => {},
    };
  }

  beforeEach(() => {
    lawsByKingdom = {};
    unrestCalls = [];
    journalLines.length = 0;
    // Stub the journal via require cache.
    const jPath = require.resolve("./CitizenJournal");
    const orig = require.cache[jPath];
    require.cache[jPath] = {
      id: jPath,
      filename: jPath,
      loaded: true,
      exports: {
        getJournal: () => ({
          log: (name, kind, text) => journalLines.push({ name, kind, text }),
        }),
      },
    };
    if (!global.__origJournal) global.__origJournal = orig;
  });

  it("journals council-week participation once per citizen", () => {
    const restore = stubAll();
    try {
      lawsByKingdom = { varrock: ["festival"] };
      const director = makeDirector([
        { username: "alice", kingdomId: "varrock" },
        { username: "bob", kingdomId: "varrock" },
      ]);
      const now = at(2026, 1, 5);
      Life.tickFestivalLife(director, now);
      Life.tickFestivalLife(director, now + 1000);
      const joined = journalLines.filter((l) =>
        l.text.includes("Celebrated")
      );
      // 2 citizens x 1 festival each (idempotent across ticks)
      assert.equal(joined.length, 2);
    } finally {
      restore();
    }
  });

  it("relieves unrest during festival days", () => {
    const restore = stubAll();
    try {
      lawsByKingdom = { varrock: ["festival"] };
      const director = makeDirector([{ username: "alice", kingdomId: "varrock" }]);
      Life.tickFestivalLife(director, at(2026, 1, 5));
      assert.ok(unrestCalls.some((c) => c.kingdomId === "varrock" && c.delta < 0));
    } finally {
      restore();
    }
  });

  it("does not relieve unrest on ordinary days", () => {
    const restore = stubAll();
    try {
      const director = makeDirector([{ username: "alice", kingdomId: "varrock" }]);
      Life.tickFestivalLife(director, at(2026, 1, 5)); // no laws, no feasts
      assert.equal(unrestCalls.length, 0);
    } finally {
      restore();
    }
  });

  it("announces newly declared council festivals", () => {
    const restore = stubAll();
    try {
      lawsByKingdom = { varrock: ["festival"] };
      const said = [];
      const citizen = {
        getAttribute: () => ({}),
      };
      const director = {
        roster: new Map([["alice", { username: "alice", kingdomId: "varrock" }]]),
        isOnline: () => true,
        getBot: () => citizen,
        log: () => {},
      };
      // Stub sayPublic + voice via require cache.
      const sp = require.resolve("../chat/CitizenSayPublic");
      const origSp = require.cache[sp];
      require.cache[sp] = {
        id: sp, filename: sp, loaded: true,
        exports: { sayPublic: (c, line) => said.push(line) },
      };
      const vl = require.resolve("./citizenVoice");
      const origVl = require.cache[vl];
      require.cache[vl] = {
        id: vl, filename: vl, loaded: true,
        exports: { voiceFor: () => ({}), voiceLine: (v, o) => o.plain[0] },
      };
      try {
        Life.tickFestivalLife(director, at(2026, 1, 5));
        assert.ok(said.length >= 1, "festival announced");
      } finally {
        if (origSp) require.cache[sp] = origSp; else delete require.cache[sp];
        if (origVl) require.cache[vl] = origVl; else delete require.cache[vl];
      }
    } finally {
      restore();
    }
  });

  it("null-director safety: empty roster is a no-op", () => {
    const restore = stubAll();
    try {
      Life.tickFestivalLife({ roster: new Map(), log: () => {} }, Date.now());
    } finally {
      restore();
    }
  });
});
