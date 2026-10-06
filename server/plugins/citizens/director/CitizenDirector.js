"use strict";

/**
 * CitizenDirector — the AI DIRECTOR. Spawns bots with roles, personality
 * seeds, circadian schedules and long-term goals, then runs them like a
 * population, not a task loop.
 *
 * What it owns:
 *   - roster: who exists (username, personality, kingdom, role, home, goal)
 *   - spawn / login / logout: citizens log OUT during sleep (logged-out bots
 *     cost zero — the runtime drops their entry on logout), and back in for
 *     their waking hours
 *   - scheduling: every 60s the director reconciles each citizen's desired
 *     phase (role + wall-clock hour) against reality: spawn, switch activity,
 *     or log out
 *   - goals: samples goal progress on the slow tick, promotes guards and
 *     escalates targets on completion
 *
 * What it does NOT own: per-tick behavior (that's BotBrain activities), chat
 * replies (that's the llm-gateway), or kingdom politics (the kingdoms plugin).
 */

const { Task } = require("../../../src/main/typescript/elvarg/game/task/Task");
const { Location } = require("../../../src/main/typescript/elvarg/game/model/Location");
const {
  createBotPlayer,
} = require("../../bots/behaviours/spawn/BotPlayerFactory");
const {
  createInitialState,
  resetMovementState,
} = require("../../bots/behaviours/state/PlayerBotState");
const { attachBrain } = require("../../bots/brain/attachBrain");
const { startActivity } = require("../../bots/brain/BrainActivities");
const { getActiveBotRuntime } = require("../../bots/runtime/BotRuntimeRegistry");
const { ATTR_SKIP_PERSISTENCE } = require("../../bots/runtime/BotPersistenceConstants");
const { agentRng, noisyTile } = require("../lib/humanizer");
const { generatePersonality } = require("../lib/personalities");
const {
  nextGoalForRole,
  sampleGoalProgress,
  GOAL_RANK_UP,
} = require("../lib/goals");
const { registerCitizenForChat } = require("../chat/CitizenChat");
const { siteTileByKingdom, KINGDOM_IDS } = require("../brain/CitizenSites");
const KingdomStore = require("../../kingdoms/KingdomStore");
const {
  ATTR_KINGDOM_ID,
  ATTR_KINGDOM_RANK,
  ATTR_CITIZEN_ROLE,
  ATTR_CITIZEN_PERSONALITY,
  ATTR_CITIZEN_GOAL,
  ATTR_CITIZEN_SEED,
  ROLE_GUARD,
  ROLE_MERCHANT,
  ROLE_COMMONER,
  ROLE_COURTIER,
  ROLE_ACTIVITY,
  ACTIVITY_TAVERN_SOCIAL,
  EVENT_RANK_GRANTED,
} = require("../constants");

const DIRECTOR_TICK_TICKS = 100; // ~60s at 600ms/tick

// role -> rank granted through the kingdoms plugin's hierarchy.
const ROLE_RANK = Object.freeze({
  [ROLE_GUARD]: "Man-at-arms",
  [ROLE_MERCHANT]: "Subject",
  [ROLE_COMMONER]: "Subject",
  [ROLE_COURTIER]: "Lord",
});

const GUARD_PROMOTION_LADDER = Object.freeze([
  "Man-at-arms",
  "Knight",
  "Lord",
]);

/**
 * Phase 1 ("make it feel like a world"): every capital gets a believable
 * street-level mix — guards on the walls, merchants at the market, commoners
 * (some fishing the docks, some gathering) living their routines, courtiers
 * at the court. 13 per capital, 65 across the five great powers. Well within
 * the bot budgets (the wilderness alone runs ~845).
 */
function defaultPlan() {
  const plan = {};
  for (const kingdomId of KINGDOM_IDS) {
    plan[kingdomId] = {
      [ROLE_GUARD]: 3,
      [ROLE_MERCHANT]: 2,
      [ROLE_COMMONER]: 6,
      [ROLE_COURTIER]: 2,
    };
  }
  return plan;
}

function loadPlan() {
  const raw = process.env.CITIZEN_PLAN ?? "";
  if (raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch (error) {
      console.warn("[citizens] CITIZEN_PLAN is not valid JSON, using default", error?.message);
    }
  }
  return defaultPlan();
}

function hourNow() {
  return new Date().getHours();
}

/**
 * Desired state for a citizen at `hour`: { online, activityId }.
 * Sleep windows are seeded per citizen; logged-out bots cost zero.
 */
