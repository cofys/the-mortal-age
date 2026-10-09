"use strict";

/**
 * HousingBoons.test.js — plain-node tests for the room-boon tick gating.
 *
 * Verifies: real-player detection, own-house detection (area owner),
 * plot gating, and that the tick isolates per-player failures.
 * (SkillManager effects can't run in plain node — Skill is null there —
 * so applyBoons is verified to no-op safely.)
 */

const boons = require("./HousingBoons");
const T = boons._test;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok -", name);
  } catch (e) {
    failed++;
    console.log("  FAIL -", name, ":", e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function fakePlayer(overrides = {}) {
  return {
    isPlayer: () => true,
    isPlayerBot: () => false,
    getPrivateArea: () => null,
    getAttribute: () => null,
    getSkillManager: () => null,
    ...overrides,
  };
}

test("bots are not real players", () => {
  assert(T.isRealPlayer(fakePlayer({ isPlayerBot: () => true })) === false, "bot excluded");
  assert(T.isRealPlayer(fakePlayer()) === true, "human included");
  assert(T.isRealPlayer(null) === false, "null safe");
});

test("own house requires area owner === player", () => {
  const p = fakePlayer();
  assert(T.inOwnHouse(p) === false, "no private area");
  const p2 = fakePlayer({ getPrivateArea: () => ({ owner: p2 }) });
  assert(T.inOwnHouse(p2) === true, "owner match");
  const p3 = fakePlayer({ getPrivateArea: () => ({ owner: {} }) });
  assert(T.inOwnHouse(p3) === false, "someone else's house");
});

test("plot gating", () => {
  assert(T.hasPlot(fakePlayer()) === false, "no plot");
  assert(
    T.hasPlot(fakePlayer({ getAttribute: () => '{"kingdomId":"misthalin"}' })) === true,
    "plot present"
  );
});

test("tick iterates world players safely", () => {
  const seen = [];
  const api = {
    core: {
      World: {
        players: {
          forEach: (fn) => {
            // one real player home with plot, one bot, one thrower
            fn(fakePlayer());
            fn(fakePlayer({ isPlayerBot: () => true }));
            fn({
              isPlayer: () => {
                throw new Error("boom");
              },
            });
            seen.push(1);
          },
        },
      },
    },
  };
  boons.tickHousingBoons(api); // must not throw
  assert(seen.length === 1, "forEach ran");
});

test("tick with no world is safe", () => {
  boons.tickHousingBoons({}); // must not throw
  boons.tickHousingBoons({ core: {} }); // must not throw
});

test("applyBoons no-ops safely without Skill (plain node)", () => {
  const p = fakePlayer({
    getSkillManager: () => ({
      getMaxLevel: () => 99,
      increaseCurrentLevel: () => {
        throw new Error("should not be called");
      },
      addExperience: () => {
        throw new Error("should not be called");
      },
    }),
  });
  T.applyBoons(p, { rooms: [] }); // must not throw, must not call
});

test("boon constants sane", () => {
  assert(T.BOON_TICK_TICKS === 50, "tick interval");
  assert(T.CHAPEL_PRAYER_RESTORE === 2, "chapel restore modest");
  assert(T.WORKSHOP_CRAFT_XP === 20, "workshop xp modest");
  assert(T.KITCHEN_COOK_XP === 20, "kitchen xp modest");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
