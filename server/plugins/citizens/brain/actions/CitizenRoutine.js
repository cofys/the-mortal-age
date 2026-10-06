"use strict";

/**
 * CitizenRoutine — the commoner's day. Home -> work (real skilling via the
 * shared interactObject action at the kingdom work site) -> a midday market
 * trip -> a meal break (buys and eats bread at the market) -> work ->
 * tavern -> home, driven by the wall clock with per-citizen variation:
 * seeded phase offsets, occasional swapped shifts, rare days off.
 *
 * Work output is real: logs/ore land in the inventory and get banked, feeding
 * the master_trade goal. When the inventory fills mid-shift the routine runs
 * an internal bank trip, then goes back to work.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const {
  createInteractObjectAction,
} = require("../../../bots/brain/actions/InteractObject");
const { createBankAction } = require("../../../bots/brain/actions/Bank");
const { createIdleSocialAction } = require("./IdleSocial");
const { siteTile, workSite, dockSite, kingdomIdOf } = require("../CitizenSites");
const { isKingdomAtWar } = require("../../CitizenEvents");
const { ATTR_CITIZEN_PERSONALITY, ATTR_CITIZEN_ROLE, ROLE_MERCHANT } = require("../../constants");
const { attemptFeed, sellsFood } = require("../CitizenNeeds");
const {
  agentRng,
  logNormalJitter,
  noisyTile,
  chance,
  humanizerProfile,
} = require("../../lib/humanizer");

const KIND_HOME = "home";
const KIND_WORK = "work";
const KIND_MARKET = "market";
const KIND_MEAL = "meal";
const KIND_SOCIAL = "social";

const WORK_FISHING = "fishing";

const DAY_MINUTES = 24 * 60;
const RETRY_WORK_MS = 60000;
const CASTS_PER_HAUL = 4;

const FISHING_LINES = Object.freeze([
  "Come on, bite...",
  "The river's generous today.",
  "Caught a boot last week. A BOOT.",
  "Quiet water, full net. That's the way.",
  "My father fished this same spot.",
  "Shh — you'll scare them off.",
]);

function minutesNow() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function dayStamp() {
  const now = new Date();
  return now.getFullYear() * 1000 + dayOfYear(now);
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - start) / 86400000);
}

/**
 * Build today's phase plan. Seeded per citizen per day so the routine varies
 * without drifting: offsets shift boundaries, some days swap the shifts,
 * rare days are "days off" (tavern all day — everyone needs one).
 */
/**
 * Build today's phase plan. Seeded per citizen per day so the routine varies
 * without drifting. Boundaries share one jittered value each (then forced
 * monotonic) so adjacent phases always meet — no gaps, no overlaps.
 * Some days are "late days" (the whole day slides ~90 min — a lie-in),
 * rare days are "days off" (tavern all day — everyone needs one).
 */
function buildDayPlan(rng) {
  const offset = () => Math.round((rng() - 0.5) * 90); // ±45 min
  const lateDay = chance(rng, 0.18);
  const dayOff = chance(rng, 0.06);
  const slide = lateDay ? 90 : 0;
  const t = (hours, minutes = 0) => hours * 60 + minutes + slide + offset();
  const bounds = [t(6, 30), t(11), t(12), t(13), t(17), t(22)];
  for (let i = 1; i < bounds.length; i += 1) {
    bounds[i] = Math.max(bounds[i], bounds[i - 1] + 15); // keep phases ordered, >=15 min
  }
  const [b630, b11, b12, b13, b17, b22] = bounds;
  const plan = [
    { kind: KIND_HOME, start: 0, end: b630 },
    { kind: KIND_WORK, start: b630, end: b11 },
    { kind: KIND_MARKET, start: b11, end: b12 },
    { kind: KIND_MEAL, start: b12, end: b13 },
    { kind: KIND_WORK, start: b13, end: b17 },
    { kind: KIND_SOCIAL, start: b17, end: b22 },
    { kind: KIND_HOME, start: b22, end: DAY_MINUTES },
  ];
  if (dayOff) {
    return plan.map((phase) =>
      phase.kind === KIND_WORK ? { ...phase, kind: KIND_SOCIAL } : phase
    );
  }
  return plan;
}

function phaseFor(plan, minute) {
  for (const phase of plan) {
    if (minute >= phase.start && minute < phase.end) {
      return phase;
    }
  }
  return plan[plan.length - 1];
}

function atTile(player, tile, radius = 3) {
  if (!tile) {
    return true;
  }
  const loc = player.getLocation();
  return (
    loc.getZ() === (tile.z ?? 0) &&
    Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <= radius
  );
}

