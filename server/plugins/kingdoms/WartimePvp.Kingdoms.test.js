"use strict";

/**
 * WartimePvp.Kingdoms — wartime open PvP in kingdom territory.
 *
 * Covers the canAttack matrix (war vs peace × same/enemy/neutral/
 * kingdomless × open territory vs town safe zone), the town and
 * territory tables, the lawful-war-fight test the crime hooks use,
 * war-end shutoff, the client Attack-option signal, and the
 * Areas.Kingdoms wiring (canAttack / process / postLeave).
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const Store = require("./KingdomStore");
const WartimePvp = require("./WartimePvp.Kingdoms");
const attachAreas = require("./Areas.Kingdoms");

const A = "asgarnia";
const M = "misthalin";
const K = "kandarin";

// Open field inside each territory, outside every town safe zone.
const FIELD_A = { x: 2950, y: 3480, z: 0 }; // Asgarnia, south of Falador
const FIELD_M = { x: 3250, y: 3300, z: 0 }; // Misthalin, south-east fields
const FIELD_K = { x: 2500, y: 3200, z: 0 }; // Kandarin, west of Ardougne
// Town squares (inside the safe zones).
const TOWN_A = { x: 2968, y: 3380, z: 0 }; // Falador
const TOWN_M = { x: 3169, y: 3487, z: 0 }; // Varrock
// Off every territory rect.
const NOWHERE = { x: 3200, y: 3000, z: 0 };

function seed() {
  Store.resetForTests();
  Store.upsertKingdom({ id: A, name: "Asgarnia", capital: "Falador" });
  Store.upsertKingdom({ id: M, name: "Misthalin", capital: "Varrock" });
  Store.upsertKingdom({ id: K, name: "Kandarin", capital: "East Ardougne" });
}

function declareWar() {
  Store.declareWar({ attackerId: A, defenderId: M });
}

function mockSubject(kingdomId, loc, opts = {}) {
  const attrs = {};
  if (kingdomId) attrs["kingdom:id"] = kingdomId;
  const sent = [];
  return {
    sent,
    isPlayer: () => true,
    isPlayerBot: () => opts.bot === true,
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    getUsername: () => opts.name ?? "Subject",
    getLocation: () => ({ ...loc }),
    getPacketSender: () => ({
      sendVarbit: (id, v) => sent.push(["varbit", id, v]),
      sendInteractionOption: (text, idx, flag) => sent.push(["option", text, idx, flag]),
      sendMessage: (m) => sent.push(["message", m]),
    }),
    sendMessage: (m) => sent.push(["message", m]),
  };
}

function mockNpc(loc) {
  return {
    isPlayer: () => false,
    isPlayerBot: () => false,
    getAttribute: () => null,
    getLocation: () => ({ ...loc }),
  };
}

describe("wartimeCanAttack matrix", () => {
  beforeEach(seed);

  it("enemy subjects may fight on either side's territory during war", () => {
    declareWar();
    const a = mockSubject(A, FIELD_A);
    const m = mockSubject(M, FIELD_A);
    assert.equal(WartimePvp.wartimeCanAttack(a, m, A), true);
    assert.equal(WartimePvp.wartimeCanAttack(a, m, M), true);
    assert.equal(WartimePvp.wartimeCanAttack(m, a, A), true);
  });

  it("neutral territory is no opinion — the pair stays unattackable", () => {
    declareWar();
    const a = mockSubject(A, FIELD_K);
    const m = mockSubject(M, FIELD_K);
    assert.equal(WartimePvp.wartimeCanAttack(a, m, K), null);
  });

  it("peace means no opinion everywhere", () => {
    const a = mockSubject(A, FIELD_A);
    const m = mockSubject(M, FIELD_A);
    assert.equal(WartimePvp.wartimeCanAttack(a, m, A), null);
    assert.equal(WartimePvp.wartimeCanAttack(a, m, M), null);
  });

  it("same-kingdom and kingdomless pairs are never wartime targets", () => {
    declareWar();
    assert.equal(
      WartimePvp.wartimeCanAttack(mockSubject(A, FIELD_A), mockSubject(A, FIELD_A), A),
      null
    );
    assert.equal(
      WartimePvp.wartimeCanAttack(mockSubject(null, FIELD_A), mockSubject(M, FIELD_A), A),
      null
    );
    assert.equal(
      WartimePvp.wartimeCanAttack(mockSubject(A, FIELD_A), mockSubject(null, FIELD_A), A),
      null
    );
  });

  it("a third kingdom at peace with both is untouched", () => {
    declareWar();
    const k = mockSubject(K, FIELD_M);
    const m = mockSubject(M, FIELD_M);
    assert.equal(WartimePvp.wartimeCanAttack(k, m, M), null);
    assert.equal(WartimePvp.wartimeCanAttack(m, k, M), null);
  });

  it("town safe zones hard-deny even mid-war, from either side", () => {
    declareWar();
    const aInTown = mockSubject(A, TOWN_M);
    const mField = mockSubject(M, FIELD_M);
    assert.equal(WartimePvp.wartimeCanAttack(aInTown, mField, M), false);
    const aField = mockSubject(A, FIELD_M);
    const mInTown = mockSubject(M, TOWN_M);
    assert.equal(WartimePvp.wartimeCanAttack(aField, mInTown, M), false);
    // Home capital is just as safe: no fighting inside Falador either.
    assert.equal(
      WartimePvp.wartimeCanAttack(mockSubject(M, TOWN_A), mockSubject(A, TOWN_A), A),
      false
    );
  });

  it("NPCs are not subjects — no opinion, normal PvE rules apply", () => {
    declareWar();
    const a = mockSubject(A, FIELD_A);
    assert.equal(WartimePvp.wartimeCanAttack(a, mockNpc(FIELD_A), A), null);
    assert.equal(WartimePvp.wartimeCanAttack(mockNpc(FIELD_A), a, A), null);
  });

  it("materialized citizens (player bots) follow the same rule", () => {
    declareWar();
    const a = mockSubject(A, FIELD_M, { bot: true });
    const m = mockSubject(M, FIELD_M, { bot: true });
    assert.equal(WartimePvp.wartimeCanAttack(a, m, M), true);
  });
});

describe("war-end shutoff", () => {
  beforeEach(seed);

  it("ending the war switches every answer off the same call", () => {
    declareWar();
    const a = mockSubject(A, FIELD_M);
    const m = mockSubject(M, FIELD_M);
    assert.equal(WartimePvp.wartimeCanAttack(a, m, M), true);
    assert.equal(WartimePvp.isLawfulWarFight(a, m), true);
    assert.equal(WartimePvp.isHotGround(a, M), true);
    Store.endWar(A, M, "treaty");
    assert.equal(WartimePvp.wartimeCanAttack(a, m, M), null);
    assert.equal(WartimePvp.isLawfulWarFight(a, m), false);
    assert.equal(WartimePvp.isHotGround(a, M), false);
  });
});

describe("isLawfulWarFight (the crime-hook exclusion)", () => {
  beforeEach(seed);

  it("a cross-kingdom fight on wartime ground is lawful", () => {
    declareWar();
    assert.equal(
      WartimePvp.isLawfulWarFight(mockSubject(A, FIELD_M), mockSubject(M, FIELD_M)),
      true
    );
    assert.equal(
      WartimePvp.isLawfulWarFight(mockSubject(M, FIELD_A), mockSubject(A, FIELD_A)),
      true
    );
  });

  it("the same fight inside a town is still a crime", () => {
    declareWar();
    assert.equal(
      WartimePvp.isLawfulWarFight(mockSubject(A, TOWN_M), mockSubject(M, TOWN_M)),
      false
    );
  });

  it("the same fight on neutral ground is still a crime", () => {
    declareWar();
    assert.equal(
      WartimePvp.isLawfulWarFight(mockSubject(A, FIELD_K), mockSubject(M, FIELD_K)),
      false
    );
    assert.equal(
      WartimePvp.isLawfulWarFight(mockSubject(A, NOWHERE), mockSubject(M, NOWHERE)),
      false
    );
  });

  it("no war, no lawfulness", () => {
    assert.equal(
      WartimePvp.isLawfulWarFight(mockSubject(A, FIELD_M), mockSubject(M, FIELD_M)),
      false
    );
  });
});

describe("town and territory tables", () => {
  it("townSafeAt finds capitals and respects the radius", () => {
    assert.equal(WartimePvp.townSafeAt(TOWN_A)?.id, A);
    assert.equal(WartimePvp.townSafeAt(TOWN_M)?.id, M);
    assert.equal(WartimePvp.townSafeAt(FIELD_A), null);
    assert.equal(WartimePvp.townSafeAt(FIELD_M), null);
    // Upper floors of a surface town are part of the town.
    assert.equal(WartimePvp.townSafeAt({ ...TOWN_A, z: 2 })?.id, A);
    // The underground band is not Falador.
    assert.equal(WartimePvp.townSafeAt({ x: 2968, y: 10380, z: 0 }), null);
  });

  it("territoryAt resolves the kingdom rects", () => {
    assert.equal(WartimePvp.territoryAt(FIELD_A), A);
    assert.equal(WartimePvp.territoryAt(FIELD_M), M);
    assert.equal(WartimePvp.territoryAt(FIELD_K), K);
    assert.equal(WartimePvp.territoryAt(NOWHERE), null);
    assert.equal(WartimePvp.territoryAt({ x: 2859, y: 10202, z: 0 }), "keldagrim");
  });
});

describe("isHotGround (the client signal)", () => {
  beforeEach(seed);

  it("invaders and home defenders see hot ground; bystanders do not", () => {
    declareWar();
    assert.equal(WartimePvp.isHotGround(mockSubject(A, FIELD_M), M), true);
    assert.equal(WartimePvp.isHotGround(mockSubject(M, FIELD_M), M), true);
    assert.equal(WartimePvp.isHotGround(mockSubject(A, FIELD_A), A), true);
    assert.equal(WartimePvp.isHotGround(mockSubject(K, FIELD_A), A), false);
    assert.equal(WartimePvp.isHotGround(mockSubject(null, FIELD_A), A), false);
  });

  it("towns are never hot, and peace is never hot", () => {
    declareWar();
    assert.equal(WartimePvp.isHotGround(mockSubject(A, TOWN_M), M), false);
    Store.endWar(A, M, "treaty");
    assert.equal(WartimePvp.isHotGround(mockSubject(A, FIELD_M), M), false);
  });
});

describe("client Attack-option signal", () => {
  it("sends varbit + Attack on flip to hot, and clears on flip back", () => {
    const p = mockSubject(A, FIELD_M);
    WartimePvp.syncWartimeUi(p, true);
    assert.deepEqual(p.sent, [
      ["varbit", 5963, 1],
      ["option", "Attack", 2, true],
    ]);
    WartimePvp.syncWartimeUi(p, true); // steady state: no resend
    assert.equal(p.sent.length, 2);
    WartimePvp.syncWartimeUi(p, false);
    assert.deepEqual(p.sent.slice(2), [
      ["varbit", 5963, 0],
      ["option", "null", 2, true],
    ]);
  });

  it("bots never get the signal; logout clears state silently", () => {
    const bot = mockSubject(A, FIELD_M, { bot: true });
    WartimePvp.syncWartimeUi(bot, true);
    assert.equal(bot.sent.length, 0);

    const p = mockSubject(A, FIELD_M);
    WartimePvp.syncWartimeUi(p, true);
    assert.equal(p.sent.length, 2);
    WartimePvp.clearWartimeUi(p, true); // logout: no packets
    assert.equal(p.sent.length, 2);
    WartimePvp.syncWartimeUi(p, true); // state was cleared: sends again
    assert.equal(p.sent.length, 4);
    WartimePvp.clearWartimeUi(p, false); // area exit: clears visibly
    assert.deepEqual(p.sent.slice(4), [
      ["varbit", 5963, 0],
      ["option", "null", 2, true],
    ]);
  });
});

describe("Areas.Kingdoms wiring", () => {
  beforeEach(seed);

  function mockApi() {
    const areas = [];
    let startup = null;
    class MockArea {
      constructor(boundaries) {
        this.boundaries = boundaries;
      }
    }
    class MockBoundary {
      constructor(x1, x2, y1, y2, z) {
        Object.assign(this, { x1, x2, y1, y2, z });
      }
    }
    return {
      areas,
      runStartup: () => startup && startup(),
      core: { Area: MockArea, Boundary: MockBoundary },
      registerArea: (a) => areas.push(a),
      emitCustomEvent: () => {},
      onServerStartup: (fn) => {
        startup = fn;
      },
    };
  }

  it("each territory area enforces the matrix for its own ground", () => {
    const api = mockApi();
    attachAreas(api);
    api.runStartup();
    assert.equal(api.areas.length, 5);
    const [asgarnia, misthalin, kandarin] = api.areas;
    declareWar();
    const a = mockSubject(A, FIELD_M);
    const m = mockSubject(M, FIELD_M);
    assert.equal(misthalin.canAttack(a, m), true);
    assert.equal(asgarnia.canAttack(a, m), true);
    assert.equal(kandarin.canAttack(a, m), null);
    Store.endWar(A, M, "treaty");
    assert.equal(misthalin.canAttack(a, m), null);
  });

  it("process drives the signal and postLeave clears it", () => {
    const api = mockApi();
    attachAreas(api);
    api.runStartup();
    const [, misthalin] = api.areas;
    declareWar();
    const invader = mockSubject(A, FIELD_M);
    misthalin.process(invader);
    assert.deepEqual(invader.sent, [
      ["varbit", 5963, 1],
      ["option", "Attack", 2, true],
    ]);
    misthalin.process(invader); // standing still: nothing resent
    assert.equal(invader.sent.length, 2);
    misthalin.postLeave(invader, false);
    assert.deepEqual(invader.sent.slice(2), [
      ["varbit", 5963, 0],
      ["option", "null", 2, true],
      ["message", "You leave Misthalin."],
    ]);
  });
});
