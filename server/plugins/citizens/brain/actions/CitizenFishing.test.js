"use strict";

/**
 * CitizenFishing unit checks — real catches for actively-fishing citizens.
 *
 * Proves the brain action's contracts without a running server:
 *   - LOD gate: only materialized citizens (isOnline + getBot) in arrived
 *     fishing sessions can catch.
 *   - Spot gate: no real fishing-spot NPC in range -> no catch.
 *   - Real APIs: items via inventory.adds(id, amount), XP via
 *     skillManager.addExperiences(Skill.FISHING, xp) — the exact engine
 *     method names, verified against ItemContainer.ts / SkillManager.ts.
 *   - Inventory-full: no catch granted (the decision layer's citizen_bank
 *     scoring owns that state).
 *   - Per-citizen catch cadence: one attempt per window, then cooldown.
 *   - Tick-safe: one throwing citizen never breaks the rest.
 *
 * The Fishing plugin is injected as a mock (the real one needs the TS
 * engine); its mock mirrors the real export shape (TOOLS, getSpotTool,
 * rollCatch).
 */
const assert = require("node:assert/strict");

const {
  tickCitizenFishing,
  _resetForTests,
  _nextCatchAt,
} = require("./CitizenFishing");

const FISHING_SKILL = { name: "Fishing" }; // stands in for api.core.Skill.FISHING
const SHRIMPS = 317;
const SHRIMP_XP = 10;

function mockFish() {
  return {
    id: SHRIMPS,
    experience: SHRIMP_XP,
    caught: "some raw shrimps",
    amount: () => 1,
    extraXp: [],
  };
}

function mockFishingPlugin({ caught = [mockFish()], toolLevel = 1 } = {}) {
  const tool = { id: 303, level: toolLevel, animation: 621, fish: [] };
  return {
    TOOLS: { NET: { id: 303 } },
    getSpotTool: () => tool,
    rollCatch: () => caught,
    __tool: tool,
  };
}

function mockNpc({ x = 3002, y = 3201, id = 3317 } = {}) {
  return {
    getId: () => id,
    getLocation: () => ({ getX: () => x, getY: () => y }),
    getDefinition: () => ({ getActions: () => ["Net", null, null, null, null] }),
  };
}

function mockInventory({ full = false } = {}) {
  const calls = [];
  return {
    calls,
    isFull: () => full,
    getFreeSlots: () => (full ? 0 : 28),
    adds: (id, amount) => {
      calls.push(["adds", id, amount]);
    },
  };
}

function mockSkillManager({ level = 1 } = {}) {
  const calls = [];
  return {
    calls,
    getCurrentLevel: () => level,
    addExperiences: (skill, xp) => {
      calls.push(["addExperiences", skill, xp]);
    },
  };
}

function mockBot({ x = 3000, y = 3200, npc = mockNpc(), invFull = false, level = 1 } = {}) {
  const inv = mockInventory({ full: invFull });
  const sm = mockSkillManager({ level });
  return {
    __inv: inv,
    __sm: sm,
    getLocation: () => ({ getX: () => x, getY: () => y }),
    getLocalNpcs: () => (npc ? [npc] : []),
    getInventory: () => inv,
    getSkillManager: () => sm,
  };
}

function mockDirector({ bots = {}, online = true } = {}) {
  const roster = new Map(Object.entries(bots).map(([u, b]) => [u, { username: u, bot: b }]));
  return {
    roster,
    isOnline: () => online,
    getBot: (record) => record.bot ?? null,
    api: { core: { Skill: { FISHING: FISHING_SKILL } } },
  };
}

function fishingSession(members = ["Bob"]) {
  return new Map([
    [
      "bob",
      {
        skill: "fishing",
        arrived: true,
        members,
        site: { x: 3000, y: 3200, z: 0 },
        items: 0,
        xp: 0,
      },
    ],
  ]);
}

function runTick({ director, sessions, fishing, nowMs = 1_000_000 }) {
  _resetForTests();
  tickCitizenFishing(director, { sessions, fishing, nowMs });
}

// --- tests -------------------------------------------------------------------

{
  // 1. Happy path: materialized citizen, arrived fishing session, real spot
  //    nearby -> real item + real XP via the exact engine APIs.
  const bot = mockBot();
  const director = mockDirector({ bots: { Bob: bot } });
  const sessions = fishingSession();
  runTick({ director, sessions, fishing: mockFishingPlugin() });
  assert.deepEqual(bot.__inv.calls, [["adds", SHRIMPS, 1]], "grants the raw fish via inventory.adds");
  assert.deepEqual(
    bot.__sm.calls,
    [["addExperiences", FISHING_SKILL, SHRIMP_XP]],
    "grants Fishing XP via skillManager.addExperiences"
  );
  assert.equal(sessions.get("bob").items, 1, "session item counter advances");
  assert.equal(sessions.get("bob").xp, SHRIMP_XP, "session xp counter advances");
  console.log("ok 1 - real catch grants real item + real Fishing XP");
}

