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
const { registerCitizenForChat, unregisterCitizenForChat } = require("../chat/CitizenChat");
const { getMemory } = require("../lib/CitizenMemory");
const { getJournal } = require("../lib/CitizenJournal");
const { dropNeeds } = require("../brain/CitizenNeeds");
const { backgroundStep } = require("../lib/CitizenBackground");
const { maybeSocialize, maybeGreetPlayer } = require("../chat/CitizenSocial");
const SocialMechanics = require("../lib/CitizenSocialMechanics");
const CitizenFavors = require("../lib/CitizenFavors");
const ActivityParties = require("../lib/CitizenActivityParties");
const BossRuns = require("../lib/CitizenBossRuns");
const CitizenWarfare = require("../lib/CitizenWarfare");
const CitizenCampaigns = require("../lib/CitizenCampaigns");
const CitizenCrafting = require("../lib/CitizenCrafting");
const CitizenSkilling = require("../lib/CitizenSkilling");
const CitizenOffices = require("../lib/CitizenOffices");
const CitizenDailyRoutines = require("../lib/CitizenDailyRoutines");
const CitizenAlive = require("../lib/CitizenAlive");
const CitizenWorkLoops = require("../lib/CitizenWorkLoops");
const CitizenShopkeeping = require("../lib/CitizenShopkeeping");
const CitizenMarketStalls = require("../lib/CitizenMarketStalls");
const CitizenCompanions = require("../lib/CitizenCompanions");
const CitizenRelationships = require("../lib/CitizenRelationships");
const CitizenHangouts = require("../lib/CitizenHangouts");
const { tickToasts } = require("../lib/CitizenToasts");
const { tickFestivals } = require("../lib/CitizenFestivals");
const { tickWeatherReactions } = require("../lib/CitizenWeatherReactions");
const { tickShoppers } = require("../shop/CitizenShoppers");
const { configuredSpread } = require("../lib/CitizenTimingDesync");
const CitizenBonds = require("../lib/CitizenBonds");
const CitizenKinship = require("../lib/CitizenKinship");
const { normalizeName } = require("../lib/CitizenBonds");
const { siteTileByKingdom, KINGDOM_IDS } = require("../brain/CitizenSites");
const {
  ensureNeeds,
  needsSnapshot,
  tickNeeds,
  attemptFeed,
  sellsFood,
  HUNGRY_AT,
} = require("../brain/CitizenNeeds");
const KingdomStore = require("../../kingdoms/KingdomStore");
const {
  ATTR_KINGDOM_ID,
  ATTR_KINGDOM_RANK,
  ATTR_CITIZEN_ROLE,
  ATTR_CITIZEN_PERSONALITY,
  ATTR_CITIZEN_GOAL,
  ATTR_CITIZEN_SEED,
  ATTR_CITIZEN_NEEDS,
  ROLE_GUARD,
  ROLE_MERCHANT,
  ROLE_COMMONER,
  ROLE_COURTIER,
  ROLE_REFUGEE,
  ROLE_ACTIVITY,
  ACTIVITY_TAVERN_SOCIAL,
  ACTIVITY_LEISURE_STROLL,
  ACTIVITY_REFUGEE_FLIGHT,
  EVENT_RANK_GRANTED,
} = require("../constants");

const DIRECTOR_TICK_TICKS = 100; // ~60s at 600ms/tick

// --- Proximity-based citizen lifecycle (memory optimization, 2026-10-07) ---
// Citizens are full Player objects (~3MB each). When no real player is near,
// the Player object is despawned — the citizen lives on as a roster record
// (data tier: journal, needs, kinship, crafting all run on the record).
// The Player rematerializes when a real player approaches.
// Hysteresis (spawn < despawn) prevents thrash at the boundary.
const CITIZEN_SPAWN_RADIUS = 50; // tiles from home: spawn when a real player is this close
const CITIZEN_DESPAWN_RADIUS = 75; // tiles from current pos: despawn when no real player within this
const PROXIMITY_TICK_TICKS = 17; // ~10s at 600ms/tick: fast spawn/despawn for responsiveness