function desiredPhase(record, hour) {
  const sleepStart = record.sleepStart;
  const sleepEnd = (sleepStart + record.sleepHours) % 24;
  const sleeping =
    sleepStart <= sleepEnd
      ? hour >= sleepStart && hour < sleepEnd
      : hour >= sleepStart || hour < sleepEnd;
  if (sleeping) {
    return { online: false, activityId: null };
  }
  switch (record.role) {
    case ROLE_GUARD: {
      // Three watches; off-watch guards drink, sleep is handled above.
      const watch = record.watch; // 0: 06-14, 1: 14-22, 2: 22-06
      const watchStart = [6, 14, 22][watch];
      const watchEnd = [14, 22, 30][watch];
      const onWatch =
        watchEnd <= 24
          ? hour >= watchStart && hour < watchEnd
          : hour >= watchStart || hour < watchEnd - 24;
      return {
        online: true,
        activityId: onWatch ? ROLE_ACTIVITY[ROLE_GUARD] : ACTIVITY_TAVERN_SOCIAL,
        onDuty: onWatch,
      };
    }
    case ROLE_MERCHANT:
      // Shops open 08:00-19:00; otherwise the merchant is "home".
      return {
        online: hour >= 8 && hour < 19,
        activityId: ROLE_ACTIVITY[ROLE_MERCHANT],
      };
    case ROLE_COMMONER:
      // The routine action runs the day itself; the director only sleeps them.
      return { online: true, activityId: ROLE_ACTIVITY[ROLE_COMMONER] };
    case ROLE_COURTIER:
      if (hour >= 9 && hour < 17) {
        return { online: true, activityId: ROLE_ACTIVITY[ROLE_COURTIER] };
      }
      if (hour >= 17 && hour < 23) {
        return { online: true, activityId: ACTIVITY_TAVERN_SOCIAL };
      }
      return { online: false, activityId: null };
    default:
      return { online: false, activityId: null };
  }
}

class CitizenDirector {
  constructor({ api, registry }) {
    this.api = api;
    this.registry = registry;
    this.world = registry?.world ?? {};
    this.roster = new Map(); // username -> record
    this.usedNames = new Set();
    this.taskStarted = false;
  }

  runtime() {
    return getActiveBotRuntime()?.runtime ?? null;
  }

  log(message, extra) {
    try {
      this.api.log?.(`[citizens] ${message}`, extra);
    } catch (error) {
      // Logging must never break the director.
    }
  }

  /** Build the roster from the plan; spawn happens lazily on the first tick. */
  boot() {
    if (!this.registry) {
      throw new Error("[citizens] director needs the bot activity registry");
    }
    const plan = loadPlan();
    for (const [kingdomId, roles] of Object.entries(plan)) {
      if (!KINGDOM_IDS.includes(kingdomId)) {
        this.log("unknown kingdom in CITIZEN_PLAN, skipped", { kingdomId });
        continue;
      }
      for (const [role, count] of Object.entries(roles ?? {})) {
        const wanted = Math.max(0, Math.floor(Number(count) || 0));
        for (let index = 0; index < wanted; index += 1) {
          this.addCitizen(kingdomId, role);
        }
      }
    }
    this.log("roster built", { citizens: this.roster.size });
    this.startTask();
  }

  addCitizen(kingdomId, role) {
    const rng = agentRng(`director:${kingdomId}:${role}:${this.roster.size}`);
    // Usernames are the personality names (deduplicated); bots are people.
    const personality = generatePersonality(`seed-${this.roster.size}`, {
      role,
      kingdomId,
      usedNames: this.usedNames,
    });
    const username = personality.name;
    // Citizens live near the market of their kingdom's capital.
    const market = siteTileByKingdom(kingdomId, "market") ?? { x: 3200, y: 3200, z: 0 };
    const home = noisyTile(market.x, market.y, 12, rng);
    home.z = market.z ?? 0;
    const watch = role === ROLE_GUARD ? Math.floor(rng() * 3) : 0;
    // Guards sleep inside their off-watch hours so the night watch is actually
    // manned; everyone else keeps a seeded night window.
    const sleepStart =
      role === ROLE_GUARD ? [23, 0, 8][watch] : [22, 23, 0][Math.floor(rng() * 3)];
    const record = {
      username,
      personality,
      kingdomId,
      role,
      home,
      seed: personality.seed,
      sleepStart,
      sleepHours: 6 + Math.floor(rng() * 3),
      watch,
      goal: nextGoalForRole(role, 0),
      goalTier: 0,
      online: false,
      currentActivityId: null,
      lastTickAt: Date.now(),
    };
    this.roster.set(username, record);
    return record;
  }

