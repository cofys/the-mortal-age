// CitizenSpies unit checks — pure logic + mission state machine, no running server.
const assert = require("node:assert/strict");
const S = require("./CitizenSpies");

function loc(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
function mockPlayer(name, x, y, opts = {}) {
  return {
    getUsername: () => name,
    isPlayerBot: () => !!opts.bot,
    getHostAddress: () => (opts.botHost ? "bot" : "127.0.0.1"),
    getLocation: () => loc(x, y, opts.z ?? 0),
    forceChat: () => {},
    sendMessage: () => {},
    getInventory: opts.noInv
      ? undefined
      : () => ({
          getAmount: () => opts.coins ?? 0,
          // Canonical ItemContainer API: deleteNumber(id, amount) actually
          // reduces the mock balance so the balance-verification in
          // chargeCoins passes. There is no inv.removes on ItemContainer.
          deleteNumber: (id, qty) => {
            opts.coins = Math.max(0, (opts.coins ?? 0) - qty);
            opts.removed = [id, qty];
          },
          adds: (id, qty) => {
            opts.coins = (opts.coins ?? 0) + qty;
            opts.added = [id, qty];
          },
        }),
  };
}

let passed = 0;
function check(name, fn) {
  S._resetForTests();
  fn();
  passed++;
  console.log("ok -", name);
}

// --- cover identities ---
check("coverFor is deterministic per citizen", () => {
  assert.equal(S.coverFor("Ada Miller"), S.coverFor("ada miller"));
  assert.equal(S.coverFor("Ada Miller"), S.coverFor("Ada Miller"));
});

check("coverFor differs between citizens", () => {
  assert.notEqual(S.coverFor("Ada Miller"), S.coverFor("Zed Novak"));
});

check("spyRole cycles informant/infiltrator/courier", () => {
  assert.equal(S.spyRole(0), "informant");
  assert.equal(S.spyRole(1), "infiltrator");
  assert.equal(S.spyRole(2), "courier");
  assert.equal(S.spyRole(3), "informant");
});

check("missionsForRole gives each role sensible missions", () => {
  assert.ok(S.missionsForRole("informant").includes("eavesdrop"));
  assert.ok(S.missionsForRole("informant").includes("counter_intelligence"));
  assert.ok(S.missionsForRole("infiltrator").includes("sabotage"));
  assert.ok(!S.missionsForRole("courier").includes("sabotage"));
});

// --- mission targeting ---
check("missionTarget picks the hottest border", () => {
  const tensionOf = (a, b) => ({ asgarnia: 0, kandarin: 40, misthalin: 10 }[b] ?? 0);
  const t = S.missionTarget("morytania", ["morytania", "asgarnia", "kandarin", "misthalin"], tensionOf, () => 0);
  assert.equal(t, "kandarin");
});

check("missionTarget breaks ties with rng", () => {
  const tensionOf = () => 5;
  const ids = ["morytania", "asgarnia", "kandarin"];
  const first = S.missionTarget("morytania", ids, tensionOf, () => 0);
  const last = S.missionTarget("morytania", ids, tensionOf, () => 0.999);
  assert.equal(first, "asgarnia");
  assert.equal(last, "kandarin");
});

check("missionTarget never targets home", () => {
  const t = S.missionTarget("asgarnia", ["asgarnia"], () => 0, () => 0);
  assert.equal(t, null);
});

// --- success / detection chances ---
check("successChance is bounded and trait/tension sensitive", () => {
  const steady = S.successChance("steal_documents", ["methodical", "taciturn"], 0);
  const slip = S.successChance("steal_documents", ["chatty", "clumsy"], 0);
  assert.ok(steady > slip, "steady traits should beat slippery traits");
  const hot = S.successChance("steal_documents", [], 100);
  const cold = S.successChance("steal_documents", [], 0);
  assert.ok(hot < cold, "hot borders are harder");
  assert.ok(steady >= 0.05 && steady <= 0.95);
  assert.ok(S.successChance("sabotage", ["chatty", "clumsy", "fidgety", "proud", "cheerful"], 500) >= 0.05);
});

check("detectionChance is bounded and rises with tension", () => {
  const low = S.detectionChance("eavesdrop", ["methodical"], 0);
  const high = S.detectionChance("eavesdrop", ["chatty"], 100);
  assert.ok(high > low, "slippery traits on hot borders are riskier");
  assert.ok(low >= 0.02 && high <= 0.8);
  const worst = S.detectionChance("sabotage", ["chatty", "clumsy", "fidgety"], 1000);
  assert.ok(worst <= 0.8, "detection caps at 0.8");
});

check("resolveMission honors detection first", () => {
  assert.equal(S.resolveMission(() => 0, 1, 1), "detected");
  assert.equal(S.resolveMission(() => 0, 1, 0), "success");
  assert.equal(S.resolveMission(() => 0.999, 0, 0), "failed");
});

// --- whisper gating ---
check("shouldWhisper respects cooldown and chance", () => {
  const now = 1_800_000_000_000; // realistic Date.now()-scale
  assert.equal(S.shouldWhisper(() => 0, now - 1000, now), false, "cooldown blocks");
  assert.equal(S.shouldWhisper(() => 0, 0, now), true, "never whispered + lucky roll");
  assert.equal(S.shouldWhisper(() => 0.999, 0, now), false, "unlucky roll");
});

// --- player / distance helpers ---
check("isRealPlayer filters bots", () => {
  assert.equal(S.isRealPlayer(null), false);
  assert.equal(S.isRealPlayer(mockPlayer("P", 0, 0, { bot: true })), false);
  assert.equal(S.isRealPlayer(mockPlayer("P", 0, 0, { botHost: true })), false);
  assert.equal(S.isRealPlayer(mockPlayer("P", 0, 0)), true);
});

check("withinTiles uses Chebyshev distance on the same plane", () => {
  const a = mockPlayer("A", 100, 100);
  assert.equal(S.withinTiles(a, mockPlayer("B", 105, 103), 5), true);
  assert.equal(S.withinTiles(a, mockPlayer("B", 106, 100), 5), false);
  assert.equal(S.withinTiles(a, mockPlayer("B", 100, 100, { z: 1 }), 5), false);
});

// --- coins ---
check("chargeCoins is defensive", () => {
  assert.equal(S.chargeCoins(null, 100), false);
  const broke = mockPlayer("P", 0, 0, { coins: 10 });
  assert.equal(S.chargeCoins(broke, 100), false, "insufficient funds");
  const rich = mockPlayer("P", 0, 0, { coins: 1000 });
  assert.equal(S.chargeCoins(rich, 500), true);
  assert.deepEqual(rich && undefined, undefined); // placeholder no-op
});

check("chargeCoins reduces the balance and refuses the broke", () => {
  const opts = { coins: 1000 };
  const rich = mockPlayer("P", 0, 0, opts);
  assert.equal(S.chargeCoins(rich, 1200), false, "broke refuses");
  assert.equal(opts.coins, 1000, "failed charge must not touch the balance");
  assert.equal(S.chargeCoins(rich, 300), true);
  assert.equal(opts.coins, 700, "balance reduced by the charge");
});

check("payCoins pays via adds", () => {
  const opts = {};
  const p = mockPlayer("P", 0, 0, opts);
  assert.equal(S.payCoins(p, 150), true);
  assert.deepEqual(opts.added, [995, 150]);
});

// --- mission lifecycle ---
function directorWith(courtiers, extra = {}) {
  const roster = new Map();
  for (const c of courtiers) roster.set(c.username.toLowerCase(), c);
  return {
    roster,
    api: { emitCustomEvent: () => {} },
    playerFor: () => null,
    onlinePlayers: () => [],
    ...extra,
  };
}

check("tickSpies advances a briefed mission to operating", () => {
  const now = 10_000_000;
  const mission = {
    id: "spy_test_1",
    homeId: "asgarnia",
    targetId: "kandarin",
    operative: "Ada Miller",
    cover: "Ash Wren",
    role: "informant",
    kind: "eavesdrop",
    traits: ["methodical"],
    phase: "briefed",
    phaseUntil: now - 1,
  };
  S._missions.set(mission.id, mission);
  S.tickSpies(directorWith([]), now);
  assert.equal(S._missions.get("spy_test_1").phase, "operating");
});

check("tickSpies resolves operating missions into debrief", () => {
  const now = 10_000_000;
  const mission = {
    id: "spy_test_2",
    homeId: "asgarnia",
    targetId: "kandarin",
    operative: "Ada Miller",
    cover: "Ash Wren",
    role: "informant",
    kind: "eavesdrop",
    traits: ["methodical"],
    phase: "operating",
    phaseUntil: now - 1,
  };
  S._missions.set(mission.id, mission);
  const courtiers = [
    { username: "Ada Miller", kingdomId: "asgarnia", role: "courtier", personality: { traits: ["methodical"] } },
  ];
  S.tickSpies(directorWith(courtiers), now);
  assert.equal(S._missions.get("spy_test_2").phase, "debrief");
});

check("tickSpies retires debriefed missions", () => {
  const now = 10_000_000;
  S._missions.set("spy_test_3", {
    id: "spy_test_3",
    homeId: "asgarnia",
    targetId: "kandarin",
    operative: "Ada Miller",
    cover: "Ash Wren",
    role: "informant",
    kind: "eavesdrop",
    traits: [],
    phase: "debrief",
    phaseUntil: now - 1,
  });
  S.tickSpies(directorWith([]), now);
  assert.equal(S._missions.has("spy_test_3"), false);
});

check("a burned operative lies low and cannot start missions", () => {
  const now = 10_000_000;
  // Burned timestamp is consulted in startMission; simulate many ticks with
  // only a burned courtier available — no mission should start.
  const courtiers = [
    { username: "Burned Spy", kingdomId: "asgarnia", role: "courtier", personality: { traits: [] } },
  ];
  S._burned.set("burned spy", now + 600_000); // burned for 10 minutes
  // Run ticks inside the burn window: no mission should start.
  for (let i = 0; i < 8; i++) {
    S.tickSpies(directorWith(courtiers), now + i * 61_000);
  }
  const started = [...S._missions.values()].filter((m) => m.operative === "Burned Spy");
  assert.equal(started.length, 0, "burned operative starts no missions");
});

// --- asset invites ---
check("acceptSpyInvite registers an asset on yes", () => {
  const Bonds = require("./CitizenBonds");
  Bonds.sendInvite("Handler Hal", "Player Pete", "spy_asset", { homeId: "asgarnia" });
  const invite = S.acceptSpyInvite("Player Pete", "Handler Hal");
  assert.ok(invite, "invite accepted");
  assert.ok(S._assets.has("player pete"));
  assert.equal(S._assets.get("player pete").owed, 100);
});

check("declineSpyInvite clears the invite without registering", () => {
  const Bonds = require("./CitizenBonds");
  Bonds.sendInvite("Handler Hal", "Player Pam", "spy_asset", { homeId: "asgarnia" });
  const invite = S.declineSpyInvite("Player Pam", "Handler Hal");
  assert.ok(invite, "invite declined");
  assert.ok(!S._assets.has("player pam"));
});

check("acceptSpyInvite dossier charges coins before resolving", () => {
  const Bonds = require("./CitizenBonds");
  Bonds.sendInvite("Handler Hal", "Player Pat", "spy_dossier", { price: 500, about: "kandarin" });
  const broke = mockPlayer("Player Pat", 0, 0, { coins: 10 });
  const denied = S.acceptSpyInvite("Player Pat", "Handler Hal", broke);
  assert.equal(denied, null, "no coins, no dossier");
  const rich = mockPlayer("Player Pat", 0, 0, { coins: 1000 });
  const ok = S.acceptSpyInvite("Player Pat", "Handler Hal", rich);
  assert.ok(ok, "dossier sold");
});

check("tickSpies never throws with an empty director", () => {
  S.tickSpies({}, 10_000_000);
  S.tickSpyShouts({}, 10_000_000);
});

console.log(`\n${passed} checks passed`);