{
  // 2. LOD gate: citizen not materialized -> no catch.
  const bot = mockBot();
  const director = mockDirector({ bots: { Bob: bot }, online: false });
  runTick({ director, sessions: fishingSession(), fishing: mockFishingPlugin() });
  assert.deepEqual(bot.__inv.calls, [], "offline citizen catches nothing");
  assert.deepEqual(bot.__sm.calls, [], "offline citizen earns no XP");
  console.log("ok 2 - LOD gate: offline citizens do not catch");
}

{
  // 3. Not in a fishing session -> no catch.
  const bot = mockBot();
  const director = mockDirector({ bots: { Bob: bot } });
  const sessions = new Map([
    ["bob", { skill: "woodcutting", arrived: true, members: ["Bob"], site: { x: 3000, y: 3200 } }],
  ]);
  runTick({ director, sessions, fishing: mockFishingPlugin() });
  assert.deepEqual(bot.__inv.calls, [], "non-fishing session catches nothing");
  console.log("ok 3 - only arrived fishing sessions catch");
}

{
  // 4. Spot gate: at the dock but no real fishing-spot NPC in range -> no catch.
  const bot = mockBot({ npc: null });
  const director = mockDirector({ bots: { Bob: bot } });
  runTick({ director, sessions: fishingSession(), fishing: mockFishingPlugin() });
  assert.deepEqual(bot.__inv.calls, [], "no spot nearby means no catch");
  assert.deepEqual(bot.__sm.calls, [], "no spot nearby means no XP");
  console.log("ok 4 - spot gate: catches only fire at real fishing spots");
}

{
  // 5. Inventory full -> no catch, no XP (bank hinge owns that state).
  const bot = mockBot({ invFull: true });
  const director = mockDirector({ bots: { Bob: bot } });
  runTick({ director, sessions: fishingSession(), fishing: mockFishingPlugin() });
  assert.deepEqual(bot.__inv.calls, [], "full inventory grants nothing");
  assert.deepEqual(bot.__sm.calls, [], "full inventory earns no XP");
  console.log("ok 5 - inventory-full: no catch (decision layer banks)");
}

{
  // 6. Miss on the roll -> nothing granted, no crash.
  const bot = mockBot();
  const director = mockDirector({ bots: { Bob: bot } });
  runTick({ director, sessions: fishingSession(), fishing: mockFishingPlugin({ caught: [] }) });
  assert.deepEqual(bot.__inv.calls, [], "a missed roll grants nothing");
  console.log("ok 6 - missed rolls grant nothing");
}

{
  // 7. Cadence: one attempt per window; an immediate second tick is skipped.
  const bot = mockBot();
  const director = mockDirector({ bots: { Bob: bot } });
  const sessions = fishingSession();
  const fishing = mockFishingPlugin();
  _resetForTests();
  const nowMs = 2_000_000;
  tickCitizenFishing(director, { sessions, fishing, nowMs });
  assert.equal(bot.__inv.calls.length, 1, "first tick catches");
  tickCitizenFishing(director, { sessions, fishing, nowMs: nowMs + 1000 });
  assert.equal(bot.__inv.calls.length, 1, "second immediate tick is on cooldown");
  const nextAt = _nextCatchAt.get("bob");
  assert.ok(nextAt > nowMs + 14000 && nextAt < nowMs + 33000, "cooldown is 15-32s");
  tickCitizenFishing(director, { sessions, fishing, nowMs: nextAt + 1 });
  assert.equal(bot.__inv.calls.length, 2, "tick after cooldown catches again");
  _resetForTests();
  console.log("ok 7 - per-citizen catch cadence enforced");
}

{
  // 8. Tick-safe: a throwing citizen never breaks the others.
  const bad = mockBot();
  bad.getLocalNpcs = () => {
    throw new Error("boom");
  };
  const good = mockBot();
  const director = mockDirector({ bots: { Ann: bad, Bob: good } });
  const sessions = new Map([
    ["ann", { skill: "fishing", arrived: true, members: ["Ann"], site: { x: 3000, y: 3200 }, items: 0 }],
    ["bob", { skill: "fishing", arrived: true, members: ["Bob"], site: { x: 3000, y: 3200 }, items: 0 }],
  ]);
  runTick({ director, sessions, fishing: mockFishingPlugin() });
  assert.equal(good.__inv.calls.length, 1, "good citizen still catches when another throws");
  console.log("ok 8 - per-citizen try/catch isolates failures");
}

{
  // 9. Level gate: citizen below the tool's level catches nothing.
  const bot = mockBot({ level: 1 });
  const director = mockDirector({ bots: { Bob: bot } });
  runTick({ director, sessions: fishingSession(), fishing: mockFishingPlugin({ toolLevel: 35 }) });
  assert.deepEqual(bot.__inv.calls, [], "under-leveled citizen catches nothing");
  console.log("ok 9 - tool level requirement respected");
}

{
  // 10. Multi-catch: amount > 1 grants the full stack and full XP.
  const fish = mockFish();
  fish.amount = () => 3;
  const bot = mockBot();
  const director = mockDirector({ bots: { Bob: bot } });
  runTick({ director, sessions: fishingSession(), fishing: mockFishingPlugin({ caught: [fish] }) });
  assert.deepEqual(bot.__inv.calls, [["adds", SHRIMPS, 3]], "grants the full amount");
  console.log("ok 10 - multi-amount catches grant the full stack");
}

console.log("all CitizenFishing tests passed");