  startTask() {
    if (this.taskStarted) {
      return;
    }
    this.taskStarted = true;
    const director = this;
    class DirectorTask extends Task {
      execute() {
        try {
          director.tick();
        } catch (error) {
          director.log("tick failed", { error: String(error?.message ?? error) });
        }
      }
    }
    this.api.getTaskManager()?.submit(new DirectorTask(DIRECTOR_TICK_TICKS));
  }

  isOnline(record) {
    const runtime = this.runtime();
    return !!runtime?.entriesByUsername?.has(record.username);
  }

  getBot(record) {
    return this.runtime()?.entriesByUsername?.get(record.username)?.player ?? null;
  }

  /**
   * Online citizen bot players for a kingdom (optionally one role).
   * Used by realm-tick reactions: rumors, patrol orders, wage day.
   */
  onlineBotsForKingdom(kingdomId, role = null) {
    const out = [];
    for (const record of this.roster.values()) {
      if (record.kingdomId !== kingdomId) continue;
      if (role && record.role !== role) continue;
      if (!this.isOnline(record)) continue;
      const bot = this.getBot(record);
      if (bot) out.push(bot);
    }
    return out;
  }

  spawnCitizen(record) {
    const runtime = this.runtime();
    if (!runtime) {
      this.log("no bot runtime yet, deferring spawn", { citizen: record.username });
      return false;
    }
    const spawn = new Location(record.home.x, record.home.y, record.home.z ?? 0);
    const bot = createBotPlayer(record.username, spawn, {
      api: this.api,
      loadPersistence: false,
      saveRandomizedAppearance: false,
    });
    if (!bot) {
      this.log("spawn failed (name taken?)", { citizen: record.username });
      return false;
    }
    bot.setPlayerBot?.(true);
    bot.setAttribute?.(ATTR_SKIP_PERSISTENCE, true);

    // Kingdom membership: through the kingdoms plugin's event (its Events
    // module applies the attributes), plus direct attributes for immediacy.
    const rank = ROLE_RANK[record.role] ?? "Subject";
    bot.setAttribute?.(ATTR_KINGDOM_ID, record.kingdomId);
    bot.setAttribute?.(ATTR_KINGDOM_RANK, rank);
    this.api.emitCustomEvent(EVENT_RANK_GRANTED, {
      player: bot,
      kingdomId: record.kingdomId,
      rank,
    });

    bot.setAttribute?.(ATTR_CITIZEN_ROLE, record.role);
    bot.setAttribute?.(ATTR_CITIZEN_PERSONALITY, record.personality);
    bot.setAttribute?.(ATTR_CITIZEN_SEED, record.seed);
    bot.setAttribute?.(ATTR_CITIZEN_GOAL, record.goal);

    const state = createInitialState(
      { x: record.home.x, y: record.home.y, z: record.home.z ?? 0 },
      { ROAMING: "roaming" }
    );
    state.citizens = { director: true, workCyclesBanked: 0 };

    // Wire into the shared bot runtime (mirrors BotRegistry.addEntry).
    const entry = { player: bot, state };
    entry.entryIndex = runtime.entries.length;
    entry.entryUsername = record.username;
    runtime.entries.push(entry);
    runtime.entriesByUsername.set(record.username, entry);
    runtime.botStatesByName.set(record.username, state);
    runtime.playerBotUsernames.add(record.username);

    this.api.emitPlayerLogin({ player: bot, username: record.username });
    bot.moveTo?.(spawn.clone());

    const activity = this.registry.byId.get(ROLE_ACTIVITY[record.role]);
    if (activity) {
      attachBrain({
        runtime,
        registry: this.registry,
        world: this.world,
        bot,
        activity,
        home: record.home,
        resetMovementState,
        nowMs: Date.now(),
      });
      record.currentActivityId = activity.id;
    }

    // The LLM mouth learns who this person is (llm-gateway contract).
    const kingdom = KingdomStore.getKingdom(record.kingdomId);
    registerCitizenForChat(
      record.username,
      record.personality,
      kingdom?.name ?? record.kingdomId,
      kingdom?.situation ?? null
    );

    record.online = true;
    record.lastTickAt = Date.now();
    this.log("citizen spawned", {
      citizen: record.username,
      role: record.role,
      kingdom: record.kingdomId,
      activity: record.currentActivityId,
    });
    return true;
  }

  logoutCitizen(record) {
    const bot = this.getBot(record);
    if (!bot) {
      record.online = false;
      record.currentActivityId = null;
      return;
    }
    try {
      bot.getForcedLogoutTimer?.().start?.(0);
    } catch (error) {
      // Optional API; requestLogout is the real path.
    }
    bot.requestLogout?.();
    // The runtime's onPlayerLogout -> handleDisconnect removes the entry;
    // the roster record (personality, goal, schedule) survives.
    record.online = false;
    record.currentActivityId = null;
    this.log("citizen logged out", { citizen: record.username, reason: "schedule" });
  }