function walkTo(player, tile) {
  const noisy = noisyTile(tile.x, tile.y, 3, null);
  requestMovement(player, noisy.x, noisy.y, {
    reason: "citizen_routine",
    basicPather: true,
    z: tile.z ?? 0,
  });
}

function createCitizenRoutineAction(spec, world) {
  // Internal delegates, created once so their per-player state stays keyed.
  const socialDelegate = createIdleSocialAction(
    { anchorKind: "tavern", chatterMinMs: 120000, chatterMaxMs: 420000 },
    world
  );
  const marketDelegate = createIdleSocialAction(
    { anchorKind: "market", chatterMinMs: 180000, chatterMaxMs: 480000 },
    world
  );
  let workDelegate = null;
  let bankDelegate = null;

  function delegatesFor(player) {
    if (!workDelegate) {
      const site = workSite(player) ?? { catalog: "tree", tier: "normal", option: "Chop down" };
      workDelegate = createInteractObjectAction(
        {
          catalog: site.catalog ?? "tree",
          tier: site.tier ?? "normal",
          option: site.option ?? "Chop down",
          until: { inventoryFull: true },
          stallSeconds: 120,
        },
        world
      );
      bankDelegate = createBankAction({}, world);
    }
    return { workDelegate, bankDelegate };
  }

  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`routine:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        day: -1,
        plan: null,
        phaseKind: null,
        workMode: "work", // work | bank
        workRetryAt: 0,
        lingerUntil: 0,
        workKind: null, // resolved lazily: 'fishing' | 'tree' | 'rock'
        nextCastAt: 0,
        casts: 0,
      };
    });
  }

  /**
   * What this commoner does for a living, resolved once per citizen (stable
   * across days). Capitals with a dock get fishers; everyone else works the
   * kingdom's tree/rock site. Believable mix, not identical mix.
   */
  function resolveWorkKind(player, state) {
    if (state.workKind) {
      return state.workKind;
    }
    const dock = dockSite(player);
    if (dock && chance(state.rng, 0.4)) {
      state.workKind = WORK_FISHING;
    } else {
      state.workKind = workSite(player)?.catalog ?? "tree";
    }
    return state.workKind;
  }

  function workTileFor(player, state) {
    if (resolveWorkKind(player, state) === WORK_FISHING) {
      return dockSite(player);
    }
    return workSite(player);
  }

  /**
   * Fisher's shift: walk to the dock, then cast on a human rhythm with
   * fishing chatter. Catches are the stubbed part (real fishing needs a
   * brain NPC-interaction path that doesn't exist yet — see DESIGN.md); the
   * visible behavior and the work rhythm are real, and completed hauls feed
   * the master_trade goal like banked loads do for gatherers.
   */
  function fishWorkTick(ctx, state) {
    const { player, nowMs } = ctx;
    const dock = dockSite(player);
    if (!dock) {
      return "failed";
    }
    if (!atTile(player, dock, 8)) {
      walkTo(player, dock);
      return "running";
    }
    if (nowMs < state.nextCastAt) {
      return "running";
    }
    state.nextCastAt =
      nowMs + logNormalJitter(state.rng, 45000, state.human.tempoSigma);
    state.casts += 1;
    if (chance(state.rng, 0.5 * state.human.chatRate)) {
      try {
        player.forceChat?.(
          FISHING_LINES[Math.floor(state.rng() * FISHING_LINES.length)]
        );
      } catch (error) {
        // Cosmetic only.
      }
    }
    if (state.casts % CASTS_PER_HAUL === 0) {
      const bucket = (ctx.state.citizens ??= {});
      bucket.workCyclesBanked = (bucket.workCyclesBanked ?? 0) + 1;
      world?.log?.("citizen_routine_haul", {
        citizen: player.getUsername?.(),
        kingdom: kingdomIdOf(player),
        hauls: bucket.workCyclesBanked,
      });
    }
    return "running";
  }

  function ensurePlan(state) {
    const today = dayStamp();
    if (state.day !== today) {
      state.day = today;
      state.plan = buildDayPlan(state.rng);
      state.phaseKind = null; // force phase re-entry
    }
  }

  /** Bread-selling merchants in view — the meal break's food source. */
  function localProvisioners(player) {
    const out = [];
    for (const local of player.getLocalPlayers?.() ?? []) {
      if (local === player || local?.isPlayerBot?.() !== true) {
        continue;
      }
      try {
        if (
          local.getAttribute?.(ATTR_CITIZEN_ROLE) === ROLE_MERCHANT &&
          sellsFood(local)
        ) {
          out.push(local);
        }
      } catch (error) {
        // A broken read skips one candidate, not the meal.
      }
    }
    return out;
  }

  /** Meal break: at the market, eat own bread or buy a loaf from a stall. */
  function mealTick(ctx, state) {
    const { player } = ctx;
    const market = siteTile(player, "market");
    if (market && !atTile(player, market, 6)) {
      walkTo(player, market);
      return "running";
    }
    attemptFeed(player, localProvisioners(player));
    return "running";
  }

  function enterPhase(ctx, state, kind) {
    state.phaseKind = kind;
    state.workMode = "work";
    state.workRetryAt = 0;
    state.lingerUntil = 0;
    const { player } = ctx;
    if (kind === KIND_WORK) {
      const tile = workTileFor(player, state);
      if (tile) {
        walkTo(player, tile);
      }
    } else if (kind === KIND_SOCIAL) {
      const tavern = siteTile(player, "tavern");
      if (tavern) {
        walkTo(player, tavern);
      }
    } else if (kind === KIND_MARKET || kind === KIND_MEAL) {
      // Midday market trip, then the meal break right there among the stalls.
      const market = siteTile(player, "market");
      if (market) {
        walkTo(player, market);
      }
    } else {
      const home = ctx.state?.home;
      if (home) {
        walkTo(player, home);
      }
    }
  }

  const action = {
    id: "citizenRoutine",
    update(ctx) {
      const { player, nowMs } = ctx;
      const state = botState(player);
      ensurePlan(state);
      const phase = phaseFor(state.plan, minutesNow());
      if (phase.kind !== state.phaseKind) {
        enterPhase(ctx, state, phase.kind);
      }

      if (player.getForceMovement?.() != null) {
        return "running";
      }
      if (player.getMovementQueue?.()?.size?.() > 0) {
        return "running";
      }

      // War alert: commoners stay home. (Guards handle the walls.)
      if (isKingdomAtWar(kingdomIdOf(player)) && state.phaseKind !== KIND_HOME) {
        enterPhase(ctx, state, KIND_HOME);
        return "running";
      }

      if (state.phaseKind === KIND_WORK) {
        if (resolveWorkKind(player, state) === WORK_FISHING) {
          return fishWorkTick(ctx, state);
        }
        const { workDelegate, bankDelegate } = delegatesFor(player);
        const site = workSite(player);
        if (state.workMode === "bank") {
          const result = bankDelegate.update(ctx);
          if (result === "success") {
            bankDelegate.stop?.(ctx);
            state.workMode = "work";
            // Real output banked — the director's master_trade goal samples this.
            const bucket = (ctx.state.citizens ??= {});
            bucket.workCyclesBanked = (bucket.workCyclesBanked ?? 0) + 1;
          } else if (result === "failed") {
            bankDelegate.stop?.(ctx);
            state.workMode = "work"; // try work again; inventory may have room
          }
          return "running";
        }
        if (nowMs < state.workRetryAt) {
          return "running";
        }
        if (site && !atTile(player, site, 12)) {
          walkTo(player, site);
          return "running";
        }
        const result = workDelegate.update(ctx);
        if (result === "success") {
          // Inventory full: bank, then back to work.
          workDelegate.stop?.(ctx);
          state.workMode = "bank";
        } else if (result === "failed") {
          workDelegate.stop?.(ctx);
          // No reachable resource right now — wait a beat, don't spin.
          state.workRetryAt =
            nowMs + logNormalJitter(state.rng, RETRY_WORK_MS, state.human.tempoSigma);
          world?.log?.("citizen_routine_work_stalled", {
            citizen: player.getUsername?.(),
            kingdom: kingdomIdOf(player),
          });
        }
        return "running";
      }

      if (state.phaseKind === KIND_MARKET) {
        // Midday market trip: browse the stalls with the market crowd.
        return marketDelegate.update(ctx);
      }

      if (state.phaseKind === KIND_MEAL) {
        return mealTick(ctx, state);
      }

      if (state.phaseKind === KIND_SOCIAL) {
        // Delegate the tavern evening to the social action.
        return socialDelegate.update(ctx);
      }

      // Home: linger with human timing, occasionally step out for air.
      if (nowMs < state.lingerUntil) {
        return "running";
      }
      const home = ctx.state?.home;
      if (home && !atTile(player, home, 4)) {
        walkTo(player, home);
        return "running";
      }
      state.lingerUntil =
        nowMs + logNormalJitter(state.rng, 90000, state.human.tempoSigma);
      return "running";
    },
    stop(ctx) {
      if (ctx?.player) {
        clearMovementRequest(ctx.player);
      }
    },
  };

  return action;
}

module.exports = {
  createCitizenRoutineAction,
};
