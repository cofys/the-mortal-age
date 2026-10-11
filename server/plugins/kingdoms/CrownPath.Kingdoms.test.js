"use strict";

/**
 * CrownPath — the end-to-end audit of the claim "a player can rise
 * influence -> rank -> office -> succession -> crown in an existing
 * kingdom" (2026-10-11 overnight audit).
 *
 * The full path is exercised for a test player against the REAL modules
 * wired through a mock event bus (the same kingdom:* contract the live
 * server uses): Membership/Events apply rank grants, Politics runs the
 * court, SuccessionCrisis runs the succession, Events lands the crown in
 * KingdomStore.
 *
 * Findings encoded here (see the audit runlog):
 *   - Influence, rank (to Regent), office petitions/challenges/trials and
 *     the 14-day tenure gate all work as designed.
 *   - The succession ENGINE works: in a non-exempt kingdom a player office
 *     holder becomes a claimant and can be crowned, peacefully or out of
 *     a civil war, and kingdom:ruler lands on the player's name.
 *   - But all five great powers are lore-exempt from SuccessionCrisis
 *     (Misthalin by id; Roald / Lathas / Lowerniel / Amik Varze / the
 *     Consortium by ruler name), so in the live game the succession event
 *     NEVER fires and the crown link is unreachable — a design gap for
 *     Jon's call, proven by the exemption test below.
 *   - Nothing grants a crowned player the Monarch rank/title or vacates
 *     their office: what coronation does to the player is undesigned.
 *   - Office holders were kept only in the in-memory registry and lost
 *     on every restart (Seed reseated AI). Fixed: Events mirrors seats
 *     into KingdomStore and Seed restores them (persistence test below).
 */
const assert = require("node:assert/strict");
const { describe, it, before } = require("node:test");
const Module = require("node:module");