  switchActivity(record, activityId) {
    const bot = this.getBot(record);
    if (!bot || record.currentActivityId === activityId) {
      return;
    }
    const ok = startActivity(bot, activityId, { nowMs: Date.now() });
    if (ok) {
      record.currentActivityId = activityId;
      this.log("citizen activity switched", {
        citizen: record.username,
        activity: activityId,
      });
    }
  }

  /** Guard promotions: rank_up goals walk the ladder via kingdom:rank-granted. */
  maybePromote(record, bot) {
    const rank = bot.getAttribute?.(ATTR_KINGDOM_RANK);
    const index = GUARD_PROMOTION_LADDER.indexOf(rank);
    if (index < 0 || index >= GUARD_PROMOTION_LADDER.length - 1) {
      return;
    }
    const next = GUARD_PROMOTION_LADDER[index + 1];
    bot.setAttribute?.(ATTR_KINGDOM_RANK, next);
    this.api.emitCustomEvent(EVENT_RANK_GRANTED, {
      player: bot,
      kingdomId: record.kingdomId,
      rank: next,
    });
    try {
      bot.forceChat?.(`Promoted to ${next}! The ${record.kingdomId} guard thanks you.`);
    } catch (error) {
      // Cosmetic.
    }
    this.log("guard promoted", { citizen: record.username, rank: next });
  }

  tickGoals(record, bot, phase) {
    const nowMs = Date.now();
    const elapsedHours = Math.max(0, (nowMs - record.lastTickAt) / 3600000);
    record.lastTickAt = nowMs;
    const entry = this.runtime()?.entriesByUsername?.get(record.username);
    const state = entry?.state;
    const workCycles = state?.citizens?.workCyclesBanked ?? 0;
    if (state?.citizens) {
      state.citizens.workCyclesBanked = 0; // consumed by this sample
    }
    const { progress, complete } = sampleGoalProgress(record.goal, bot, {
      dutyHoursAccrued: phase.onDuty === true ? elapsedHours : 0,
      workCyclesBanked: workCycles,
    });
    record.goal = { ...record.goal, progress };
    bot.setAttribute?.(ATTR_CITIZEN_GOAL, record.goal);
    if (complete && !record.goal.completedAt) {
      record.goal = { ...record.goal, completedAt: nowMs };
      bot.setAttribute?.(ATTR_CITIZEN_GOAL, record.goal);
      this.log("goal complete", {
        citizen: record.username,
        goal: record.goal.type,
        tier: record.goalTier,
      });
      if (record.goal.type === GOAL_RANK_UP) {
        this.maybePromote(record, bot);
      }
      record.goalTier += 1;
      record.goal = nextGoalForRole(record.role, record.goalTier);
      bot.setAttribute?.(ATTR_CITIZEN_GOAL, record.goal);
    }
  }

  tick() {
    const hour = hourNow();
    for (const record of this.roster.values()) {
      const phase = desiredPhase(record, hour);
      const online = this.isOnline(record);
      if (!phase.online) {
        if (online) {
          this.logoutCitizen(record);
        }
        continue;
      }
      if (!online) {
        this.spawnCitizen(record);
        continue;
      }
      const bot = this.getBot(record);
      if (!bot) {
        continue;
      }
      if (phase.activityId && phase.activityId !== record.currentActivityId) {
        this.switchActivity(record, phase.activityId);
      }
      // Keep the kingdom attributes fresh (cheap, idempotent).
      if (bot.getAttribute?.(ATTR_KINGDOM_ID) !== record.kingdomId) {
        bot.setAttribute?.(ATTR_KINGDOM_ID, record.kingdomId);
      }
      this.tickGoals(record, bot, phase);
    }
  }

  status() {
    const byRole = {};
    const byKingdom = {};
    let online = 0;
    for (const record of this.roster.values()) {
      byRole[record.role] = (byRole[record.role] ?? 0) + 1;
      byKingdom[record.kingdomId] = (byKingdom[record.kingdomId] ?? 0) + 1;
      if (this.isOnline(record)) {
        online += 1;
      }
    }
    return { total: this.roster.size, online, byRole, byKingdom };
  }
}

let director = null;

function initDirector(api, registry) {
  if (director) {
    return director;
  }
  director = new CitizenDirector({ api, registry });
  return director;
}

function getDirector() {
  return director;
}

module.exports = {
  CitizenDirector,
  initDirector,
  getDirector,
  desiredPhase,
};
