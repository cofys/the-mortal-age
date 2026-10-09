"use strict";

/**
 * CitizenPker unit checks — wilderness player-hunting for citizens.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenPker".
 *   - Non-bot -> "failed". Timid personality -> "failed" (never starts).
 *   - Combat level < 40 -> "failed".
 *   - No food / carrying too much -> "success" (re-decide).
 *   - Outside the wild -> "running" (travels to the ditch anchor).
 *   - In the wild, no targets -> "running" (patrols).
 *   - Target filtering: bots excluded, out-of-range excluded, skulled
 *     preferred over non-skulled.
 *   - In-range target -> attacks via getCombat().attack, "running".
 *   - Session expiry -> "success" (give-up timer, never hunts forever).
 *   - Low HP -> eats, then flees to the edge -> "success" once out.
 *   - Null-safety: null ctx / missing methods never throw.
 *
 * The Wilderness plugin and BotNavigation are stubbed in the require cache
 * (same pattern as CitizenSlayer.test.js). humanizer, CitizenNeeds,
 * citizenVoice, CitizenSayPublic are real — they have no engine imports.
 */
const assert = require("node:assert/strict");
const { hashSeed } = require("../../lib/humanizer");

// --- stubs --------------------------------------------------------------------

const movedTo = []; // { x, y, opts }
const attacked = [];
const said = [];

let wildDepth = 0;
let rangeCheck = () => true;

function mockPlayer(opts = {}) {
  const target = opts.combatTarget ?? null;
  return {
    _username: opts.username ?? "Pker",
    isPlayer: () => true,
    isPlayerBot: () => opts.bot ?? false,
    isDead: () => !!opts.dead,
    isDying: () => false,
    isRegistered: () => true,
    isSkulled: () => !!opts.skulled,
    getUsername: () => opts.username ?? "Pker",
    getIndex: () => 7,
    getHitpoints: () => opts.hp ?? 99,
    getLocation: () => ({
      getX: () => opts.x ?? 3085,
      getY: () => opts.y ?? 3528,
      getZ: () => 0,
    }),
    getLocalPlayers: () => opts.nearby ?? [],
    getSkillManager: () => ({
      getCombatLevel: () => opts.level ?? 60,
      getMaxLevel: () => 99,
    }),
    getInventory: () => ({
      getAmount: (id) => (opts.invAmounts ?? {})[id] ?? 0,
      getItems: () => opts.invItems ?? [],
      deleteNumber: () => true,
    }),
    getCombat: () => ({
      getTarget: () => target,
      attack: (t) => {
        attacked.push(t);
      },
      reset: () => {},
    }),
    getAttribute: (key) => (opts.attrs ?? {})[key] ?? null,
    forceChat: (text) => {
      said.push(text);
    },
    heal: () => {},
    setAttribute: () => {},
  };
}

/** A willing citizen: username hashes into the ~5% slice. */
function willingName() {
  for (let i = 0; i < 5000; i++) {
    const name = `Pker${i}`;
    if (hashSeed(name) % 20 === 0) return name;
  }
  throw new Error("no willing username found");
}

const WILLING = willingName();

function mockCtx(bot) {
  return { player: bot };
}

