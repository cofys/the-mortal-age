"use strict";

/**
 * StewardApi.test.js — steward's-desk overlay API contracts.
 *
 * Verifies the office list shape (title/vacant/holder), the influence number
 * readout, and that petition/vacate actions call through to the existing
 * Politics/Commands backends. Kingdom modules are stubbed in the require
 * cache so plain-node tests stay engine-free.
 *
 * Run: node server/plugins/interface/StewardApi.test.js
 */

const assert = require("node:assert/strict");
const path = require("node:path");

const IFACE = path.resolve(__dirname);

// --- stub kingdom modules in require.cache (before StewardApi loads) ---
function stub(rel, exports) {
  const p = path.resolve(IFACE, rel) + ".js";
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const petitionCalls = [];
const vacateCalls = [];
const renounceCalls = [];
const joinCalls = [];
const oathCalls = [];

stub("../kingdoms/Offices.Kingdoms", {
  getOffices: (kingdomId) => [
    { officeId: "steward", office: "steward", title: "Steward", kingdomId, holder: null },
    {
      officeId: "marshal", office: "marshal", title: "Marshal", kingdomId,
      holder: { kind: "player", ref: "TestUser" },
    },
    {
      officeId: "spymaster", office: "spymaster", title: "Spymaster", kingdomId,
      holder: { kind: "citizen", ref: "Some Citizen" },
    },
  ],
  getOffice: (id) => ({ officeId: id, title: id, kingdomId: "asgarnia" }),
  holderName: (h) => (h.kind === "player" ? h.ref : h.ref),
});
stub("../kingdoms/Politics.Kingdoms", {
  petition: (player, args) => { petitionCalls.push(args[0]); },
});
stub("../kingdoms/Commands.Kingdoms", {
  vacateOffice: (player, args) => { vacateCalls.push(args[0]); },
});
stub("../kingdoms/Influence.Kingdoms", {
  PETITION_THRESHOLD: 100,
  CHALLENGE_THRESHOLD: 250,
  effectiveInfluence: () => 42,
  getTrial: () => null,
});
stub("../kingdoms/KingdomStore", {
  getKingdom: (id) => ({ id, name: "Asgarnia", capital: "Falador" }),
  getKingdoms: () => [
    { id: "asgarnia", name: "Asgarnia" },
    { id: "misthalin", name: "Misthalin" },
  ],
});
stub("../kingdoms/Switching.Kingdoms", {
  renounce: (player, otherIds) => {
    renounceCalls.push({ player: player.getUsername(), otherIds });
    return { ok: true, oldKingdomId: "asgarnia", spreadTo: ["misthalin"] };
  },
  startNaturalization: (player, kingdomId) => {
    joinCalls.push({ player: player.getUsername(), kingdomId });
    return { ok: true, kingdomId, message: "Petition heard." };
  },
  takeOath: (player, kingdomId) => {
    oathCalls.push({ player: player.getUsername(), kingdomId });
    return { ok: true, kingdomId, message: "Oath sworn." };
  },
  naturalizationProgress: (player) =>
    player.getAttribute("kingdom:naturalization")
      ? { kingdomId: "misthalin", kingdomName: "Misthalin", oathReady: false, blockers: [] }
      : null,
});

const StewardApi = require(path.resolve(IFACE, "StewardApi.js"));

// --- mock plugin api + player ---
let endpointHandler = null;
const mockApi = {
  core: { World: { getPlayerByName: () => null } },
  persistAttribute: () => {},
  registerContentEndpoint: (name, handler) => { endpointHandler = handler; },
};

function mockPlayer(username, attrs = {}) {
  const store = { ...attrs };
  return {
    getUsername: () => username,
    getAttribute: (k) => store[k],
    setAttribute: (k, v) => { store[k] = v; },
    sendMessage: () => {},
    isPlayerBot: () => false,
    __store: store,
  };
}

function mockQuery(params) {
  const map = new Map(Object.entries(params));
  return { get: (key) => map.get(key) ?? null };
}

// ContentApiAuth.requireAuth needs a token; bypass by pre-seeding the player
// lookup path instead: use the non-authed read path with ?player=.
StewardApi.attach(mockApi);
assert(endpointHandler, "endpoint registered");

// --- closed when no steward:open ---
{
  const player = mockPlayer("TestUser", { "kingdom:id": "asgarnia" });
  mockApi.core.World.getPlayerByName = () => player;
  const res = endpointHandler(mockQuery({ player: "TestUser" }));
  assert.equal(res.open, false, "closed without steward:open");
  console.log("ok - closed when steward:open not set");
}

// --- open returns office list shape ---
{
  const player = mockPlayer("TestUser", { "kingdom:id": "asgarnia", "steward:open": "asgarnia" });
  mockApi.core.World.getPlayerByName = () => player;
  const res = endpointHandler(mockQuery({ player: "TestUser" }));
  assert.equal(res.open, true);
  assert.equal(res.kingdom.id, "asgarnia");
  assert.equal(res.kingdom.name, "Asgarnia");
  assert.equal(res.offices.length, 3);
  const steward = res.offices.find((o) => o.officeId === "steward");
  assert.equal(steward.title, "Steward");
  assert.equal(steward.vacant, true);
  assert.equal(steward.holderName, null);
  const marshal = res.offices.find((o) => o.officeId === "marshal");
  assert.equal(marshal.vacant, false);
  assert.equal(marshal.holderName, "TestUser");
  // held by player
  assert.equal(res.held.length, 1);
  assert.equal(res.held[0].officeId, "marshal");
  // influence numbers
  assert.equal(res.influence.value, 42);
  assert.equal(res.influence.petitionThreshold, 100);
  console.log("ok - office list shape, held list, influence numbers");
}

// --- petition calls through ---
{
  const player = mockPlayer("TestUser", { "kingdom:id": "asgarnia", "steward:open": "asgarnia" });
  // auth path: seed a token via ContentApiAuth is complex; call the handler
  // with the player resolved through the query-param fallback by using a
  // non-authed action shape — instead, directly verify the wiring by
  // invoking with a stubbed requireAuth. Simplest: temporarily allow the
  // fallback by calling with action but no token and a player param.
  // The endpoint requires auth for petition; emulate an authed session by
  // stubbing ContentApiAuth.requireAuth.
  const ContentApiAuth = require(path.resolve(IFACE, "ContentApiAuth.js"));
  const orig = ContentApiAuth.requireAuth;
  ContentApiAuth.requireAuth = () => player;
  petitionCalls.length = 0;
  const res = endpointHandler(mockQuery({ action: "petition", office: "steward" }));
  ContentApiAuth.requireAuth = orig;
  assert.equal(res.ok, true);
  assert.deepEqual(petitionCalls, ["steward"], "Politics.petition called with office id");
  console.log("ok - petition calls through to Politics.petition");
}

// --- vacate calls through ---
{
  const player = mockPlayer("TestUser", { "kingdom:id": "asgarnia", "steward:open": "asgarnia" });
  const ContentApiAuth = require(path.resolve(IFACE, "ContentApiAuth.js"));
  const orig = ContentApiAuth.requireAuth;
  ContentApiAuth.requireAuth = () => player;
  vacateCalls.length = 0;
  const res = endpointHandler(mockQuery({ action: "vacate", office: "marshal" }));
  ContentApiAuth.requireAuth = orig;
  assert.equal(res.ok, true);
  assert.deepEqual(vacateCalls, ["marshal"], "Commands.vacateOffice called with office id");
  console.log("ok - vacate calls through to Commands.vacateOffice");
}

// --- close clears the attribute ---
{
  const player = mockPlayer("TestUser", { "kingdom:id": "asgarnia", "steward:open": "asgarnia" });
  const ContentApiAuth = require(path.resolve(IFACE, "ContentApiAuth.js"));
  const orig = ContentApiAuth.requireAuth;
  ContentApiAuth.requireAuth = () => player;
  const res = endpointHandler(mockQuery({ action: "close" }));
  ContentApiAuth.requireAuth = orig;
  assert.equal(res.open, false);
  assert.equal(player.__store["steward:open"], "", "steward:open cleared");
  console.log("ok - close clears steward:open");
}

// --- foreign desk serves the desk's court, not the player's allegiance ---
{
  const player = mockPlayer("TestUser", { "kingdom:id": "asgarnia", "steward:open": "misthalin" });
  mockApi.core.World.getPlayerByName = () => player;
  const res = endpointHandler(mockQuery({ player: "TestUser" }));
  assert.equal(res.open, true);
  assert.equal(res.kingdom.id, "misthalin", "desk kingdom, not the player's");
  assert.equal(res.allegiance.id, "asgarnia", "player's own allegiance reported");
  assert.equal(res.naturalization, null, "no quest active");
  console.log("ok - foreign desk shows the desk's court");
}

// --- allegiance-free player sees an active naturalization quest ---
{
  const player = mockPlayer("TestUser", {
    "steward:open": "misthalin",
    "kingdom:naturalization": { kingdomId: "misthalin", startedAt: 123 },
  });
  mockApi.core.World.getPlayerByName = () => player;
  const res = endpointHandler(mockQuery({ player: "TestUser" }));
  assert.equal(res.open, true);
  assert.equal(res.allegiance, null);
  assert.equal(res.naturalization.kingdomId, "misthalin");
  console.log("ok - naturalization quest surfaced in the payload");
}

function withAuth(player, fn) {
  const ContentApiAuth = require(path.resolve(IFACE, "ContentApiAuth.js"));
  const orig = ContentApiAuth.requireAuth;
  ContentApiAuth.requireAuth = () => player;
  try {
    return fn();
  } finally {
    ContentApiAuth.requireAuth = orig;
  }
}

// --- renounce calls through to Switching.renounce ---
{
  const player = mockPlayer("TestUser", { "kingdom:id": "asgarnia", "steward:open": "asgarnia" });
  renounceCalls.length = 0;
  const res = withAuth(player, () => endpointHandler(mockQuery({ action: "renounce" })));
  assert.equal(res.ok, true);
  assert.equal(renounceCalls.length, 1);
  assert.deepEqual(renounceCalls[0].otherIds, ["misthalin"], "other kingdoms passed for word-spread");
  assert.deepEqual(res.spreadTo, ["misthalin"]);
  console.log("ok - renounce calls through to Switching.renounce");
}

// --- renounce refused at a foreign desk ---
{
  const player = mockPlayer("TestUser", { "kingdom:id": "asgarnia", "steward:open": "misthalin" });
  renounceCalls.length = 0;
  const res = withAuth(player, () => endpointHandler(mockQuery({ action: "renounce" })));
  assert.equal(res.ok, false);
  assert.equal(renounceCalls.length, 0, "no renounce at a foreign court");
  console.log("ok - renounce only at your own court's desk");
}

// --- petition-join and take-oath call through ---
{
  const player = mockPlayer("TestUser", { "steward:open": "misthalin" });
  joinCalls.length = 0;
  oathCalls.length = 0;
  const joinRes = withAuth(player, () => endpointHandler(mockQuery({ action: "petition-join" })));
  assert.equal(joinRes.ok, true);
  assert.deepEqual(joinCalls, [{ player: "TestUser", kingdomId: "misthalin" }]);
  const oathRes = withAuth(player, () => endpointHandler(mockQuery({ action: "take-oath" })));
  assert.equal(oathRes.ok, true);
  assert.deepEqual(oathCalls, [{ player: "TestUser", kingdomId: "misthalin" }]);
  console.log("ok - petition-join and take-oath call through");
}

console.log("All StewardApi tests passed.");