// role -> rank granted through the kingdoms plugin's hierarchy.
const ROLE_RANK = Object.freeze({
  [ROLE_GUARD]: "Man-at-arms",
  [ROLE_MERCHANT]: "Subject",
  [ROLE_COMMONER]: "Subject",
  [ROLE_COURTIER]: "Lord",
  [ROLE_REFUGEE]: "Subject",
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
      [ROLE_GUARD]: 4,
      [ROLE_MERCHANT]: 3,
      [ROLE_COMMONER]: 10,
      [ROLE_COURTIER]: 3,
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
      // Meal breaks: the watch eats at noon and at supper, duty resumes after.
      if ((hour >= 12 && hour < 13) || (hour >= 19 && hour < 20)) {
        return { online: true, activityId: ACTIVITY_TAVERN_SOCIAL, onDuty: false };
      }
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
    case ROLE_MERCHANT: {
      if (record.merchantKind === "prime") {
        // The prime: stall 08:00-19:00 with a lunch break, then the tavern
        // after closing. Otherwise "home".
        if (hour >= 12 && hour < 13) {
          return { online: true, activityId: ACTIVITY_TAVERN_SOCIAL };
        }
        if (hour >= 8 && hour < 19) {
          return { online: true, activityId: ACTIVITY_PRIME_MERCHANT };
        }
        if (hour >= 19 && hour < 22) {
          return { online: true, activityId: ACTIVITY_TAVERN_SOCIAL };
        }
        return { online: false, activityId: null };
      }
      // Supplier + provisioner: stall 08:00-19:00 with a lunch break at the
      // tavern; otherwise the merchant is "home".
      if (hour >= 12 && hour < 13) {
        return { online: true, activityId: ACTIVITY_TAVERN_SOCIAL };
      }
      return {
        online: hour >= 8 && hour < 19,
        activityId: ROLE_ACTIVITY[ROLE_MERCHANT],
      };
    }
    case ROLE_COMMONER:
      // The routine action runs the day itself; the director only sleeps them.
      return { online: true, activityId: ROLE_ACTIVITY[ROLE_COMMONER] };
    case ROLE_COURTIER:      // Morning court, lunch, an afternoon of leisure, then the tavern evening.
      if (hour >= 9 && hour < 12) {
        return { online: true, activityId: ROLE_ACTIVITY[ROLE_COURTIER] };
      }
      if (hour >= 12 && hour < 13) {
        return { online: true, activityId: ACTIVITY_TAVERN_SOCIAL };
      }
      if (hour >= 13 && hour < 17) {
        return { online: true, activityId: ACTIVITY_LEISURE_STROLL };
      }
      if (hour >= 17 && hour < 23) {
        return { online: true, activityId: ACTIVITY_TAVERN_SOCIAL };
      }
      return { online: false, activityId: null };
    case ROLE_REFUGEE:
      // Refugees keep no schedule — they flee until the war ends, when
      // WarRefugees logs them out and drops their roster records.
      return { online: true, activityId: ACTIVITY_REFUGEE_FLIGHT };
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
    // Timing desync: monotonically increasing proximity-tick counter. Each
    // citizen's tick offset comes from their username hash (stable across
    // restarts), so the counter itself doesn't need persisting.
    this.aiTickCount = 0;
    this._desyncSpread = null;
    try {
      SocialMechanics.init(api);
    } catch {
      // Non-fatal.
    }
  }

  runtime() {
    return getActiveBotRuntime()?.runtime ?? null;
  }

  /**
   * Timing-desync spread: how many ticks a full citizen rotation takes.
   * Resolved once from CITIZEN_DESYNC_SPREAD (default 10).
   */
  desyncSpread() {
    if (this._desyncSpread == null) {
      this._desyncSpread = configuredSpread();
    }
    return this._desyncSpread;
  }

  log(message, extra) {
    try {
      this.api.log?.(`[citizens] ${message}`, extra);
    } catch (error) {
      // Logging must never break the director.
    }
  }

  /**
   * Pick a home tile near the anchor that isn't inside a wall/mountain.
   * noisyTile alone can land inside blocked terrain (Keldagrim's mountains);
   * we probe the noisy pick plus a small ring and fall back to the anchor.
   */
  findWalkableHome(anchor, rng) {
    const z = anchor.z ?? 0;
    const candidates = [noisyTile(anchor.x, anchor.y, 12, rng)];
    // Ring of fallbacks at increasing distance, in case the first pick is blocked.
    for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3], [6, 6], [-6, -6]]) {
      candidates.push({ x: anchor.x + dx, y: anchor.y + dy });
    }
    candidates.push({ x: anchor.x, y: anchor.y }); // anchor itself, last resort
    let regionManager = null;
    try {
      regionManager = this.api?.getRegionManager?.() ?? null;
    } catch {
      regionManager = null;
    }
    for (const c of candidates) {
      const x = Math.round(c.x);
      const y = Math.round(c.y);
      if (regionManager) {
        try {
          const loc = new Location(x, y, z);
          if (regionManager.blocked(loc, null)) {
            continue; // inside a wall/mountain — try next
          }
        } catch {
          // If the check itself fails, accept the tile (don't strand citizens).
        }
      }
      return { x, y };
    }
    return { x: anchor.x, y: anchor.y };
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
    // Citizens live near the market or square of their kingdom's capital.
    // Commoners split between market and square so cities feel populated
    // in multiple areas, not just clustered at one spot.
    const useSquare = role === "commoner" && rng() < 0.4;
    let anchorKind = useSquare ? "square" : "market";
    // Keldagrim has two populated anchors (city center + entrance plaza);
    // split square-spawners across both so new players see life at spawn.
    if (
      useSquare &&
      kingdomId === "keldagrim" &&
      siteTileByKingdom(kingdomId, "square2") &&
      rng() < 0.5
    ) {
      anchorKind = "square2";
    }
    const anchor = siteTileByKingdom(kingdomId, anchorKind)
      ?? { x: 3200, y: 3200, z: 0 };
    const home = this.findWalkableHome(anchor, rng);
    home.z = anchor.z ?? 0;
    const watch = role === ROLE_GUARD ? Math.floor(rng() * 3) : 0;
    // Guards sleep inside their off-watch hours so the night watch is actually
    // manned; everyone else keeps a seeded night window.
    const sleepStart =
      role === ROLE_GUARD ? [23, 0, 8][watch] : [22, 23, 0][Math.floor(rng() * 3)];
    // Merchant specialization, in roster order per kingdom: the prime runs the
    // fully-real sword stall (restocks wholesale from the supplier), the
    // supplier wholesales swords, the provisioner sells bread.
    let merchantKind = null;
    if (role === ROLE_MERCHANT) {
      let merchantsSoFar = 0;
      for (const other of this.roster.values()) {
        if (other.kingdomId === kingdomId && other.role === ROLE_MERCHANT) {
          merchantsSoFar += 1;
        }
      }
      merchantKind = ["prime", "supplier", "provisioner"][merchantsSoFar % 3];
    }
    const record = {
      username,
      personality,
      kingdomId,
      role,
      merchantKind,
      home,
      seed: personality.seed,
      sleepStart,
      sleepHours: 6 + Math.floor(rng() * 3),
      watch,
      goal: nextGoalForRole(role, 0),
      goalTier: 0,
      // Emotional weather (see lib/emotions.js): how they FEEL right now.
      // Shifted by background events, decays toward calm each tick.
      emotion: { state: "calm", intensity: 0, cause: null, updatedAt: 0 },
      online: false,
      currentActivityId: null,
      lastTickAt: Date.now(),
    };
    // Roster keys are normalized (lowercase): every lib module looks citizens
    // up via normalizeName, and mixed-case keys silently missed. The record
    // keeps the raw display username.
    this.roster.set(normalizeName(username), record);
    ensureNeeds(username); // needs survive logout; the director ticks them offline too
    return record;
  }

  /**
   * A bespoke citizen: fixed name, fixed personality, fixed schedule. The
   * record has exactly the shape addCitizen builds, so the tick (spawn,
   * logout, activity switching, goals) treats them like anyone else. The
   * personality may carry an optional `secret` — folded into the
   * personality card so the LLM mouth knows what they hide and that they
   * deflect questions about it. Name collisions fall back to addCitizen's
   * generated pool.
   */
  addNamedCitizen({
    name,
    kingdomId,
    role,
    traits,
    quirk,
    secret,
    homeTile,
    sleepStart = 23,
    sleepHours = 7,
  }) {
    if (!name || !kingdomId || !role) {
      this.log("named citizen rejected (missing name/kingdom/role)", { name });
      return null;
    }
    let username = String(name);
    if (this.roster.has(normalizeName(username)) || this.usedNames.has(username)) {
      this.log("named citizen rejected (name taken)", { name });
      return null;
    }
    this.usedNames.add(username);
    const rng = agentRng(`director:named:${username}`);
    const market = siteTileByKingdom(kingdomId, "market") ?? { x: 3200, y: 3200, z: 0 };
    const home = homeTile
      ? { x: homeTile.x, y: homeTile.y, z: homeTile.z ?? 0 }
      : this.findWalkableHome(market, rng);
    const personality = {
      name: username,
      role,
      kingdomId,
      traits: Array.isArray(traits) && traits.length > 0 ? traits.slice(0, 3) : ["dutiful", "suspicious"],
      quirk: quirk ?? "keeps their own counsel",
      seed: Math.floor(rng() * 1_000_000_000),
    };
    if (secret) {
      personality.secret = String(secret);
    }
    const record = {
      username,
      personality,
      kingdomId,
      role,
      merchantKind: null,
      home,
      seed: personality.seed,
      sleepStart,
      sleepHours,
      watch: 0,
      goal: nextGoalForRole(role, 0),
      goalTier: 0,
      // Emotional weather (see lib/emotions.js): how they FEEL right now.
      emotion: { state: "calm", intensity: 0, cause: null, updatedAt: 0 },
      online: false,
      currentActivityId: null,
      lastTickAt: Date.now(),
      named: true,
    };
    this.roster.set(normalizeName(username), record);
    ensureNeeds(username);
    this.log("named citizen added", { citizen: username, role, kingdom: kingdomId });
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
    this.api.getTaskManager?.()?.submit(new DirectorTask(DIRECTOR_TICK_TICKS));
    // Fast proximity task: spawn/despawn citizens as real players move.
    // The 60s director tick is too slow for "walk into town, see people".
    class ProximityTask extends Task {
      execute() {
        try {
          director.tickProximity();
        } catch (error) {
          director.log("proximity tick failed", {
            error: String(error?.message ?? error),
          });
        }
      }
    }
    this.api.getTaskManager?.()?.submit(new ProximityTask(PROXIMITY_TICK_TICKS));
  }

  /**
   * Real (non-bot) player positions, cached per proximity tick.
   * Used to decide which citizens need a materialized Player object.
   */
  realPlayerPositions() {
    const out = [];
    try {
      const World = this.api.core?.World;
      const players = World?.players;
      if (!players || typeof players.forEach !== "function") {
        return out;
      }
      players.forEach((p) => {
        try {
          // Bots are players too — only real humans trigger citizen spawning.
          if (!p || p.isPlayerBot?.() === true) {
            return;
          }
          const loc = p.getLocation?.();
          if (!loc) {
            return;
          }
          out.push({
            x: loc.getX?.() ?? loc.x ?? 0,
            y: loc.getY?.() ?? loc.y ?? 0,
            z: loc.getZ?.() ?? loc.z ?? 0,
          });
        } catch {
          // Skip unreadable players.
        }
      });
    } catch {
      // World not ready.
    }
    return out;
  }

  /**
   * Is there a real player within `radius` tiles of (x, y, z)?
   * Chebyshev distance (matches the engine's view-distance math).
   */
  anyRealPlayerNear(x, y, z, radius, positions) {
    for (const p of positions) {
      if ((p.z ?? 0) !== (z ?? 0)) {
        continue;
      }
      const dx = Math.abs((p.x ?? 0) - (x ?? 0));
      const dy = Math.abs((p.y ?? 0) - (y ?? 0));
      if (Math.max(dx, dy) <= radius) {
        return true;
      }
    }
    return false;
  }

  /**
   * Fast tick (~10s): reconcile each citizen's materialized Player against
   * real-player proximity. Spawn when a human approaches, despawn when the
   * area is empty. The data tier (journal, needs, kinship, crafting) runs on
   * the roster record regardless — this only controls the ~3MB Player object.
   */
  tickProximity() {
    // Timing desync: stagger the visible-life AI so the whole population
    // doesn't act in one synchronized wave. Each citizen's slot comes from
    // a hash of their username (stable across restarts); the phase advances
    // every proximity tick, so ~1/spread of citizens are due per tick.
    // The systems keep their own tick loops — desync just gates them.
    this.aiTickCount += 1;
    const desync = { tick: this.aiTickCount, spread: this.desyncSpread() };
    const hour = hourNow();
    const positions = this.realPlayerPositions();
    for (const record of this.roster.values()) {
      try {
        const phase = desiredPhase(record, hour);
        // Asleep or off-schedule: the slow tick handles logout.
        if (!phase.online) {
          continue;
        }
        const online = this.isOnline(record);
        if (!online) {
          // Spawn check: use home (the citizen has no live position yet).
          const home = record.home ?? { x: 3200, y: 3200, z: 0 };
          if (
            this.anyRealPlayerNear(
              home.x,
              home.y,
              home.z ?? 0,
              CITIZEN_SPAWN_RADIUS,
              positions
            )
          ) {
            this.spawnCitizen(record);
          }
          continue;
        }
        // Despawn check: use the bot's CURRENT position (it may have
        // wandered/patrolled away from home).
        const bot = this.getBot(record);
        let bx = record.home?.x ?? 3200;
        let by = record.home?.y ?? 3200;
        let bz = record.home?.z ?? 0;
        try {
          const loc = bot?.getLocation?.();
          if (loc) {
            bx = loc.getX?.() ?? loc.x ?? bx;
            by = loc.getY?.() ?? loc.y ?? by;
            bz = loc.getZ?.() ?? loc.z ?? bz;
          }
        } catch {
          // Fall back to home.
        }
        if (
          !this.anyRealPlayerNear(bx, by, bz, CITIZEN_DESPAWN_RADIUS, positions)
        ) {
          this.logoutCitizen(record);
          this.log("citizen despawned (no players near)", {
            citizen: record.username,
          });
        } else {
          // A real player is close enough to keep this citizen materialized.
          // Stamp it so the brain LOD treats them as observed even if the
          // LOD's own session scan misses the player (web-client sessions).
          this.markHumanNearby(record);
        }
      } catch (error) {
        this.log("proximity check failed", {
          citizen: record.username,
          error: String(error?.message ?? error),
        });
      }
    }
    // Visible life runs on the fast (~10s) tick, not the slow (~60s)
    // director tick: facing, idle animations, greetings, and emote
    // reactions need to happen often enough for players to actually see
    // them. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenAlive.tickAlive(this, Date.now(), desync);
    } catch (error) {
      this.log("alive (proximity) failed", { error: String(error?.message ?? error) });
    }
    // In-town ambient craft-station work loops: idle commoners near a
    // forge/anvil/range/workbench/stall do short visible work loops, but
    // only while a real player is actually around to see them.
    // Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenWorkLoops.tickWorkLoops(this, Date.now(), desync);
    } catch (error) {
      this.log("work loops (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Merchant shopkeeping: shop owners visibly restock/arrange/sweep and
    // greet customers, but only while a real player is actually around to
    // see them. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenShopkeeping.tickShopkeeping(this, Date.now());
    } catch (error) {
      this.log("shopkeeping (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Market stalls: merchants claim a pitch during market hours, set up
    // 3-5 wares with personality-driven prices, haggle with liked
    // customers, and pack up at night. Data tier, zero LLM,
    // per-citizen try/catch inside.
    try {
      CitizenMarketStalls.tickMarketStalls(this, Date.now());
    } catch (error) {
      this.log("market stalls (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Personal companion invites: citizens invite nearby players on 1-on-1
    // outings (fishing, dungeon, walk, tavern) and remember yes/no.
    // Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenCompanions.tickCompanions(this, Date.now());
    } catch (error) {
      this.log("companions (proximity) failed", { error: String(error?.message ?? error) });
    }
  }

  isOnline(record) {
    const runtime = this.runtime();
    return !!runtime?.entriesByUsername?.has(record.username);
  }

  getBot(record) {
    return this.runtime()?.entriesByUsername?.get(record.username)?.player ?? null;
  }

  /**
   * Stamp the citizen's brain state so the LOD treats them as human-observed.
   * The proximity task already proved a real player is within range; the
   * BotBehaviorTask's own session scan can miss web-client sessions, which
   * left citizens on the 1/10th far stride while Jon stood next to them.
   */
  markHumanNearby(record) {
    try {
      const state = this.runtime()?.botStatesByName?.get(record.username);
      if (state) {
        state.humanNearbyAt = Date.now();
      }
    } catch {
      // Never break the proximity tick.
    }
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
    const needs = ensureNeeds(record.username);
    if (needs) {
      bot.setAttribute?.(ATTR_CITIZEN_NEEDS, needsSnapshot(needs));
    }

    // Merchant specialization: the prime runs the fully-real sword stall,
    // the supplier wholesales swords to the prime, the provisioner sells
    // bread. Opening floats are real inventory, seeded once at spawn.
    const ItemIds = this.api.core?.ItemIds ?? {};
    const SWORD = ItemIds.BRONZE_SWORD ?? 1277;
    const BREAD = ItemIds.BREAD ?? 2309;
    const COINS = ItemIds.COINS ?? 995;
    if (record.role === ROLE_MERCHANT) {
      const inventory = bot.getInventory?.();
      if (record.merchantKind === "prime") {
        bot.setAttribute?.(ATTR_PRIME_MERCHANT, "1");
        bot.setAttribute?.(ATTR_WARE_ITEM, SWORD);
        bot.setAttribute?.(ATTR_WARE_PRICE, 78);
        inventory?.adds?.(COINS, 800);
        inventory?.adds?.(SWORD, 10);
      } else if (record.merchantKind === "supplier") {
        bot.setAttribute?.(ATTR_SUPPLIER_MERCHANT, "1");
        bot.setAttribute?.(ATTR_WARE_ITEM, SWORD);
        bot.setAttribute?.(ATTR_WARE_PRICE, 78);
        inventory?.adds?.(SWORD, 60);
        inventory?.adds?.(COINS, 300);
      } else {
        inventory?.adds?.(BREAD, 24);
      }
    }
    // Crafted goods accrued while offline come out of the stockpile.
    try {
      CitizenCrafting.claimStockpile(record, bot);
    } catch (error) {
      this.log?.("craft stockpile claim failed", {
        citizen: record.username,
        error: String(error?.message ?? error),
      });
    }

    const state = createInitialState(
      { x: record.home.x, y: record.home.y, z: record.home.z ?? 0 },
      { ROAMING: "roaming" }
    );
    state.citizens = { director: true, workCyclesBanked: 0 };
    // LOD marker: the bot brain throttles citizens harder than other bots
    // when no real player is near (see BotBehaviorTask.resolveEntryStride).
    state.isCitizen = true;
    // Spawned because a real player is within range — start active, not throttled.
    state.humanNearbyAt = Date.now();

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

    // Bypass: the World's add-player queue does not drain for bots, so add
    // directly to the World's player list. See queue-drain investigation.
    try {
      const World = this.api.core?.World;
      if (World && World.players && typeof World.players.add === "function") {
        // Remove from queue first to avoid duplicates
        const queue = World.getAddPlayerQueue?.();
        if (queue) {
          const idx = queue.indexOf(bot);
          if (idx >= 0) queue.splice(idx, 1);
        }
        World.players.add(bot, true); // true = isBot, doesn't take human slot
      }
    } catch {
      // Non-fatal: bot remains in the add-player queue.
    }

    const activity =
      record.merchantKind === "prime"
        ? this.registry.byId.get(ACTIVITY_PRIME_MERCHANT)
        : this.registry.byId.get(ROLE_ACTIVITY[record.role]);
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
    // Unregister from the LLM gateway chat — the registration holds a
    // buildContext closure per citizen. Without this, the interceptor's
    // map retains entries for despawned citizens. Memory-leak plug, 2026-10-07.
    try {
      unregisterCitizenForChat(record.username);
    } catch {
      // Non-fatal — chat registration is best-effort.
    }
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

  /**
   * Permanently remove a citizen (refugee column stood down at peace, war
   * casualty). Roster removal alone left orphaned data in every subsystem —
   * journal, memory, needs, kinship bonds, chat registration — which
   * accumulated across wars. This is the single choke point for full
   * cleanup. Memory-leak plug, 2026-10-07.
   */
  removeCitizen(record) {
    if (!record) return false;
    const username = record.username;
    const key = normalizeName(username);
    try {
      this.logoutCitizen(record);
    } catch {
      // Non-fatal — continue cleanup.
    }
    try {
      CitizenBonds.clearParty(username);
    } catch {
      // Non-fatal.
    }
    try {
      CitizenBonds.clearFollow(username);
    } catch {
      // Non-fatal.
    }
    try {
      getJournal().forget(username);
    } catch {
      // Non-fatal.
    }
    try {
      getMemory().forget(username);
    } catch {
      // Non-fatal.
    }
    try {
      dropNeeds(username);
    } catch {
      // Non-fatal.
    }
    try {
      CitizenKinship.getKinship().forgetCitizen(username);
    } catch {
      // Non-fatal.
    }
    try {
      unregisterCitizenForChat(username);
    } catch {
      // Non-fatal.
    }
    this.roster.delete(key);
    this.usedNames.delete(username);
    this.log("citizen removed", { citizen: username });
    return true;
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
      citizenName: record.username,
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

  /**
   * Bread-selling merchants of this kingdom near the citizen — the food
   * sellers a hungry citizen can actually walk up to.
   */
  foodSellersNear(record, bot) {
    if (!bot) {
      return [];
    }
    let botLoc = null;
    try {
      botLoc = bot.getLocation?.();
    } catch (error) {
      return [];
    }
    if (!botLoc) {
      return [];
    }
    return this.onlineBotsForKingdom(record.kingdomId, ROLE_MERCHANT).filter(
      (merchant) => {
        if (merchant === bot || !sellsFood(merchant)) {
          return false;
        }
        try {
          return merchant.getLocation?.()?.getDistance?.(botLoc) <= 15;
        } catch (error) {
          return false;
        }
      }
    );
  }

  tick() {
    const hour = hourNow();
    const nowMs = Date.now();
    for (const record of this.roster.values()) {
      const online = this.isOnline(record);
      const bot = online ? this.getBot(record) : null;
      // Background tier (Jon's two-tier sim): every citizen lives as data
      // every tick, online or off. Zero LLM — just the journal advancing.
      // The foreground LLM reads this when a player actually interacts.
      try {
        backgroundStep(record, this, online);
      } catch (error) {
        this.log("background step failed", {
          citizen: record.username,
          error: String(error?.message ?? error),
        });
      }
      // Social mechanics + agency (data tier, zero LLM). Agency runs for
      // everyone — citizens pursue goals even offline. Social (invites,
      // friend requests) only for online citizens with players nearby.
      try {
        const arng = agentRng(`agency:${record.username}:${Date.now() >> 16}`);
        SocialMechanics.tickAgency(record, arng);
      } catch (error) {
        this.log("agency failed", {
          citizen: record.username,
          error: String(error?.message ?? error),
        });
      }
      if (online && bot) {
        try {
          const nearby = [];
          try {
            for (const p of bot.getLocalPlayers?.() ?? []) {
              if (p !== bot && p?.isPlayerBot?.() !== true) nearby.push(p);
            }
          } catch {
            // Non-fatal.
          }
          SocialMechanics.tickCitizen(record, (r) => this.getBot(r), nearby);
          // Follow behavior: party members follow the leader, boss-trip
          // partners travel together. Re-applied each tick (data tier drives).
          SocialMechanics.tickFollow(record, (r) => this.getBot(r));
          // Citizen-initiated favors: bounded asks to nearby players
          // (data tier, zero LLM). deps resolve item names from the cache.
          CitizenFavors.tickFavors(record, (r) => this.getBot(r), nearby, {
            itemName: (id) =>
              this.api?.core?.ItemDefinition?.forId?.(id)?.getName?.() ?? null,
          });
        } catch (error) {
          this.log("social mechanics failed", {
            citizen: record.username,
            error: String(error?.message ?? error),
          });
        }
      }
      // Needs decay for everyone (the logged-out are asleep and recover);
      // the visible threshold lines only fire for online citizens.
      const needs = tickNeeds(record.username, bot, nowMs);
      const phase = desiredPhase(record, hour);
      if (!phase.online) {
        if (online) {
          this.logoutCitizen(record);
        }
        continue;
      }
      if (!online) {
        // Proximity gate: only materialize the Player object when a real
        // player is near. The fast proximity task (~10s) handles the actual
        // spawn; the slow tick just skips so they don't fight.
        continue;
      }
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
      // Hungry citizens feed themselves: own bread first, then buy a loaf
      // from a nearby bread merchant. The broke go visibly hungry.
      if (needs && needs.hunger < HUNGRY_AT) {
        attemptFeed(bot, this.foodSellersNear(record, bot));
      }
    }
    this.tickMemory(nowMs);
    // Citizen kinship: friendships, romances, weddings and feuds between
    // citizens — the social fabric that makes them read as real people.
    // Data tier, zero LLM.
    try {
      CitizenKinship.tickKinship(this, hour, nowMs);
    } catch (error) {
      this.log("kinship failed", { error: String(error?.message ?? error) });
    }
    // Foreground social: citizen-to-citizen LLM dialogue, ONLY when a real
    // player is nearby to overhear (Jon's two-tier rule). Otherwise the
    // background journal already recorded that they talked — zero tokens.
    try {
      maybeSocialize(this, nowMs);
    } catch (error) {
      this.log("socialize failed", { error: String(error?.message ?? error) });
    }
    // Unprompted greetings: citizens notice real players and sometimes speak
    // first. Same two-tier rule — only when the player is actually there.
    try {
      maybeGreetPlayer(this, nowMs);
    } catch (error) {
      this.log("greet failed", { error: String(error?.message ?? error) });
    }
    // Autonomous activity parties: citizens form their own groups (fishing
    // trips, market runs, work details, tavern nights), travel together,
    // and split loot. Data tier, zero LLM.
    try {
      ActivityParties.tickParties(this, hour);
    } catch (error) {
      this.log("activity parties failed", { error: String(error?.message ?? error) });
    }
    // Autonomous boss runs: guard-led parties take on the Giant Mole in the
    // Falador mole hole, split the loot, and head home. Data tier, zero LLM.
    try {
      BossRuns.tickBossRuns(this, hour);
    } catch (error) {
      this.log("boss runs failed", { error: String(error?.message ?? error) });
    }
    // Citizens in warfare: militia musters, war news and morale, and war
    // demand on the economy. Data tier, zero LLM.
    try {
      CitizenWarfare.tickWarfare(this, hour);
    } catch (error) {
      this.log("warfare failed", { error: String(error?.message ?? error) });
    }
    // Expeditionary warfare: citizen armies rally, march to the border,
    // fight journaled battles with real casualties, and march home.
    // Data tier, zero LLM.
    try {
      CitizenCampaigns.tickCampaigns(this, hour);
    } catch (error) {
      this.log("campaigns failed", { error: String(error?.message ?? error) });
    }
    // Citizen crafting: suppliers forge swords, provisioners bake bread —
    // the supply chain's root, producing on wall-clock time online or off.
    // Data tier, zero LLM.
    try {
      CitizenCrafting.tickCrafting(this, nowMs);
    } catch (error) {
      this.log("crafting failed", { error: String(error?.message ?? error) });
    }
    // Visible citizen skilling: persistent XP/levels, skilling sessions and
    // parties with real animations at work sites, docks, quarries, taverns.
    // Data tier, zero LLM.
    try {
      CitizenSkilling.tickSkilling(this, hour);
    } catch (error) {
      this.log("skilling failed", { error: String(error?.message ?? error) });
    }
    // Visible daily routines: merchants open stalls, crafters work visible
    // forge shifts, guards patrol — phase transitions journaled and
    // announced, followers acknowledged. Data tier, zero LLM.
    try {
      CitizenDailyRoutines.tickRoutines(this, hour);
    } catch (error) {
      this.log("daily routines failed", { error: String(error?.message ?? error) });
    }
    // Citizen shoppers: citizens browse player-owned market stalls and buy
    // (needs, role wants, bargain-hunting vs the reference feed). Closes the
    // economic loop — players can sell, not just buy. Data tier, zero LLM.
    try {
      tickShoppers(this, hour);
    } catch (error) {
      this.log("shoppers failed", { error: String(error?.message ?? error) });
    }
    // Citizen "alive" layer: stuck detection & recovery, idle life
    // (facing, emotes, observations), citizen-to-citizen social awareness,
    // and player-like imperfections (distractions, changed minds).
    // Data tier, zero LLM. Desynced like the proximity pass so the slow
    // tick doesn't reintroduce a full-population wave every 60s.
    try {
      CitizenAlive.tickAlive(this, nowMs, {
        tick: this.aiTickCount,
        spread: this.desyncSpread(),
      });
    } catch (error) {
      this.log("alive failed", { error: String(error?.message ?? error) });
    }
    // Player guilds: citizen recruitment (compatible personalities join on
    // their own) and guild outings (muster at the hall, group activities).
    // Data tier, zero LLM.
    try {
      const GuildRecruitment = require("../../guilds/GuildRecruitment");
      GuildRecruitment.tickRecruitment(this);
    } catch (error) {
      this.log("guild recruitment failed", { error: String(error?.message ?? error) });
    }
    try {
      const GuildActivities = require("../../guilds/GuildActivities");
      GuildActivities.tickOutings(this, hour);
    } catch (error) {
      this.log("guild outings failed", { error: String(error?.message ?? error) });
    }
    // Citizen offices: bind living citizens to AI-held kingdom offices and
    // let the holders perform their duties (musters, supply orders, ledgers,
    // spymaster rumors). Data tier, zero LLM.
    try {
      CitizenOffices.tickOffices(this, hour);
    } catch (error) {
      this.log("offices failed", { error: String(error?.message ?? error) });
    }
    // Citizen hangouts: visible ambient social clusters — 2-5 citizens
    // converge on a tavern/square/market anchor, linger in a circle
    // chatting, then disperse. Data tier, zero LLM.
    try {
      CitizenHangouts.tickHangouts(this, hour);
    } catch (error) {
      this.log("hangouts failed", { error: String(error?.message ?? error) });
    }
    // Citizen toasts: when a real player lingers at a tavern hangout,
    // a citizen may raise a glass - a scripted toast celebrating journal
    // news from someone present. Data tier, zero LLM.
    try {
      tickToasts(this, nowMs);
    } catch (error) {
      this.log("toasts failed", { error: String(error?.message ?? error) });
    }
    // Citizen weather reactions: when the sky changes (rain starts, storm
    // hits, dusk/night falls, dawn breaks), citizens near a real player
    // react in personality-gated ways - rain-haters hurry home, rain-lovers
    // cheer, the afraid-of-the-dark flee at dusk, early risers greet dawn.
    // Data tier, zero LLM.
    try {
      tickWeatherReactions(this, nowMs);
    } catch (error) {
      this.log("weather reactions failed", { error: String(error?.message ?? error) });
    }
    // Citizen festivals: realm-wide seasonal festivals (5 annual, 3-day
    // windows). Citizens journal their participation (shared history) and,
    // when a real player is near, celebrate with personality-gated lines,
    // dancing, and player invites. Data tier, zero LLM.
    try {
      tickFestivals(this, nowMs);
    } catch (error) {
      this.log("festivals failed", { error: String(error?.message ?? error) });
    }
    // Citizen relationships: friend citizens hail friend players passing
    // nearby, by name. Data tier, zero LLM.
    try {
      CitizenRelationships.tickRelationships(this, nowMs);
    } catch (error) {
      this.log("relationships failed", { error: String(error?.message ?? error) });
    }
    try {
      if (getJournal().saveIfDirty()) {
        this.log("citizen journal saved");
      }
    } catch (error) {
      this.log("citizen journal save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      CitizenBonds.save();
    } catch (error) {
      this.log("citizen bonds save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      require("../../guilds/GuildRegistry").save();
    } catch (error) {
      this.log("guild registry save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      CitizenKinship.getKinship().saveIfDirty();
    } catch (error) {
      this.log("citizen kinship save failed", {
        error: String(error?.message ?? error),
      });
    }
  }

  /**
   * Citizen memory housekeeping on the slow tick: gossip walks the social
   * links (one hop per rumor per while), and the store autosaves when dirty.
   */
  tickMemory(nowMs) {
    let memory;
    try {
      memory = getMemory();
    } catch (error) {
      return;
    }
    const director = this;
    const kingdomMembers = new Map();
    for (const record of this.roster.values()) {
      if (!kingdomMembers.has(record.kingdomId)) {
        kingdomMembers.set(record.kingdomId, []);
      }
      kingdomMembers.get(record.kingdomId).push(record.username);
    }
    try {
      memory.spreadGossipTick(
        {
          kingdomMembers,
          isOnline: (username) => {
            const record = director.roster.get(normalizeName(username));
            return record ? director.isOnline(record) : false;
          },
          botFor: (username) => {
            const record = director.roster.get(normalizeName(username));
            return record ? director.getBot(record) : null;
          },
        },
        nowMs
      );
    } catch (error) {
      this.log("gossip tick failed", { error: String(error?.message ?? error) });
    }
    try {
      if (memory.saveIfDirty()) {
        this.log("citizen memory saved");
      }
    } catch (error) {
      this.log("citizen memory save failed", {
        error: String(error?.message ?? error),
      });
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