const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../areas/Wilderness.plugin.js") {
    return {
      canAttackByWildernessLevel: (a, t) => rangeCheck(a, t),
      wildernessAttackRange: () => wildDepth,
    };
  }
  if (request === "../../../bots/behaviours/navigation/BotNavigation") {
    return {
      requestMovement: (player, x, y, opts) => {
        movedTo.push({ x, y, opts });
        return true;
      },
      clearMovementRequest: () => {},
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

const { createCitizenPkerAction } = require("./CitizenPker.js");
// Real ActionState: reach the per-player session state to force expiry.
const { playerState } = require("../../../bots/brain/ActionState");

// --- helpers ------------------------------------------------------------------

function pkerBot(opts = {}) {
  return mockPlayer({
    bot: true,
    username: WILLING,
    level: 60,
    hp: 99,
    invAmounts: { 2309: 5 }, // bread
    attrs: { "citizens:personality": { traits: ["gruff"] } },
    ...opts,
  });
}

function reset() {
  movedTo.length = 0;
  attacked.length = 0;
  said.length = 0;
  wildDepth = 0;
  rangeCheck = () => true;
}

let n = 0;
function ok(name) {
  n += 1;
  console.log(`ok ${n} - ${name}`);
}

// 1. Factory returns a well-formed action.
{
  reset();
  const action = createCitizenPkerAction({}, {});
  assert.equal(action.id, "citizenPker");
  assert.equal(typeof action.update, "function");
  assert.equal(typeof action.stop, "function");
  ok("factory returns well-formed action");
}

// 2. Non-bot -> "failed".
{
  reset();
  const action = createCitizenPkerAction({}, {});
  const bot = pkerBot({ bot: false });
  assert.equal(action.update(mockCtx(bot)), "failed");
  ok("non-bot fails fast");
}

// 3. Timid personality -> "failed" (never starts).
{
  reset();
  const action = createCitizenPkerAction({}, {});
  const bot = pkerBot({ attrs: { "citizens:personality": { traits: ["timid"] } } });
  assert.equal(action.update(mockCtx(bot)), "failed");
  assert.equal(action._pkerWilling(bot), false);
  ok("timid citizen never starts");
}

// 4. Low combat level -> "failed".
{
  reset();
  const action = createCitizenPkerAction({}, {});
  const bot = pkerBot({ level: 20 });
  assert.equal(action.update(mockCtx(bot)), "failed");
  ok("low combat level fails fast");
}

// 5. No food -> "success" (re-decide, don't go hungry).
{
  reset();
  const action = createCitizenPkerAction({}, {});
  const bot = pkerBot({ invAmounts: {} });
  assert.equal(action.update(mockCtx(bot)), "success");
  ok("no food means success (re-decide)");
}

// 6. Carrying too much -> "success" (won't risk the bank).
{
  reset();
  const action = createCitizenPkerAction({}, {});
  const items = Array.from({ length: 12 }, (_, i) => ({ getId: () => 1000 + i }));
  const bot = pkerBot({ invItems: items });
  assert.equal(action.update(mockCtx(bot)), "success");
  assert.equal(action._carryingTooMuch(bot), true);
  ok("risk gate sends them back to bank");
}

// 7. Outside the wild -> "running", walks toward the ditch anchor.
{
  reset();
  wildDepth = 0;
  const action = createCitizenPkerAction({}, {});
  const bot = pkerBot({ x: 3080, y: 3510 });
  assert.equal(action.update(mockCtx(bot)), "running");
  assert.equal(movedTo.length, 1);
  assert.equal(movedTo[0].opts.reason, "citizen_pker_travel");
  const d = Math.max(
    Math.abs(movedTo[0].x - 3085),
    Math.abs(movedTo[0].y - 3528)
  );
  assert.ok(d <= 10, `walks near anchor, dist ${d}`);
  ok("travels to the wilderness anchor");
}

// 8. In the wild, nobody around -> "running" (patrols).
{
  reset();
  wildDepth = 5;
  const action = createCitizenPkerAction({}, {});
  const bot = pkerBot({ nearby: [] });
  assert.equal(action.update(mockCtx(bot)), "running");
  assert.equal(movedTo.length, 1);
  assert.equal(movedTo[0].opts.reason, "citizen_pker_patrol");
  ok("patrols the anchor when no targets");
}

// 9. Target filtering: bots and out-of-range players excluded.
{
  reset();
  wildDepth = 5;
  const action = createCitizenPkerAction({}, {});
  const botVictim = mockPlayer({ bot: true, username: "OtherCitizen", x: 3086, y: 3529 });
  const farVictim = mockPlayer({ username: "FarPlayer", x: 3090, y: 3530 });
  rangeCheck = (a, t) => t !== farVictim; // far player out of level range
  const bot = pkerBot({ nearby: [botVictim, farVictim] });
  const targets = action._scanTargets(bot, {
    canAttackByWildernessLevel: rangeCheck,
  });
  assert.deepEqual(targets, []);
  ok("bots and out-of-range players are excluded");
}

// 10. Prefers skulled targets, then weaker ones.
{
  reset();
  wildDepth = 5;
  const action = createCitizenPkerAction({}, {});
  const safe = mockPlayer({ username: "Safe", x: 3086, y: 3529, level: 60 });
  const skulled = mockPlayer({ username: "Skulled", x: 3087, y: 3530, skulled: true, level: 60 });
  const weak = mockPlayer({ username: "Weak", x: 3088, y: 3531, level: 40 });
  const bot = pkerBot({ nearby: [safe, skulled, weak] });
  const targets = action._scanTargets(bot, {
    canAttackByWildernessLevel: () => true,
  });
  assert.equal(targets.length, 3);
  const pick = action._pickTarget(bot, targets);
  assert.equal(pick.getUsername(), "Skulled");
  const pick2 = action._pickTarget(bot, [safe, weak]);
  assert.equal(pick2.getUsername(), "Weak");
  ok("prefers skulled, then weaker targets");
}

// 11. In-range target -> attacks with real combat, "running".
{
  reset();
  wildDepth = 5;
  const action = createCitizenPkerAction({}, {});
  const victim = mockPlayer({ username: "Victim", x: 3086, y: 3529, level: 50 });
  const bot = pkerBot({ nearby: [victim] });
  assert.equal(action.update(mockCtx(bot)), "running");
  assert.equal(attacked.length, 1);
  assert.equal(attacked[0], victim);
  ok("attacks an in-range target with getCombat().attack");
}

// 12. Give-up timer: expired session -> "success", never hunts forever.
{
  reset();
  wildDepth = 5;
  const action = createCitizenPkerAction({}, {});
  const bot = pkerBot({ nearby: [] });
  assert.equal(action.update(mockCtx(bot)), "running");
  const state = playerState(action, bot, () => ({}));
  assert.ok(state.startedAt > 0, "session state tracked per player");
  assert.ok(
    state.sessionMs >= 5 * 60 * 1000 && state.sessionMs <= 15 * 60 * 1000,
    `session 5-15 min, got ${state.sessionMs}`
  );
  state.startedAt = Date.now() - 20 * 60 * 1000; // expire it
  assert.equal(action.update(mockCtx(bot)), "success");
  ok("give-up timer ends the session");
}

// 13. Low HP -> eats, then flees to the edge; "success" once out.
{
  reset();
  wildDepth = 5;
  const action = createCitizenPkerAction({}, {});
  const bot = pkerBot({ hp: 20 }); // 20% — below FLEE_HP(35)
  assert.equal(action.update(mockCtx(bot)), "running");
  assert.equal(movedTo.length, 1);
  assert.equal(movedTo[0].opts.reason, "citizen_pker_flee");
  assert.equal(movedTo[0].x, 3086);
  assert.equal(movedTo[0].y, 3520);
  // Now out of the wild after fleeing -> "success".
  wildDepth = 0;
  assert.equal(action.update(mockCtx(bot)), "success");
  ok("flees at low HP and leaves after escaping");
}

// 14. Null-safety: null ctx / broken bot never throw.
{
  reset();
  const action = createCitizenPkerAction({}, {});
  assert.equal(action.update(null), "failed");
  assert.equal(action.update({}), "failed");
  assert.equal(action.update({ player: {} }), "failed");
  assert.doesNotThrow(() => action.stop(null));
  assert.doesNotThrow(() => action.stop({}));
  ok("null-safe everywhere");
}

// 15. Only ~5% of citizens are temperament-gated in (no trait system yet).
{
  reset();
  const action = createCitizenPkerAction({}, {});
  let willing = 0;
  const total = 1000;
  for (let i = 0; i < total; i++) {
    const bot = mockPlayer({
      bot: true,
      username: `Citizen${i}`,
      attrs: { "citizens:personality": { traits: ["chatty"] } },
    });
    if (action._pkerWilling(bot)) willing += 1;
  }
  const pct = willing / total;
  assert.ok(pct > 0.02 && pct < 0.1, `pker rate ${pct}`);
  ok(`temperament gate admits ~${Math.round(pct * 100)}% of citizens`);
}

console.log(`\n${n} CitizenPker checks passed.`);