// Some kingdoms modules transitively require the TS Task class; stub it
// (same pattern as Jobs.Kingdoms.test.js).
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../src/main/typescript/elvarg/game/task/Task") {
    return { Task: class Task {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Store = require("./KingdomStore");
const Offices = require("./Offices.Kingdoms");
const Influence = require("./Influence.Kingdoms");
const Membership = require("./Membership.Kingdoms");
const Politics = require("./Politics.Kingdoms");
const Succession = require("./SuccessionCrisis.Kingdoms");
const Seed = require("./Seed.Kingdoms");

const DAY_MS = 24 * 60 * 60 * 1000;
const KID = "crownmark";
const KID2 = "crownmark2";
const KID3 = "crownmark3";
const KID4 = "crownmark4";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function mockPlayer(name, coins = 0) {
  const attrs = {};
  const inv = { 995: coins };
  const messages = [];
  return {
    username: name,
    messages,
    getUsername: () => name,
    isPlayerBot: () => false,
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    getInventory: () => ({
      getAmount: (id) => inv[id] ?? 0,
      delete: (id, n) => {
        inv[id] = Math.max(0, (inv[id] ?? 0) - n);
      },
      refreshItems: () => {},
    }),
    sendMessage: (m) => messages.push(String(m)),
    _attrs: attrs,
    _inv: inv,
  };
}

/** A plugin-api double with a synchronous kingdom:* event bus. */
function mockApi(playersByName = {}) {
  const handlers = new Map();
  const api = {
    _startup: null,
    onCustomEvent: (name, fn) =>
      handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    emitCustomEvent: (name, payload) => {
      for (const fn of handlers.get(name) ?? []) fn(payload);
    },
    persistAttribute: () => {},
    registerCommand: () => {},
    onServerStartup: (fn) => {
      api._startup = fn;
    },
    core: {
      PlayerRights: { NONE: 0, OWNER: 3 },
      World: {
        getPlayerByName: (n) => playersByName[n] ?? null,
        getPlayers: () => ({ stream: () => Object.values(playersByName) }),
      },
    },
    getTaskManager: () => null,
  };
  return api;
}

/** Attach the progression modules to one bus, as Kingdoms.plugin.js does. */
function wireKingdomBus(api) {
  require("./Influence.Kingdoms")(api);
  require("./Switching.Kingdoms")(api);
  require("./Membership.Kingdoms")(api);
  require("./Politics.Kingdoms")(api);
  require("./Events.Kingdoms")(api);
}

/** A mock store for SuccessionCrisis' pure functions (house pattern). */
function mockCrisisStore(kingdoms) {
  const state = {
    kingdoms,
    succession: { crises: [], civilWars: [], reigns: {} },
  };
  return { load: () => state, save: () => {}, _state: () => state };
}

function seqRng(...values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0.5);
}

function defineOffices(kingdomId, offices) {
  for (const office of offices) {
    Offices.defineOffice({
      kingdomId,
      office,
      title: office[0].toUpperCase() + office.slice(1),
      description: "test office",
    });
  }
}

// ---------------------------------------------------------------------------
// The full path
// ---------------------------------------------------------------------------

describe("CrownPath — influence -> rank -> office -> succession -> crown", () => {
  const player = mockPlayer("Crowntester", 60000);
  const api = mockApi({ Crowntester: player });

  before(() => {
    Store.resetForTests();
    Store.upsertKingdom({
      id: KID,
      name: "Crownmark",
      capital: "Testhold",
      ruler: "Old King Aldric",
      rulerTitle: "King",
      hierarchy: Seed.DEFAULT_HIERARCHY,
      treasury: 100000,
    });
    wireKingdomBus(api);
    // The court of Crownmark: steward (the player's target) and
    // quartermaster are AI-held; marshal and spymaster stand vacant.
    defineOffices(KID, ["steward", "quartermaster", "marshal", "spymaster"]);
    Offices.assignOffice(`${KID}:steward`, { kind: "ai", ref: `${KID}:steward` });
    Offices.assignOffice(`${KID}:quartermaster`, {
      kind: "ai",
      ref: `${KID}:quartermaster`,
    });
  });

  it("link 1+2: fealty seats the subject; donations earn influence and rank", () => {
    Membership.joinKingdom(player, KID);
    assert.equal(player.getAttribute(Membership.KINGDOM_ID_ATTRIBUTE), KID);
    assert.equal(player.getAttribute(Membership.KINGDOM_RANK_ATTRIBUTE), "Subject");
    assert.ok(Influence.effectiveInfluence(player, KID) >= 10, "fealty grants +10");

    // 40,000 coins of war-effort donations: +400 influence, two promotions.
    assert.equal(Politics.donateToKingdom(player, KID, 40000), true);
    assert.ok(
      Influence.effectiveInfluence(player, KID) >= Influence.CHALLENGE_THRESHOLD,
      `influence ${Influence.effectiveInfluence(player, KID)} clears the challenge threshold`
    );
    assert.equal(
      player.getAttribute(Membership.KINGDOM_RANK_ATTRIBUTE),
      "Knight",
      "service promotes Subject -> Man-at-arms -> Knight"
    );
    // The rank ladder tops out at Regent: Monarch is never earned.
    assert.equal(Influence.rankForInfluence(99999), "Regent");
  });

  it("link 3 gate: the 14-day tenure gate refuses a fresh oath's petition", () => {
    Politics.petition(player, [`${KID}:steward`]);
    assert.equal(
      Offices.holderOf(`${KID}:steward`)?.ref,
      `${KID}:steward`,
      "the AI steward keeps the seals"
    );
    assert.ok(
      player.messages.some((m) => m.includes("still fresh")),
      "the refusal names the fresh oath"
    );
    // Fourteen days pass.
    player.setAttribute("kingdom:oath-at", Date.now() - 15 * DAY_MS);
  });

  it("link 3: a proven subject challenges the AI steward and takes the seals", () => {
    Politics.petition(player, [`${KID}:steward`]);
    const holder = Offices.holderOf(`${KID}:steward`);
    assert.deepEqual(holder, { kind: "player", ref: "Crowntester" });
    assert.ok(
      (player.getAttribute(Membership.KINGDOM_TITLES_ATTRIBUTE) ?? []).includes("Steward"),
      "the office title lands as an honorific"
    );
    // The fix: the seat is mirrored into the persisted holder map.
    assert.deepEqual(Store.getOfficeHolders()[`${KID}:steward`], {
      kind: "player",
      ref: "Crowntester",
    });
  });

  it("link 4+5: the old king dies, the player-officeholder is crowned, the store lands it", () => {
    const crisisStore = mockCrisisStore({
      [KID]: {
        id: KID,
        name: "Crownmark",
        ruler: "Old King Aldric",
        rulerTitle: "King",
        treasury: 50000,
        flags: { "succession:reign-since": Date.now() - 400 * DAY_MS },
        foundedAt: Date.now() - 500 * DAY_MS,
      },
    });
    // Death roll succeeds (0.001 < capped 0.003); no deathbed heir (0.9).
    const deathEvents = Succession.councilSuccessionTick(crisisStore, {
      rng: seqRng(0.001, 0.9),
    });
    assert.ok(deathEvents.some((e) => e.type === "ruler-died"));
    // NB: the crisis readers take a state object; tick/backClaimant take a store.
    assert.equal(Succession.inSuccessionCrisis(KID, crisisStore.load()), true);

    const summary = Succession.crisisSummary(KID, crisisStore);
    const mine = summary.claimants.find((c) => c.name === "Crowntester");
    assert.ok(mine, "the player office holder stands as a claimant");
    assert.equal(summary.claimants.length, 2, "only seated holders press claims");

    // The player backs their own claim: -30 influence, +12 strength.
    const backed = Succession.backClaimant(player, KID, mine.id, {
      load: crisisStore.load,
      save: crisisStore.save,
    });
    assert.equal(backed.ok, true);

    // Run the crisis clock out with a neutral rng: the player's share
    // (52 of 85) clears the 60% peaceful-coronation bar.
    const crisis = crisisStore._state().succession.crises[0];
    crisis.ticksLeft = 1;
    const events = Succession.councilSuccessionTick(crisisStore, { rng: () => 0.5 });
    const crowned = events.find((e) => e.type === "ruler-changed");
    assert.ok(crowned, "the crisis resolves in a coronation");
    assert.equal(crowned.newRuler, "Crowntester");

    // The crown lands through the real event wiring.
    api.emitCustomEvent("kingdom:ruler-changed", {
      kingdomId: KID,
      newRuler: crowned.newRuler,
      newTitle: crowned.newTitle ?? null,
    });
    assert.equal(Store.getKingdom(KID).ruler, "Crowntester");

    // Design-gap evidence: coronation changes nothing for the player —
    // no Monarch rank is granted and the office is not vacated.
    assert.notEqual(player.getAttribute(Membership.KINGDOM_RANK_ATTRIBUTE), "Monarch");
    assert.deepEqual(Offices.holderOf(`${KID}:steward`), {
      kind: "player",
      ref: "Crowntester",
    });
  });
});

// ---------------------------------------------------------------------------
// The civil-war exit also crowns a player claimant
// ---------------------------------------------------------------------------

describe("CrownPath — civil war exit", () => {
  it("a deadlocked crisis goes to war and the stronger claimant takes the crown", () => {
    Store.upsertKingdom({
      id: KID2,
      name: "Crownmark Two",
      capital: "Testhold",
      ruler: "Old Queen Berta",
      rulerTitle: "Queen",
      hierarchy: Seed.DEFAULT_HIERARCHY,
      treasury: 50000,
    });
    defineOffices(KID2, ["steward", "quartermaster", "marshal"]);
    Offices.assignOffice(`${KID2}:steward`, { kind: "player", ref: "Warmarshal" });
    Offices.assignOffice(`${KID2}:quartermaster`, { kind: "ai", ref: `${KID2}:quartermaster` });
    Offices.assignOffice(`${KID2}:marshal`, { kind: "ai", ref: `${KID2}:marshal` });

    const crisisStore = mockCrisisStore({
      [KID2]: {
        id: KID2,
        name: "Crownmark Two",
        ruler: "Old Queen Berta",
        rulerTitle: "Queen",
        treasury: 50000,
        flags: { "succession:reign-since": Date.now() - 400 * DAY_MS },
        foundedAt: Date.now() - 500 * DAY_MS,
      },
    });
    Succession.councilSuccessionTick(crisisStore, { rng: seqRng(0.001, 0.9) });
    assert.equal(Succession.inSuccessionCrisis(KID2, crisisStore.load()), true);

    // No claimant near 60%: the crisis deadlocks into civil war.
    const crisis = crisisStore._state().succession.crises[0];
    crisis.ticksLeft = 1;
    const warEvents = Succession.councilSuccessionTick(crisisStore, { rng: () => 0.5 });
    assert.ok(warEvents.some((e) => e.type === "civil-war-started"));
    assert.equal(Succession.inCivilWar(KID2, crisisStore.load()), true);

    const war = crisisStore._state().succession.civilWars[0];
    assert.ok(war.sides.some((s) => s.name === "Warmarshal"), "the player claimant leads a side");
    war.ticksLeft = 1;
    const endEvents = Succession.councilSuccessionTick(crisisStore, { rng: () => 0.5 });
    const crowned = endEvents.find((e) => e.type === "ruler-changed");
    assert.ok(crowned, "the civil war ends in a coronation");
    assert.equal(crowned.newRuler, "Warmarshal");
  });
});

// ---------------------------------------------------------------------------
// Office link, second door: the trial of service
// ---------------------------------------------------------------------------

describe("CrownPath — trial of service", () => {
  it("a close challenge earns a trial; 5,000 donated coins complete it", () => {
    const trialist = mockPlayer("Trialist", 30000);
    const api2 = mockApi({ Trialist: trialist });
    wireKingdomBus(api2);
    Store.upsertKingdom({
      id: KID3,
      name: "Crownmark Three",
      capital: "Testhold",
      ruler: "Old King Cedric",
      rulerTitle: "King",
      hierarchy: Seed.DEFAULT_HIERARCHY,
      treasury: 100000,
    });
    defineOffices(KID3, ["steward"]);
    Offices.assignOffice(`${KID3}:steward`, { kind: "ai", ref: `${KID3}:steward` });

    Membership.joinKingdom(trialist, KID3);
    trialist.setAttribute("kingdom:oath-at", Date.now() - 15 * DAY_MS);
    // 10 (fealty) + 215 (donations) + 25 (Man-at-arms promotion) = 250:
    // exactly at the hearing threshold, inside the trial band of the AI
    // steward's 180 standing, short of the 255 outright-grant margin.
    assert.equal(Politics.donateToKingdom(trialist, KID3, 21500), true);
    const influence = Influence.effectiveInfluence(trialist, KID3);
    assert.ok(influence >= Influence.CHALLENGE_THRESHOLD, `influence ${influence} can be heard`);
    assert.ok(influence < 180 + 75, "but cannot take the seals outright");

    Politics.petition(trialist, [`${KID3}:steward`]);
    const trial = Influence.getTrial(trialist);
    assert.ok(trial, "the court sets a trial of service");
    assert.equal(trial.target, Politics.TRIAL_TARGET_COINS);

    assert.equal(Politics.donateToKingdom(trialist, KID3, 5000), true);
    assert.deepEqual(Offices.holderOf(`${KID3}:steward`), {
      kind: "player",
      ref: "Trialist",
    });
  });

  it("a vacant office appoints on the petition threshold alone", () => {
    const petitioner = mockPlayer("Petitioner", 0);
    const api3 = mockApi({ Petitioner: petitioner });
    wireKingdomBus(api3);
    Store.upsertKingdom({
      id: KID4,
      name: "Crownmark Four",
      capital: "Testhold",
      ruler: "Old King Dain",
      rulerTitle: "King",
      hierarchy: Seed.DEFAULT_HIERARCHY,
      treasury: 100000,
    });
    defineOffices(KID4, ["steward"]); // never seated: the office stands vacant

    Membership.joinKingdom(petitioner, KID4);
    petitioner.setAttribute("kingdom:oath-at", Date.now() - 15 * DAY_MS);
    Influence.addInfluence(petitioner, KID4, 100);
    Politics.petition(petitioner, [`${KID4}:steward`]);
    assert.deepEqual(Offices.holderOf(`${KID4}:steward`), {
      kind: "player",
      ref: "Petitioner",
    });
  });
});

// ---------------------------------------------------------------------------
// The exemption wall: why the crown is unreachable in the live game
// ---------------------------------------------------------------------------

describe("CrownPath — the five great powers are lore-exempt", () => {
  it("no succession event ever fires for any seeded kingdom", () => {
    const seeded = Seed.GREAT_POWERS.map((def) => [
      def.id,
      {
        id: def.id,
        name: def.name,
        ruler: def.ruler,
        rulerTitle: def.rulerTitle,
        treasury: def.treasury,
        flags: {},
        foundedAt: Date.now() - 900 * DAY_MS,
      },
    ]);
    const crisisStore = mockCrisisStore(Object.fromEntries(seeded));
    // rng 0 forces every fate roll to fire if the code ever rolls one.
    for (let i = 0; i < 25; i++) {
      const events = Succession.councilSuccessionTick(crisisStore, { rng: () => 0 });
      assert.equal(events.length, 0, `tick ${i} produced ${JSON.stringify(events)}`);
    }
    for (const def of Seed.GREAT_POWERS) {
      assert.equal(Succession.inSuccessionCrisis(def.id, crisisStore.load()), false);
      assert.equal(crisisStore._state().kingdoms[def.id].ruler, def.ruler);
    }
  });
});

// ---------------------------------------------------------------------------
// The restart fix: office holders survive a reboot
// ---------------------------------------------------------------------------

describe("CrownPath — office holders persist across restarts", () => {
  it("Events mirrors seats into the store and clears them on vacate", () => {
    const api4 = mockApi({});
    wireKingdomBus(api4);
    Offices.defineOffice({
      kingdomId: "asgarnia",
      office: "marshal",
      title: "Marshal",
      description: "test",
    });
    api4.emitCustomEvent("kingdom:office-assigned", {
      officeId: "asgarnia:marshal",
      kingdomId: "asgarnia",
      holder: { kind: "player", ref: "Newholder" },
    });
    assert.deepEqual(Store.getOfficeHolders()["asgarnia:marshal"], {
      kind: "player",
      ref: "Newholder",
    });
    api4.emitCustomEvent("kingdom:office-vacated", {
      officeId: "asgarnia:marshal",
      kingdomId: "asgarnia",
    });
    assert.equal(Store.getOfficeHolders()["asgarnia:marshal"], undefined);
  });

  it("Seed restores a persisted player holder instead of reseating AI", () => {
    Store.setOfficeHolder("asgarnia:steward", { kind: "player", ref: "Restarter" });
    const api5 = mockApi({});
    require("./Seed.Kingdoms")(api5);
    assert.equal(typeof api5._startup, "function");
    api5._startup();
    assert.deepEqual(Offices.holderOf("asgarnia:steward"), {
      kind: "player",
      ref: "Restarter",
    });
    // A seat with no persisted holder still falls back to the AI identity.
    assert.deepEqual(Offices.holderOf("asgarnia:quartermaster"), {
      kind: "ai",
      ref: "asgarnia:quartermaster",
    });
  });
});
