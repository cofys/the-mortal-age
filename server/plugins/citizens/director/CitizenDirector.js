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
const { voiceFor, voiceLine } = require("../lib/citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");

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
const CitizenFishing = require("../brain/actions/CitizenFishing");
const CitizenOffices = require("../lib/CitizenOffices");
const CitizenDailyRoutines = require("../lib/CitizenDailyRoutines");
const CitizenAlive = require("../lib/CitizenAlive");
const CitizenWorkLoops = require("../lib/CitizenWorkLoops");
const CitizenShopkeeping = require("../lib/CitizenShopkeeping");
const CitizenFarmers = require("../lib/CitizenFarmers");
const CitizenMiners = require("../lib/CitizenMiners");
const CitizenFishers = require("../lib/CitizenFishers");
const CitizenHunters = require("../lib/CitizenHunters");
const CitizenCooks = require("../lib/CitizenCooks");
const CitizenTailors = require("../lib/CitizenTailors");
const CitizenBlacksmiths = require("../lib/CitizenBlacksmiths");
const CitizenAlchemists = require("../lib/CitizenAlchemists");
const CitizenHerbalists = require("../lib/CitizenHerbalists");
const CitizenJewelers = require("../lib/CitizenJewelers");
const CitizenSailors = require("../lib/CitizenSailors");
const CitizenHealers = require("../lib/CitizenHealers");
const CitizenScholars = require("../lib/CitizenScholars");
const CitizenRumors = require("../lib/CitizenRumors");
const CitizenGiftGiving = require("../lib/CitizenGiftGiving");
const CitizenMystery = require("../lib/CitizenMystery");
const CitizenTeachers = require("../lib/CitizenTeachers");
const CitizenMarketStalls = require("../lib/CitizenMarketStalls");
const { tickPerformers } = require("../lib/CitizenStreetPerformers");
const { tickBards } = require("../lib/CitizenBards");
const { tickActors } = require("../lib/CitizenActors");
const { tickPainters } = require("../lib/CitizenPainters");
const { tickSculptors } = require("../lib/CitizenSculptors");
const { tickArchitects } = require("../lib/CitizenArchitects");
const { tickDraftfolk } = require("../lib/CitizenArchitects2");
const { tickEngineers } = require("../lib/CitizenEngineers");
const { tickClockmakers } = require("../lib/CitizenClockmakers");
const { tickGlassblowers } = require("../lib/CitizenGlassblowers");
const { tickPotters } = require("../lib/CitizenPotters");
const CitizenGuardPatrols = require("../lib/CitizenGuardPatrols");
const CitizenGuards = require("../lib/CitizenGuards");
const CitizenJudges = require("../lib/CitizenJudges");
const CitizenBankers = require("../lib/CitizenBankers");
const CitizenInnkeepers = require("../lib/CitizenInnkeepers");
const CitizenStablehands = require("../lib/CitizenStablehands");
const CitizenLibrarians = require("../lib/CitizenLibrarians");
const { tickBookfolk } = require("../lib/CitizenLibrarians2");
const { tickEngineerfolk } = require("../lib/CitizenEngineers2");
const { tickMentorfolk } = require("../lib/CitizenMentors2");
const CitizenPriests = require("../lib/CitizenPriests");
const CitizenTaxCollectors = require("../lib/CitizenTaxCollectors");
const CitizenMessengers = require("../lib/CitizenMessengers");
const { tickMessengers2 } = require("../lib/CitizenMessengers2");
const CitizenCartographers = require("../lib/CitizenCartographers");
const { tickMapfolk } = require("../lib/CitizenCartographers2");
const CitizenCompanions = require("../lib/CitizenCompanions");
const CitizenApprentices = require("../lib/CitizenApprentices");
const CitizenArtisans = require("../lib/CitizenArtisans");
const CitizenBuilders = require("../lib/CitizenBuilders");
const CitizenRetirement = require("../lib/CitizenRetirement");
const { tickElections } = require("../lib/CitizenElection");
const CitizenRelationships = require("../lib/CitizenRelationships");
const BrainRelationships = require("../brain/CitizenRelationships");
const CitizenHangouts = require("../lib/CitizenHangouts");
const { tickToasts } = require("../lib/CitizenToasts");
const { tickTavernGames } = require("../lib/CitizenTavernGames");
const { tickFestivals } = require("../lib/CitizenFestivals");
const { tickFestivalGames } = require("../lib/CitizenFestivalGames");
const { tickSports } = require("../lib/CitizenSports");
const { tickHobbyists } = require("../lib/CitizenHobbyists");
const { tickPetOwners } = require("../lib/CitizenPetOwners");
const { tickGardeners } = require("../lib/CitizenGardeners");
const { tickVolunteers } = require("../lib/CitizenVolunteers");
const { tickStorytellers } = require("../lib/CitizenStorytellers");
const { tickHistorians } = require("../lib/CitizenHistorians");
const { tickMenders } = require("../lib/CitizenMenders");
const { tickCouriers } = require("../lib/CitizenCouriers");
const { tickScribes } = require("../lib/CitizenScribes");
const { tickEducators } = require("../lib/CitizenTeachers2");
const { tickCaregivers } = require("../lib/CitizenHealers2");
const { tickWatchmen } = require("../lib/CitizenWatchmen2");
const { tickFisherfolk } = require("../lib/CitizenFishers2");
const { tickMinerfolk } = require("../lib/CitizenMiners2");
const { tickHuntfolk } = require("../lib/CitizenHunters2");
const { tickCookfolk } = require("../lib/CitizenCooks2");
const { tickSewfolk } = require("../lib/CitizenTailors2");
const { tickSmithfolk } = require("../lib/CitizenBlacksmiths2");
const { tickBrewfolk } = require("../lib/CitizenAlchemists2");
const { tickGemfolk } = require("../lib/CitizenJewelers2");
const { tickDockfolk } = require("../lib/CitizenSailors2");
const { tickGuardfolk } = require("../lib/CitizenGuards2");
const { tickHostfolk } = require("../lib/CitizenInnkeepers2");
const { tickSongfolk } = require("../lib/CitizenBards2");
const { tickFarmfolk } = require("../lib/CitizenFarmers2");
const { tickMoneyfolk } = require("../lib/CitizenBankers2");
const { tickErrandfolk } = require("../lib/CitizenCouriers2");
const { tickHerbfolk } = require("../lib/CitizenHerbalists2");
const { tickGlassfolk } = require("../lib/CitizenGlassblowers2");
const { tickWoodfolk } = require("../lib/CitizenArtisans2");
const { tickLaborfolk } = require("../lib/CitizenBuilders2");
const { tickTimefolk } = require("../lib/CitizenClockmakers2");
const { tickHawker } = require("../lib/CitizenHawkers2");
const { tickStallfolk } = require("../lib/CitizenMarketStalls2");
const { tickFishingTournaments } = require("../lib/CitizenFishingTournaments");
const { tickNewspaper, tickCrier } = require("../lib/CitizenNewspaper");
const { tickMortality, tickFuneralRites, saveIfDirty: saveFuneralsIfDirty } = require("../lib/CitizenFunerals");
const { attachDeathRespawn, saveIfDirty: saveDeathsIfDirty } = require("../lib/CitizenDeathRespawn");
const { tickCaravans } = require("../lib/CitizenTradeCaravans");
const { tickCaravanShouts } = require("../lib/CitizenTradeCaravans");
const { tickDiplomacy, tickDiplomatShouts } = require("../lib/CitizenDiplomats");
const { tickSpies, tickSpyShouts } = require("../lib/CitizenSpies");
const { tickExplorers } = require("../lib/CitizenExplorers");
const { tickExplorers2 } = require("../lib/CitizenExplorers2");
const { tickSocieties } = require("../lib/CitizenSecretSocieties");
const { tickClans } = require("../lib/CitizenClanLife");
const CitizenClans = require("../lib/CitizenClans");
const { tickHomes } = require("../lib/CitizenHomeLife");
const CitizenHomes = require("../lib/CitizenHomes");
const { tickCareers } = require("../lib/CitizenCareerLife");
const { tickFamilies } = require("../lib/CitizenFamilyLife");
const CitizenCareers = require("../lib/CitizenCareers");
const { tickAging, announceArrivals } = require("../lib/CitizenAging");
const Aging = require("../lib/CitizenAging");
const CitizenFamilies = require("../lib/CitizenFamilies");
const { tickGovernments } = require("../lib/CitizenGovernmentLife");
const CitizenGovernment = require("../lib/CitizenGovernment");
const { tickFaith } = require("../lib/CitizenFaithLife");
const CitizenFaith = require("../lib/CitizenFaith");
const {
  tickFestivalLife,
  registerFeastSource,
} = require("../lib/CitizenFestivalLife");
const { tickSchools } = require("../lib/CitizenSchoolLife");
const { tickHealth } = require("../lib/CitizenHealthLife");
const { tickJustice } = require("../lib/CitizenJusticeLife");
const { tickLegalLife } = require("../lib/CitizenLegalLife");
const { tickSurgery } = require("../lib/CitizenSurgeryLife");
const { tickTravel } = require("../lib/CitizenTravelLife");
const { tickEntertain } = require("../lib/CitizenEntertainLife");
const CitizenHealth = require("../lib/CitizenHealth");
const CitizenCrime = require("../lib/CitizenCrime");
const CitizenLegalCode = require("../lib/CitizenLegalCode");
const CitizenTravel = require("../lib/CitizenTravel");
const CitizenEntertainment = require("../lib/CitizenEntertainment");
const CitizenSchools = require("../lib/CitizenSchools");
// Religious feasts join the seasonal calendar so the festival games,
// celebration chatter, and participation journaling all fire for them.
registerFeastSource();
const { tickWeatherReactions } = require("../lib/CitizenWeatherReactions");
const { tickSeasonLife } = require("../lib/CitizenSeasonLife");
const { tickDayNight } = require("../lib/CitizenDayNightLife");
const { tickReputation } = require("../lib/CitizenReputationLife");
const CitizenReputation = require("../lib/CitizenReputation");
const { tickGuilds } = require("../lib/CitizenGuildLife");
const CitizenGuilds = require("../lib/CitizenGuilds");
const { tickPets } = require("../lib/CitizenPetLife");
const CitizenPets = require("../lib/CitizenPets");
const { tickArt } = require("../lib/CitizenArtLife");
const CitizenArt = require("../lib/CitizenArt");

const { tickTournaments } = require("../lib/CitizenTournamentLife");
const CitizenTournaments = require("../lib/CitizenTournaments");
const { tickCovertDiplomacy } = require("../lib/CitizenDiplomacyLife");
const CitizenDiplomacy = require("../lib/CitizenDiplomacy");
const { tickDiscoveryLife } = require("../lib/CitizenDiscoveryLife");
const CitizenDiscovery = require("../lib/CitizenDiscovery");
const { tickInventionLife } = require("../lib/CitizenInventionLife");
const CitizenInventions = require("../lib/CitizenInventions");
const { tickPhilosophy } = require("../lib/CitizenPhilosophyLife");
const CitizenPhilosophy = require("../lib/CitizenPhilosophy");
const { tickShoppers } = require("../shop/CitizenShoppers");
const { configuredSpread } = require("../lib/CitizenTimingDesync");
const { tickLodBands } = require("../lib/CitizenTickLod");
const CitizenBonds = require("../lib/CitizenBonds");
const CitizenKinship = require("../lib/CitizenKinship");
const CitizenWeddings = require("../lib/CitizenWeddings");
const { normalizeName } = require("../lib/CitizenBonds");
const { siteTileByKingdom, KINGDOM_IDS } = require("../brain/CitizenSites");
const {
  ensureNeeds,
  needsSnapshot,
  tickNeeds,
  attemptFeed,
  sellsFood,
  HURT_AT,
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
  ATTR_PRIME_MERCHANT,
  ATTR_SUPPLIER_MERCHANT,
  ATTR_WARE_ITEM,
  ATTR_WARE_PRICE,
  ROLE_GUARD,
  ROLE_MERCHANT,
  ROLE_COMMONER,
  ROLE_COURTIER,
  ROLE_REFUGEE,
  ROLE_ACTIVITY,
  ACTIVITY_TAVERN_SOCIAL,
  ACTIVITY_LEISURE_STROLL,
  ACTIVITY_REFUGEE_FLIGHT,
  ACTIVITY_PRIME_MERCHANT,
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
    // LOD bands must update on the fast tick, not just the slow 60s tick.
    // Otherwise citizens stay "asleep" for up to a minute after a player
    // arrives, appearing frozen. This is cheap distance math.
    // Movement safety net (fast tick): if citizen brains aren't ticking
    // (attachBrain failure), the director handles movement directly so
    // citizens visibly move. Dispatches queued requests and wanders idle
    // citizens (15% per tick, 3-5 tiles).
    try {
      const nav = require("../../bots/behaviours/navigation/BotNavigation");
      const { peekMovementRequest, dispatchMovementRequest, requestMovement, clearMovementRequest } = nav;
      for (const record of this.roster.values()) {
        if (!this.isOnline(record)) continue;
        const bot = this.getBot(record);
        if (!bot) continue;
        if (bot.getMovementQueue?.()?.size?.() > 0) continue;
        const req = peekMovementRequest(bot);
        if (req) {
          try {
            const result = dispatchMovementRequest(bot, req);
            if (result?.hasRoute === true) clearMovementRequest(bot);
          } catch {}
          continue;
        }
        if (Math.random() < 0.15) {
          try {
            const loc = bot.getLocation?.();
            if (!loc) continue;
            const dx = Math.floor(Math.random() * 11) - 5;
            const dy = Math.floor(Math.random() * 11) - 5;
            if (dx === 0 && dy === 0) continue;
            requestMovement(bot, loc.getX() + dx, loc.getY() + dy, {
              reason: "director_wander",
              basicPather: true,
              z: loc.getZ?.() ?? 0,
            });
            const req2 = peekMovementRequest(bot);
            if (req2) {
              const r2 = dispatchMovementRequest(bot, req2);
              if (r2?.hasRoute === true) clearMovementRequest(bot);
            }
          } catch {}
        }
      }
    } catch (error) {
      this.log("director movement failed", { error: String(error?.message ?? error) });
    }
    try {
      tickLodBands(this, Date.now());
    } catch (error) {
      this.log("tick-lod-proximity failed", { error: String(error?.message ?? error) });
    }
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
    // Citizen healers: doctors, herbalists, surgeons, and midwives treat
    // the sick and injured at their town-square clinics, contain rare plague
    // outbreaks, and offer treatment to lingering players — visible work
    // only while a real player is actually around to see it. Data tier
    // (ailment sim, plague spread, births) runs free with zero players.
    // Zero LLM, per-citizen try/catch inside.
    try {
      CitizenHealers.tickHealers(this, Date.now());
    } catch (error) {
      this.log("healers (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Citizen artisans: master craftspeople work visibly at their workshops,
    // reveal masterpieces, announce completed commissions, and offer new
    // commissions to lingering players — but only while a real player is
    // actually around to see them. Data tier, zero LLM, per-citizen
    // try/catch inside.
    try {
      CitizenArtisans.tickArtisanLife(this, Date.now());
    } catch (error) {
      this.log("artisans (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Citizen builders: construction crews work visibly at the kingdom's
    // active site, the architect supervises, lingering players get hire
    // offers — but only while a real player is actually around to see them.
    // Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenBuilders.tickBuilderLife(this, Date.now(), desync);
    } catch (error) {
      this.log("builders (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Rumors: citizens spread distorted retellings of real events along
    // social ties (data tier), and speak them aloud near real players
    // (taverns/streets). Zero LLM, per-citizen try/catch inside.
    try {
      CitizenRumors.tickRumors(this, Date.now());
    } catch (error) {
      this.log("rumors (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Gift giving: citizens give gifts to real players — birthdays,
    // thank-yous after completed favors, festival gifts, reciprocity for
    // player generosity, and rare spontaneous generosity from fond
    // citizens. Personality-driven gift pools, ceremony lines, journaled
    // for the LLM. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenGiftGiving.tickGiftGiving(this, Date.now());
    } catch (error) {
      this.log("gift giving (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Mysteries: a monthly town mystery (missing person, theft, strange
    // lights) citizens whisper about; players find scattered clues and the
    // town reacts when it's solved. Data tier, zero LLM, per-citizen
    // try/catch inside.
    try {
      CitizenMystery.tickMystery(this, Date.now());
    } catch (error) {
      this.log("mystery (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Citizen teachers: schools with deterministic teacher staff, school-age
    // students whose curriculum advances daily (persisted), and visible
    // class sessions during school hours — but only while a real player is
    // actually around to see them. Data tier, zero LLM, per-citizen
    // try/catch inside.
    try {
      CitizenTeachers.tickTeachers(this, Date.now());
    } catch (error) {
      this.log("teachers (proximity) failed", { error: String(error?.message ?? error) });
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
    // Farmers: crop/livestock/orchard/apiary citizens visibly work the
    // land (seasonal cycles, daily livestock rhythm, weather-adjusted) and
    // hawk fresh produce — only while a real player is around to see them.
    // Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenFarmers.tickFarmers(this, Date.now());
    } catch (error) {
      this.log("farmers (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Miners: prospectors, diggers, smelters and gem cutters work the mines
    // visibly (pickaxe swings, rich-vein callouts, hazard warnings) — only
    // while a real player is around to see them. Data tier, zero LLM,
    // per-citizen try/catch inside.
    try {
      CitizenMiners.tickMiners(this, Date.now(), desync);
    } catch (error) {
      this.log("miners (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Fishers: deep-sea fishers, river fishers, ice fishers and pearl divers
    // work the waters visibly (casts, net hauls, big-catch celebrations,
    // fresh-catch hawking, storm warnings) — only while a real player is
    // around to see them. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenFishers.tickFishers(this, Date.now(), desync);
    } catch (error) {
      this.log("fishers (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Hunters: trackers, bowmen, trappers and beastmasters work the
    // wilds visibly (bow draws, snare settings, trophy celebrations,
    // meat/hide hawking, danger warnings) — only while a real player is
    // around to see them. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenHunters.tickHunters(this, Date.now(), desync);
    } catch (error) {
      this.log("hunters (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Cooks: tavern keepers, bakers, chefs and street vendors visibly work
    // their kitchens (engine-verified cooking anims 896/897, meal-of-the-day
    // announcements, fresh-food hawking, recipe lesson offers) — only while
    // a real player is around to see them. Data tier, zero LLM,
    // per-citizen try/catch inside.
    try {
      CitizenCooks.tickCooks(this, Date.now(), desync);
    } catch (error) {
      this.log("cooks (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Tailors: clothiers, armorers, weavers and embroiderers visibly work
    // their workshops (engine-verified needlework anim 885, season-style
    // announcements in kingdom colors, garment hawking, commission
    // offers, masterpiece unveilings) — only while a real player is around
    // to see them. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenTailors.tickTailors(this, Date.now(), desync);
    } catch (error) {
      this.log("tailors (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Blacksmiths: weaponsmiths, armorsmiths, farriers and bladesmiths
    // visibly work their forges (engine-verified smithing anim 898,
    // smelting anim 899, wares hawking, masterwork unveilings,
    // commission offers) — only while a real player is around to see
    // them. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenBlacksmiths.tickSmiths(this, Date.now(), desync);
    } catch (error) {
      this.log("blacksmiths (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Alchemists: potion brewers, transmuters, scholars and apothecaries
    // visibly work their laboratories (engine-verified herblore anim 363,
    // breakthrough unveilings, scripted mishaps, remedy hawking, recipe
    // lesson offers) — only while a real player is around to see them.
    // Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenAlchemists.tickAlchemists(this, Date.now(), desync);
    } catch (error) {
      this.log("alchemists (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Herbalists: wildcrafters, gardeners, botanists and apothecary
    // suppliers visibly gather and prepare herbs (engine-verified digging
    // anim 830, herblore anim 363, herb hawking, rare-find unveilings,
    // herblore lesson offers) — only while a real player is around to see
    // them. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenHerbalists.tickHerbalists(this, Date.now(), desync);
    } catch (error) {
      this.log("herbalists (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Jewelers: gem cutters, goldsmiths, appraisers and traders visibly
    // work their workshops (engine-verified gem-cutting anims 885-892,
    // 2717, 7185 from Crafting.plugin.js, wares hawking, masterpiece
    // unveilings, commission offers) — only while a real player is around
    // to see them. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenJewelers.tickJewelers(this, Date.now(), desync);
    } catch (error) {
      this.log("jewelers (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Sailors: deckhands, navigators, captains and dockworkers visibly
    // work the docks and decks (engine-verified sailing anims 13340,
    // 13576, 13599, passage offers, ship-arrival announcements, storm
    // batten-downs) — only while a real player is around to see them.
    // Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenSailors.tickSailors(this, Date.now(), desync);
    } catch (error) {
      this.log("sailors (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Street performers: buskers, bards and conjurers play the squares,
    // markets and tavern entrances for tips during the day. Nearby citizen
    // bots applaud; real players tip with "use coins on performer". Data
    // tier, zero LLM, per-citizen try/catch inside.
    try {
      tickPerformers(this, Date.now());
    } catch (error) {
      this.log("performers (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Bards: professional minstrels play the great halls and feast halls
    // in the evening — named repertoire, touring troupes, court bards,
    // premieres, ballads composed from real journaled events, song
    // requests, commissions and coin tips ("use coins on bard"). No
    // overlap with street performers (buskers own the squares) or inn
    // bards (they own the inns). Data tier, zero LLM, per-citizen
    // try/catch inside.
    try {
      tickBards(this, Date.now(), desync);
    } catch (error) {
      this.log("bards (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Actors: stage plays at the theaters and amphitheaters during show
    // hours — scripted scenes, monologues, premieres, troupe-join offers
    // and coin tips ("use coins on actor"). No overlap with street
    // performers (squares), bards (great halls) or inn bards. Data tier,
    // zero LLM, per-citizen try/catch inside.
    try {
      tickActors(this, Date.now(), desync);
    } catch (error) {
      this.log("actors (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Painters: portraitists, landscapists, muralists and miniaturists
    // visibly work the kingdom studios and galleries during daylight
    // hours — scripted easel work, painting hawking, masterpiece
    // unveilings, commission offers and coin tips ("use coins on
    // painter"). No overlap with street performers (squares), bards
    // (music), actors (theaters) or inn bards. Data tier, zero LLM,
    // per-citizen try/catch inside.
    try {
      tickPainters(this, Date.now(), desync);
    } catch (error) {
      this.log("painters (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Sculptors: stone carvers, wood carvers, metalworkers and restorers
    // visibly work the kingdom quarries, foundries and studios during
    // daylight hours — scripted carving work, sculpture hawking,
    // masterpiece unveilings, multi-day public monuments, restoration
    // announcements, commission offers and coin tips ("use coins on
    // sculptor"). No overlap with street performers (squares), bards
    // (music), actors (theaters), inn bards, or painters (studios).
    // Data tier, zero LLM, per-citizen try/catch inside.
    try {
      tickSculptors(this, Date.now(), desync);
    } catch (error) {
      this.log("sculptors (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Architects: master architects, draftsmen, surveyors and inspectors
    // visibly work the kingdom drafting studios during daylight hours —
    // scripted drafting/survey work, blueprint hawking, grand-design
    // unveilings, inspection sign-offs, commission offers and coin tips
    // ("use coins on architect"). No overlap with builders (construction
    // projects), sculptors (carving), painters (studios), actors
    // (theaters), bards (music), street performers (squares) or inn bards.
    // Data tier, zero LLM, per-citizen try/catch inside.
    try {
      tickArchitects(this, Date.now(), desync);
    } catch (error) {
      this.log("architects (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Citizen draftfolk (CitizenArchitects2): amateur rough-drafters,
    // plan-copyists and corner-advisers under the professional drafting
    // trade — corner draft boards (not the pro studios), daily rough
    // sketches (never approved plans or masterworks), the pro-plans
    // small-talk bridge, the board-collapse / bad-measure set-pieces and
    // the copy-dispute crowd moment. Citizens claimed by the master's
    // real claimed-type function (architectTypeOf) and by
    // CitizenBuilders2 (laborfolkTypeOf) are excluded before the share
    // roll inside the module. LOD-gated via brainTickDue inside
    // (near-band citizens always due). Data tier, zero LLM.
    try {
      tickDraftfolk(this, Date.now(), desync);
    } catch (error) {
      this.log("draftfolk failed", { error: String(error?.message ?? error) });
    }
    // Engineers: millwrights, siege engineers, aqueduct engineers and
    // inventors visibly work the kingdom machine workshops during daylight
    // hours — scripted machine work, device hawking, great-work unveilings,
    // inventor breakthroughs, commission offers and coin tips ("use coins
    // on engineer"). No overlap with architects (designs), blacksmiths
    // (metalwork), builders (construction), sculptors (carving), painters
    // (studios), actors (theaters), bards (music), street performers
    // (squares) or inn bards. Data tier, zero LLM, per-citizen try/catch
    // inside.
    try {
      tickEngineers(this, Date.now(), desync);
    } catch (error) {
      this.log("engineers (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Engineerfolk: amateur engineering-life folk under the professional
    // engineers — tinkers mend kettles/locks on the street corners,
    // grease-monkeys run errands for the workshops, rivet-hands do grunt
    // machine repairs, and signalers keep the flag/whistle patter going.
    // Street repair corners (not the pro workshops), per-day mending cries
    // and errand calls (never devices, commissions, great works or
    // breakthroughs), the pro-workshop small-talk bridge, the gear-spill /
    // whistle-gag set-pieces and the fix-crowd moment. Citizens claimed by
    // the master's real claimed-type function (engineerTypeOf) and by
    // CitizenBlacksmiths2 (smithfolkTypeOf) are excluded before the share
    // roll inside the module. LOD-gated via brainTickDue inside (near-band
    // citizens always due). Data tier, zero LLM.
    try {
      tickEngineerfolk(this, Date.now(), desync);
    } catch (error) {
      this.log("engineerfolk failed", { error: String(error?.message ?? error) });
    }
    // Clockmakers: horologists, assemblers, repairers and sellers visibly
    // work the kingdom clock workshops during daylight hours — scripted
    // precision-assembly work, timepiece hawking, masterwork unveilings,
    // great-work unveilings, repair/commission offers and coin tips
    // ("use coins on clockmaker"). No overlap with engineers (machines),
    // architects (designs), jewelers (gems), blacksmiths (metalwork),
    // builders (construction), sculptors (carving), painters (studios),
    // actors (theaters), bards (music), street performers (squares) or inn
    // bards. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      tickClockmakers(this, Date.now(), desync);
    } catch (error) {
      this.log("clockmakers (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Glassblowers: vessel makers, window makers, ornament makers and
    // furnace tenders visibly work the kingdom glasshouses during furnace
    // hours — scripted glassblowing emotes, glassware hawking, masterwork
    // unveilings, great-work unveilings, commission offers and coin tips
    // ("use coins on glassblower"). Glassware demand is read from the real
    // CitizenAlchemists tables and ornament settings from the real
    // CitizenJewelers tables. No overlap with clockmakers (timepieces),
    // engineers (machines), architects (designs), jewelers (gems),
    // blacksmiths (metalwork), builders (construction), sculptors
    // (carving), painters (studios), actors (theaters), bards (music),
    // street performers (squares) or inn bards. Data tier, zero LLM,
    // per-citizen try/catch inside.
    try {
      tickGlassblowers(this, Date.now(), desync);
    } catch (error) {
      this.log("glassblowers (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Potters: vessel makers, tile makers, brick makers and potters'
    // artists visibly work the kingdom kilns during kiln hours — scripted
    // pottery-wheel/kiln emotes, clayware hawking, masterwork unveilings,
    // great-work unveilings, commission offers and coin tips
    // ("use coins on potter"). Brick/tile demand is read from the real
    // CitizenBuilders tables and kiln fuel rhythm from the real
    // CitizenGlassblowers tables. No overlap with glassblowers (glass),
    // clockmakers (timepieces), engineers (machines), architects
    // (designs), jewelers (gems), blacksmiths (metalwork), builders
    // (construction), sculptors (carving), painters (studios), actors
    // (theaters), bards (music), street performers (squares) or inn
    // bards. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      tickPotters(this, Date.now(), desync);
    } catch (error) {
      this.log("potters (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Guard patrols: the visible watch — checkpoint check-ins, disturbance
    // response, escort offers and follows, night-watch torch announcements,
    // and reassured citizens near patrolling guards. Data tier, zero LLM,
    // per-citizen try/catch inside.
    try {
      CitizenGuardPatrols.tickGuardPatrols(this, Date.now());
    } catch (error) {
      this.log("guard patrols (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Guards (deeper watch systems): guard types (city-watch, gate-guard,
    // royal-guard, investigator), shift-change announcements, gate
    // challenges for wanted/notorious players, investigator cold cases,
    // scripted arrests, and watch-volunteer welcomes. Data tier, zero LLM,
    // per-citizen try/catch inside.
    try {
      CitizenGuards.tickGuards(this, Date.now());
    } catch (error) {
      this.log("guards (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Judges: magistrates, high judges, arbiters and bailiffs hold court
    // (scripted trials from the day's docket during 09:00-16:00, summons,
    // arbitration offers, fine ledger, appeals) — only while a real player
    // is around to see them. Data tier, zero LLM, per-citizen try/catch
    // inside. Reads the live CitizenGuards wanted list.
    try {
      CitizenJudges.tickJudges(this, Date.now());
    } catch (error) {
      this.log("judges (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Tax collectors: assessors, collectors, auditors and enforcers work
    // collection rounds (08:00-18:00), assess property, audit players and
    // seize goods — only while a real player is around to see them. Data
    // tier, zero LLM, per-citizen try/catch inside. Writes evasion
    // penalties through the real CitizenJudges fine ledger.
    try {
      CitizenTaxCollectors.tickTaxCollectors(this, Date.now());
    } catch (error) {
      this.log("taxcollectors (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Messengers: couriers, heralds, runners and postmasters carry letters,
    // deliver packages, proclaim decrees/events/warnings and run post
    // offices (scripted delivery fanfare, proclamations seeded into
    // CitizenRumors, newspaper echo lines, player letter ledger) — only
    // while a real player is around to see them. Data tier, zero LLM,
    // per-citizen try/catch inside.
    try {
      CitizenMessengers.tickMessengers(this, Date.now());
    } catch (error) {
      this.log("messengers (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Runnerfolk (CitizenMessengers2): amateur word-carriers under the
    // official post — gossip-carriers, word-runners and board-runners with
    // post corners cross-read from the master post offices and gossip lines
    // drawn from the real rumor pools; lost-satchel / misdelivered-note
    // set-pieces and a breathless-runner crowd moment. Citizens claimed by
    // the master's claimed-type function are excluded before the share roll
    // inside the module. LOD-gated via brainTickDue inside (near-band
    // citizens always due). Data tier, zero LLM.
    try {
      tickMessengers2(this, Date.now());
    } catch (error) {
      this.log("runnerfolk failed", { error: String(error?.message ?? error) });
    }
    // Cartographers: surveyors, mapmakers, chart-explorers and sellers map
    // the world (scripted survey work, map hawking, discovery announcements
    // seeded into CitizenRumors, commissions and survey-hire ledgers) — only
    // while a real player is around to see them. Data tier, zero LLM,
    // per-citizen try/catch inside. Reads the real CitizenExplorers
    // discoveries and CitizenSailors ports.
    try {
      CitizenCartographers.tickCartographers(this, Date.now());
    } catch (error) {
      this.log("cartographers (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Citizen mapfolk (CitizenCartographers2): amateur map-sketchers,
    // chart-hawkers and rough-drafters under the professional chart houses —
    // corner kiosks (not the pro studios), daily rough sketches (never fine
    // charts or masterworks), the pro-charts small-talk bridge, the
    // copy-dispute crowd moment and the ink-spill / wrong-way set-pieces.
    // Citizens claimed by the master's real claimed-type function
    // (cartographerTypeFor) and by CitizenHawkers2 are excluded before the
    // share roll inside the module. LOD-gated via brainTickDue inside
    // (near-band citizens always due). Data tier, zero LLM.
    try {
      tickMapfolk(this, Date.now());
    } catch (error) {
      this.log("mapfolk failed", { error: String(error?.message ?? error) });
    }
    // Bankers: tellers, vault-keepers, loan officers and auditors visibly
    // run the banks (engine-free scripted service lines, vault open/seal
    // announcements, loan offers and collections, daily audits) — only
    // while a real player is around to see them. Data tier, zero LLM,
    // per-citizen try/catch inside.
    try {
      CitizenBankers.tickBankers(this, Date.now());
    } catch (error) {
      this.log("bankers (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Innkeepers: hosts, cooks, stablehands and bards visibly run the inns
    // (scripted welcomes and room offers, meal hawking from the real
    // CitizenCooks tables, stable offers, evening bard verses, inn rumors
    // seeded into CitizenRumors) — only while a real player is around to
    // see them. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenInnkeepers.tickInnkeepers(this, Date.now(), desync);
    } catch (error) {
      this.log("innkeepers (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Stablehands: grooms, trainers, breeders and veterinarians visibly
    // run the stable yards (scripted grooming/training/breeding/vet lines,
    // foaling announcements, rare-breed hawking, stabling and riding-lesson
    // offers) — only while a real player is around to see them. Data tier,
    // zero LLM, per-citizen try/catch inside.
    try {
      CitizenStablehands.tickStablehands(this, Date.now(), desync);
    } catch (error) {
      this.log("stablehands (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Librarians: archivists, researchers, scribes and storytellers visibly
    // keep the kingdom libraries (scripted shelving/study/copying emotes,
    // service offers, rare-tome unveilings, evening tales, borrowing and
    // donations through a data-tier ledger) — only while a real player is
    // around to see them. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenLibrarians.tickLibrarians(this, Date.now());
    } catch (error) {
      this.log("librarians (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Citizen bookfolk (CitizenLibrarians2): amateur reading-room helpers,
    // pamphlet-sellers, story-circle minders and book-swappers under the
    // professional libraries — street reading spots (not the pro
    // libraries), daily pamphlet hawking and swap calls (never manuscripts
    // or rare tomes), the pro-library small-talk bridge, the rain-soak /
    // bad-swap set-pieces and the tale-crowd moment. Citizens claimed by
    // the master's real claimed-type function (isLibrarian) and by
    // CitizenHawkers2 (hawkerTypeOf) are excluded before the share roll
    // inside the module. LOD-gated via brainTickDue inside (near-band
    // citizens always due). Data tier, zero LLM.
    try {
      tickBookfolk(this, Date.now(), desync);
    } catch (error) {
      this.log("bookfolk failed", { error: String(error?.message ?? error) });
    }
    // Priests: high priests, chaplains, monks and oracles visibly keep the
    // kingdom temples (scripted services during service hours, blessings,
    // confessions, shrine-tending, evening prophecies, memorial rites for
    // the recently dead, wedding-officiant offers) — only while a real
    // player is around to see them. Data tier, zero LLM, per-citizen
    // try/catch inside.
    try {
      CitizenPriests.tickPriests(this, Date.now(), desync);
    } catch (error) {
      this.log("priests (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Caravan shouts: muster/departure/arrival announcements and
    // guard/trader invites, only where a real player can see them.
    // Data tier, zero LLM, per-caravan try/catch inside.
    try {
      tickCaravanShouts(this, Date.now());
    } catch (error) {
      this.log("caravan shouts (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Diplomat shouts: departure/return announcements at the home court
    // anchor and escort invitations to nearby real players, only where a
    // real player can see them. Data tier, zero LLM, per-mission
    // try/catch inside.
    try {
      tickDiplomatShouts(this, Date.now());
    } catch (error) {
      this.log("diplomat shouts (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Spy shouts: spymaster-handlers whisper recruitment/dossier offers and
    // informants whisper gathered intel to nearby real players, only where a
    // real player can hear. Asset wage payouts go out whenever an asset is
    // online. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      tickSpyShouts(this, Date.now());
    } catch (error) {
      this.log("spy shouts (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Personal companion invites: citizens invite nearby players on 1-on-1
    // outings (fishing, dungeon, walk, tavern) and remember yes/no.
    // Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenCompanions.tickCompanions(this, Date.now());
    } catch (error) {
      this.log("companions (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Master-apprentice life: apprentices follow their masters and the
    // pair exchange scripted trade chatter — only while a real player is
    // around to overhear. Data tier, zero LLM, per-citizen try/catch inside.
    try {
      CitizenApprentices.tickApprenticeLife(this, Date.now());
    } catch (error) {
      this.log("apprentices (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Retirement: elders (60+) hold a one-time retirement ceremony, then
    // tell stories, share wisdom, and receive deference from younger
    // citizens — only while a real player is around to witness. Data tier,
    // zero LLM, per-citizen try/catch inside.
    try {
      CitizenRetirement.tickRetirement(this, Date.now(), desync);
    } catch (error) {
      this.log("retirement (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Funerals (rites): the visible ceremony for the recently dead —
    // eulogist and mourners gather, grief lines, memorial visits, and
    // remembrance stories — only while a real player is around to witness.
    // Data tier, zero LLM, per-citizen try/catch inside.
    try {
      tickFuneralRites(this, Date.now(), desync);
    } catch (error) {
      this.log("funerals (proximity) failed", { error: String(error?.message ?? error) });
    }
    // New arrivals: announce immigrants where real players can hear.
    // The data tick stashed them on _pendingArrivals; this is the visible half.
    try {
      const pending = this._pendingArrivals;
      if (pending && pending.length) {
        this._pendingArrivals = [];
        announceArrivals(this, pending);
      }
    } catch (error) {
      this.log("arrivals (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Town crier: the designated crier per kingdom shouts the week's top
    // headline and hands nearby real players a copy of the paper (opens the
    // heraldic overlay, once per edition per player). Data tier, zero LLM,
    // per-crier try/catch inside.
    try {
      tickCrier(this, Date.now());
    } catch (error) {
      this.log("crier (proximity) failed", { error: String(error?.message ?? error) });
    }
    // Scholar lectures and studying aloud: visible only near real players,
    // desync-spread across the tick cycle. Data tier, zero LLM.
    try {
      CitizenScholars.tickLectures(this, Date.now(), desync);
    } catch (error) {
      this.log("scholars (proximity) failed", { error: String(error?.message ?? error) });
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

    // Persistent death-respawn: the engine's PlayerDeathTask revives dead
    // bots and teleports them to bot.__botResolveRespawnLocation() when set.
    // Citizens wake at their hearth (home tile), not DEFAULT_LOCATION.
    // Re-attached on every materialization, so it survives restarts.
    try {
      attachDeathRespawn(bot, record);
    } catch (error) {
      this.log("death respawn attach failed", {
        citizen: record.username,
        error: String(error?.message ?? error),
      });
    }

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

    const activityId =
      record.merchantKind === "prime"
        ? ACTIVITY_PRIME_MERCHANT
        : ROLE_ACTIVITY[record.role];
    const activity = activityId ? this.registry.byId.get(activityId) : null;
    if (!activity) {
      // ROOT CAUSE FIX: Log when activity lookup fails instead of silently
      // skipping attachBrain. This was causing citizens to spawn without
      // brains, leaving them frozen (entry.brain null → BotBehaviorTask skips).
      this.log("spawn failed: no activity for role", {
        citizen: record.username,
        role: record.role,
        activityId: activityId ?? "(undefined - ROLE_ACTIVITY missing role)",
        merchantKind: record.merchantKind ?? null,
      });
    } else {
      const attached = attachBrain({
        runtime,
        registry: this.registry,
        world: this.world,
        bot,
        activity,
        home: record.home,
        resetMovementState,
        nowMs: Date.now(),
      });
      if (!attached) {
        // ROOT CAUSE FIX: Log when attachBrain fails instead of silently
        // continuing. The brain is required for movement.
        this.log("spawn failed: attachBrain returned false", {
          citizen: record.username,
          role: record.role,
          activityId: activity.id,
        });
      } else {
        record.currentActivityId = activity.id;
      }
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
    try {
      Aging.forgetCitizen(username);
    } catch {
      // Non-fatal — the aging registry prunes on its own.
    }
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
      { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [`Promoted to ${next}! The ${record.kingdomId} guard thanks you.`] })); }
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
    // Tick-optimization: classify every online citizen into LOD bands
    // (near/mid/far/asleep by distance to the nearest real player) before
    // the feature ticks run. Stamps lodBand/lodStride/lodForceTickAt on
    // each citizen's bot state so the brain and feature ticks can gate on
    // them. Pure distance math, zero LLM; the module never throws.
    try {
      tickLodBands(this, nowMs);
    } catch (error) {
      this.log("tick-lod failed", { error: String(error?.message ?? error) });
    }
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
      // Hurt citizens feed themselves: own bread first, then buy a loaf
      // from a nearby bread merchant. The broke stay visibly hurt.
      if (needs && needs.hp < HURT_AT) {
        attemptFeed(bot, this.foodSellersNear(record, bot));
      }
    }
    this.tickMemory(nowMs);
    // Citizen weddings: anniversaries, love triangles, cold feet, proposals —
    // the romantic layer. Data tier, zero LLM. Runs BEFORE tickKinship so
    // cold feet can call off an announced wedding before the ceremony
    // machine processes it.
    try {
      CitizenWeddings.tickWeddings(this, Math.random, nowMs);
    } catch (error) {
      this.log("weddings failed", { error: String(error?.message ?? error) });
    }
    // Citizen kinship: friendships, romances, weddings and feuds between
    // citizens — the social fabric that makes them read as real people.
    // Data tier, zero LLM.
    try {
      CitizenKinship.tickKinship(this, hour, nowMs);
    } catch (error) {
      this.log("kinship failed", { error: String(error?.message ?? error) });
    }
    // Citizen scholars: historians, naturalists, inventors and philosophers
    // research topics on the slow tick, publish discoveries to the journal
    // and the kingdom library, and fire a scholars:discovery event for
    // quests/lore plugins. Data tier, zero LLM.
    try {
      CitizenScholars.tickResearch(this, Math.random, nowMs);
    } catch (error) {
      this.log("scholars research failed", { error: String(error?.message ?? error) });
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
    // Real fishing catches: materialized citizens in arrived fishing sessions
    // land real fish (player inventory API) + real Fishing XP (player skills
    // API) at real fishing spots. Zero LLM.
    try {
      CitizenFishing.tickCitizenFishing(this);
    } catch (error) {
      this.log("citizen fishing failed", { error: String(error?.message ?? error) });
    }
    // Master-apprentice pairings: masters (level 60+ trade) take on young
    // citizens, who gain real trade XP each slow tick and graduate at 40.
    // Data tier, zero LLM.
    try {
      CitizenApprentices.tickApprenticeships(this, nowMs);
    } catch (error) {
      this.log("apprenticeships failed", { error: String(error?.message ?? error) });
    }
    // Citizen artisans: master craftspeople with workshops, masterpieces,
    // commissions, and renown. Deterministic trade assignment, data tier,
    // zero LLM.
    try {
      CitizenArtisans.tickArtisans(this, nowMs);
    } catch (error) {
      this.log("artisans failed", { error: String(error?.message ?? error) });
    }
    // Citizen builders: construction crews with deterministic trades,
    // per-kingdom projects advancing through phases, completions journaled.
    // Data tier, zero LLM.
    try {
      CitizenBuilders.tickBuilders(this, nowMs);
    } catch (error) {
      this.log("builders failed", { error: String(error?.message ?? error) });
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
    // Citizen elections: towns elect mayor, sheriff, guild master on a
    // slow cycle (nominations -> campaigning -> voting -> results -> term).
    // Data tier, zero LLM. Announcements and stumping are player-visible.
    try {
      tickElections(this, nowMs);
    } catch (error) {
      this.log("elections failed", { error: String(error?.message ?? error) });
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
    // Citizen tavern games: citizens play dice, cards, arm wrestling, and
    // drinking contests at the tavern in the evenings. Data tier, zero LLM -
    // games, wagers, champions, and rivalries are journaled; visible banter
    // is scripted and only fires near a real player.
    try {
      tickTavernGames(this, hour, nowMs);
    } catch (error) {
      this.log("tavern games failed", { error: String(error?.message ?? error) });
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
    // Citizen seasons: season transitions (announced + journaled once),
    // rain-boosted crop growth on citizen farms, seasonal reactions near
    // real players, storm shelter. Data tier, zero LLM.
    try {
      tickSeasonLife(this, nowMs);
    } catch (error) {
      this.log("season life failed", { error: String(error?.message ?? error) });
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
    // Citizen festival games: wrestling, archery, pie-eating, dance
    // competitions during festivals. Citizens announce games, cheer
    // competitors, and celebrate winners near real players. Data tier,
    // zero LLM.
    try {
      tickFestivalGames(this, nowMs);
    } catch (error) {
      this.log("festival games failed", { error: String(error?.message ?? error) });
    }
    // Citizen sports: year-round league sports — football fixtures with
    // league tables and championships, horse race meets, wrestling and
    // archery league circuits. Match days are Saturdays. Distinct from
    // festival games (festival windows only). Data tier, zero LLM.
    try {
      tickSports(this, nowMs);
    } catch (error) {
      this.log("sports failed", { error: String(error?.message ?? error) });
    }
    // Citizen hobbyists: leisure-time hobbies — gardening, birdwatching,
    // collecting, board games. Activity system (no professional exclusions):
    // any commoner may have a hobby. Rare finds are the crowd moment;
    // weekly club meetups announced. Distinct from sports (league sports)
    // and festival games (festival windows). Data tier, zero LLM.
    try {
      tickHobbyists(this, nowMs);
    } catch (error) {
      this.log("hobbyists failed", { error: String(error?.message ?? error) });
    }
    // Citizen pet owners: companion pets — cats, dogs, birds, exotics — with
    // named pets, personalities, daily care routines, and weekly per-kingdom
    // pet shows with derived winners. Activity system (no professional
    // exclusions): any commoner may own a pet. Distinct from hobbyists
    // (leisure pursuits) and stablehands (horse/mount care). Data tier,
    // zero LLM.
    try {
      tickPetOwners(this, nowMs);
    } catch (error) {
      this.log("pet owners failed", { error: String(error?.message ?? error) });
    }
    // Citizen gardeners: caretakers of the public gardens, parks and green
    // spaces — flower tenders, vegetable growers, tree keepers and park
    // keepers with seasonal bloom calendars, rare-bloom unveilings, volunteer
    // shifts and garden tours. Activity system (no professional exclusions):
    // any commoner may tend the public green. Distinct from hobbyists
    // (private allotments) and farmers (commercial food). Data tier,
    // zero LLM.
    try {
      tickGardeners(this, nowMs);
    } catch (error) {
      this.log("gardeners failed", { error: String(error?.message ?? error) });
    }
    // Citizen volunteers: street cleaners, helpers, charity workers and
    // event helpers with per-day service shifts, weekly charity drives and
    // player ledgers for sign-ups, donations and organized drives. Activity
    // system (no professional exclusions): any commoner may volunteer.
    // Event helpers only work during real festivals. Distinct from
    // gardeners (public gardens) and festivals (festival events). Data tier,
    // zero LLM.
    try {
      tickVolunteers(this, nowMs);
    } catch (error) {
      this.log("volunteers failed", { error: String(error?.message ?? error) });
    }
    // Citizen storytellers: elders, travelers, grandparents and
    // epic-performers keeping oral tales and legends at the gathering
    // places, with tale-request and story-share ledgers. Activity system
    // (no professional exclusions): any commoner may tell tales.
    // Distinct from bards (professional performers) and librarians
    // (written catalogs) — this module owns oral lore. Data tier,
    // zero LLM.
    try {
      tickStorytellers(this, nowMs);
    } catch (error) {
      this.log("storytellers failed", { error: String(error?.message ?? error) });
    }
    // Citizen historians: chroniclers, archivists, genealogists and
    // lorekeepers keeping per-kingdom daily chronicles from real journaled
    // events, with read/contribute/commission ledgers for players. Activity
    // system (no professional exclusions): any commoner may keep history.
    // Distinct from storytellers (oral tales) and librarians (book catalogs)
    // — this module owns the WRITTEN RECORD of events. Data tier, zero LLM.
    try {
      tickHistorians(this, nowMs);
    } catch (error) {
      this.log("historians failed", { error: String(error?.message ?? error) });
    }
    // Citizen menders: seamstresses, tinkers, cobblers and handymen who
    // repair clothes, tools, shoes and household goods. Hash-derived daily
    // repair jobs, 7-day-TTL ledgers for repair requests, pickups and
    // apprentice lessons; masterwork restorations as the crowd moment.
    // Activity system (no professional exclusions): any commoner may mend.
    // Distinct from tailors (making) and blacksmiths (forging) — this module
    // owns REPAIR only. Data tier, zero LLM.
    try {
      tickMenders(this, nowMs);
    } catch (error) {
      this.log("menders failed", { error: String(error?.message ?? error) });
    }
    // Citizen couriers: the private delivery underworld — pigeon keepers,
    // parcel runners, letter carriers and message runners-for-hire.
    // Hash-derived types and per-day runs, 7-day-TTL ledgers for hired
    // deliveries and pigeon messages, pigeon-release fanfare as the crowd
    // moment. Activity system (no professional exclusions): any commoner
    // may courier. Distinct from messengers (official post) — this module
    // owns the private side. Data tier, zero LLM.
    try {
      tickCouriers(this, nowMs);
    } catch (error) {
      this.log("couriers failed", { error: String(error?.message ?? error) });
    }
    // Citizen scribes: freelance writing folk — copyists, letter-writers,
    // record-keepers and calligraphers. Hash-derived types and per-day job
    // queues, 7-day-TTL ledgers for hires, copy requests and record
    // commissions; illuminated-manuscript unveilings as the crowd moment.
    // Activity system (no professional exclusions): any commoner may scribe.
    // Distinct from librarians (professional library staff scribes) — this
    // module owns the freelance writing trade. Data tier, zero LLM.
    try {
      tickScribes(this, nowMs);
    } catch (error) {
      this.log("scribes failed", { error: String(error?.message ?? error) });
    }
    // Citizen informal educators: home tutors, trade mentors, village
    // schoolmasters and public scholars. Hash-derived types and per-day
    // lesson schedules, pupil rosters, 7-day-TTL ledgers for tutor hires,
    // class attendance and mentoring requests; graduations as the crowd
    // moment. Activity system (no professional exclusions): any commoner
    // may teach. Distinct from the professional kingdom schools
    // (CitizenTeachers — assigned teachers are excluded) and from
    // CitizenMentors (reactive level-up lessons). Data tier, zero LLM.
    try {
      tickEducators(this, nowMs);
    } catch (error) {
      this.log("teachers2 failed", { error: String(error?.message ?? error) });
    }
    // Mentorfolk: the apprenticeship-and-morals street layer under the
    // professional masters — guild apprentice recruiters hawk indenture
    // contracts, journeyman taskmasters set apprentice day-chores,
    // soapbox preachers scold the town's vices (never clergy), and
    // oath-wardens keep the apprentice oath book at the market crosses.
    // Street hiring pitches (not schools, temples or workshops), per-day
    // trades/chores/vices, oath-ceremony / taskmaster-scene /
    // soapbox-crowd / signing-haul set-pieces. Level-60+ masters (the
    // master's real criterion via skillStore) are excluded before the
    // share roll inside the module. Mentorfolk never teach, never pair
    // apprentices, never grant XP — lessons stay with the educators and
    // the masters. LOD-gated via brainTickDue inside (near-band citizens
    // always due). Data tier, zero LLM.
    try {
      tickMentorfolk(this, nowMs, desync);
    } catch (error) {
      this.log("mentorfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen community caregivers: neighbors who sit vigil with the sick,
    // bonesetters who splint breaks, midwives who tend new mothers, and
    // remedy-brewers who simmer household cures. Hash-derived types and
    // per-day care rounds naming REAL patients from the CitizenHealers
    // ailment map, remedy herbs from the real CitizenHerbalists tables;
    // 7-day-TTL ledgers for house calls, remedy purchases, first-aid
    // lessons; recoveries as the crowd moment. Activity system (no
    // professional exclusions): any commoner may care. Distinct from the
    // professional healers (CitizenHealers — clinics, plague, surgery,
    // birth announcements; excluded) and the professional herbalists
    // (CitizenHerbalists — the herb trade; excluded). Visibility throttled
    // via chance + cooldown (couriers precedent), no hobby key. Data tier,
    // zero LLM.
    try {
      tickCaregivers(this, nowMs);
    } catch (error) {
      this.log("healers2 failed", { error: String(error?.message ?? error) });
    }
    // Citizen volunteer watch: night watchmen with lanterns, day wardens,
    // gate-minders and fire lookouts. Hash-derived types, per-day patrol
    // rotas, fire-scare crowd moments, 7-day-TTL ledgers for crime reports,
    // volunteer sign-ups and warden hires. Professional guards (role
    // "guard") are excluded — CitizenGuards owns the official watch.
    // Visibility throttled via chance + cooldown (couriers/healers2
    // precedent), no hobby key. Data tier, zero LLM.
    try {
      tickWatchmen(this, nowMs);
    } catch (error) {
      this.log("watchmen2 failed", { error: String(error?.message ?? error) });
    }
    // Citizen dockside fishing folk: net casters, line anglers, crabbers
    // and community fishmongers on the piers and shallows. Hash-derived
    // types, per-day spots/catches, big-catch crowd moments, 7-day-TTL
    // ledgers for fishing alongside, buying catch and learning techniques.
    // Professional fishers (CitizenFishers) are excluded — the trade owns
    // commercial fishing; tournaments own the competition; sailors own
    // boats. Visibility throttled via chance + cooldown (watchmen2
    // precedent), no hobby key. Data tier, zero LLM.
    try {
      tickFisherfolk(this, nowMs);
    } catch (error) {
      this.log("fisherfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen community mining folk: amateur prospectors, claim diggers,
    // ore carriers and gem hunters working the community claims. Hash-
    // derived types, per-day claims/finds, rich-vein-strike crowd moments,
    // 7-day-TTL ledgers for staking claims, hiring miners and buying ore.
    // Professional miners (CitizenMiners) are excluded — the trade owns
    // the commercial mines; jewelers own gem cutting. Visibility throttled
    // via chance + cooldown (fisherfolk precedent), no hobby key.
    // Data tier, zero LLM.
    try {
      tickMinerfolk(this, nowMs);
    } catch (error) {
      this.log("minerfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen community hunting folk: amateur trackers, bowmen, trappers
    // and falconers on the community grounds near the settlements. Hash-
    // derived types, per-day grounds/bags, trophy-bag crowd moments,
    // 7-day-TTL ledgers for joining hunts, buying game and learning
    // tracking. Professional hunters (CitizenHunters) are excluded — the
    // trade owns the wilds; cooks own the kitchens. Visibility throttled
    // via chance + cooldown (minerfolk precedent), no hobby key.
    // Data tier, zero LLM.
    try {
      tickHuntfolk(this, nowMs);
    } catch (error) {
      this.log("huntfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen community cooking folk: home cooks, street vendors, feast
    // cooks and soup-kitchen helpers at community hearths, stalls and
    // communal ovens. Hash-derived types, per-day kitchens/menus, grand-
    // feast crowd moments, 7-day-TTL ledgers for buying meals, learning
    // recipes and helping cook. Professional cooks (CitizenCooks) are
    // excluded — the trade owns the kitchens; farmers own the ingredients.
    // Visibility throttled via chance + cooldown (huntfolk precedent),
    // no hobby key. Data tier, zero LLM.
    try {
      tickCookfolk(this, nowMs);
    } catch (error) {
      this.log("cookfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen community sewing folk: home seamstresses, quilters,
    // pattern-sharers and plant dyers at community sewing circles.
    // Hash-derived types, per-day circles/projects, grand-quilt crowd
    // moments, 7-day-TTL ledgers for commissions, fabric buys and
    // sewing lessons. Professional tailors (CitizenTailors) are
    // excluded — the trade owns the workshops; menders own repair.
    // Visibility throttled via chance + cooldown (cookfolk precedent),
    // no hobby key. Data tier, zero LLM.
    try {
      tickSewfolk(this, nowMs);
    } catch (error) {
      this.log("sewfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen village smithfolk: farriers, blade honers, implement
    // tinkerers and forge apprentices at community smithies. Hash-derived
    // types, per-day smithies/jobs, masterwork crowd moments, 7-day-TTL
    // ledgers for repairs, iron goods and smithing lessons. Professional
    // smiths (CitizenBlacksmiths) are excluded — the trade owns the forges;
    // menders own small-tool and household repair. Visibility throttled via
    // chance + cooldown (sewfolk precedent), no hobby key. Data tier, zero LLM.
    try {
      tickSmithfolk(this, nowMs);
    } catch (error) {
      this.log("smithfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen village brewfolk: hedge-witches, community potion-brewers,
    // elixir-mixers and garden experimenters at community stillrooms.
    // Hash-derived types, per-day stillrooms/brews, comic mishap crowd
    // moments, 7-day-TTL ledgers for brew requests, potion buys and
    // brewing lessons. Professional alchemists (CitizenAlchemists) and
    // herbalists (CitizenHerbalists) are excluded — the trades own the
    // potion/herb business; healers2 remedy-brewers own health cures,
    // brewfolk brews are explicitly non-medical. Visibility throttled via
    // chance + cooldown (smithfolk precedent), no hobby key. Data tier, zero LLM.
    try {
      tickBrewfolk(this, nowMs);
    } catch (error) {
      this.log("brewfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen community gemfolk: hobby gem cutters, ring setters, stone
    // polishers and informal appraisers at community workshops. Hash-derived
    // types, per-day projects, masterpiece-unveiling crowd moments,
    // 7-day-TTL ledgers for commissions, raw-gem sales and cutting lessons.
    // Professional jewelers (CitizenJewelers) are excluded — the trade owns
    // the gem business; miners2 gem hunters own raw-stone finds; hobby
    // appraisers give opinions only, never certificates. Visibility
    // throttled via chance + cooldown (brewfolk precedent), no hobby key.
    // Data tier, zero LLM.
    try {
      tickGemfolk(this, nowMs);
    } catch (error) {
      this.log("gemfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen dockside folk: cargo dockhands, sail menders, shore fishers
    // and old salts spinning sea yarns at the community docks, piers and
    // quays. Hash-derived types, per-day jobs, ship-arrival crowd moments,
    // 7-day-TTL ledgers for hiring hands, buying supplies and requesting
    // yarns. Professional sailors (CitizenSailors) are excluded — the trade
    // owns ships and voyages; fisherfolk own dockside fishing; the old
    // salt's yarns are dockside flavor, not the gathered crowd. Visibility
    // throttled via chance + cooldown (gemfolk precedent), no hobby key.
    // Data tier, zero LLM.
    try {
      tickDockfolk(this, nowMs);
    } catch (error) {
      this.log("dockfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen militia (CitizenGuards2): gate wardens, wall walkers, night
    // sentries and militiamen — commoners taking rotational gate/wall duty,
    // drilling at the muster grounds, forming the levy. Professional guards
    // (role "guard") and volunteer watchmen are excluded; this owns drill
    // practice, levy musters, honor-guard ceremonies and civic issue
    // reports. Visibility throttled via chance + cooldown (dockfolk
    // precedent), no hobby key. Data tier, zero LLM.
    try {
      tickGuardfolk(this, nowMs);
    } catch (error) {
      this.log("guardfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen community hospitality (CitizenInnkeepers2): spare-room hosts,
    // home brewers, feast organizers and tavern regulars — hospitality as a
    // way of life, not a trade. Professional innkeepers are excluded; this
    // owns spare rooms, home brew, feast nights and traded gossip. Visibility
    // throttled via chance + cooldown (guardfolk precedent), no hobby key.
    // Data tier, zero LLM.
    try {
      tickHostfolk(this, nowMs);
    } catch (error) {
      this.log("hostfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen amateur songfolk (CitizenBards2): street buskers, tale-
    // spinners, amateur minstrels and ballad-swappers — the campfire-
    // circle and community-stage amateur side of the bard's trade.
    // Professional bards (CitizenBards), anchored street performers and
    // inn bards are excluded; this owns simple tunes, tune requests,
    // busker tips, tune lessons, rival ballad contests and recovered
    // legendary ballads. LOD-gated via brainTickDue inside (near-band
    // citizens always due). Data tier, zero LLM.
    try {
      tickSongfolk(this, nowMs);
    } catch (error) {
      this.log("songfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen farmfolk (CitizenFarmers2): farmhands, tenant farmers,
    // orchard keepers, market-garden sellers and seasonal harvest crews —
    // the amateur allotment-and-harvest side of the farmer's trade.
    // Professional farmers (CitizenFarmers) are excluded; this owns
    // farmyard work emotes, seasonal harvest set-pieces, produce pitches
    // from the real seasonal tables, basket requests and harvest-help
    // signups. LOD-gated via brainTickDue inside (near-band citizens
    // always due). Data tier, zero LLM.
    try {
      tickFarmfolk(this, nowMs);
    } catch (error) {
      this.log("farmfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen moneyfolk (CitizenBankers2): street money-changers,
    // coin-sorters for hire, market lenders and pawnbrokers — the informal
    // money economy under the bank's nose. Professional bankers
    // (CitizenBankers) are excluded; this owns street exchange pitches,
    // daily rates, coin assaying, brass-note micro-loans, pawn tickets and
    // assay-alert / lending-rush set-pieces. LOD-gated via brainTickDue
    // inside (near-band citizens always due). Data tier, zero LLM.
    try {
      tickMoneyfolk(this, nowMs);
    } catch (error) {
      this.log("moneyfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen errand-runners (CitizenCouriers2): street errand boys,
    // grocery carriers, water fetchers and neighborhood note-lads — the
    // amateur fetch-and-carry side of the courier's trade. Professional
    // couriers (CitizenCouriers) and the official post (messengers) are
    // excluded; this owns errand beats, fetch requests, short notes,
    // courier-corner gossip and market-rush / spilled-basket set-pieces.
    // LOD-gated via brainTickDue inside (near-band citizens always due).
    // Data tier, zero LLM.
    try {
      tickErrandfolk(this, nowMs);
    } catch (error) {
      this.log("errandfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen herbfolk (CitizenHerbalists2): hedgerow foragers picking
    // kitchen weeds, petal-driers selling potpourri, window-box tenders and
    // garden weeders for hire — the amateur greens trade under the nose of
    // the professional herbalists (CitizenHerbalists), who are excluded;
    // this owns herb patches, gather requests, pro-herb small talk and
    // hedgerow-glut / wasp-nest set-pieces. LOD-gated via brainTickDue
    // inside (near-band citizens always due). Data tier, zero LLM.
    try {
      tickHerbfolk(this, nowMs);
    } catch (error) {
      this.log("herbfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen glassfolk (CitizenGlassblowers2): bottle collectors buying up
    // empties, cullet sorters grading broken glass for remelt, sand carriers
    // hauling silica, and bottle washers for the taverns — the amateur
    // street economy of the glass trade under the nose of the professional
    // glassblowers (CitizenGlassblowers), who are excluded; this owns sand
    // sources, taverns, bottle-pickup requests, pro-glassware small talk and
    // sand-delay / tavern-smash set-pieces. LOD-gated via brainTickDue
    // inside (near-band citizens always due). Data tier, zero LLM.
    try {
      tickGlassfolk(this, nowMs);
    } catch (error) {
      this.log("glassfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen woodfolk (CitizenArtisans2): bowl turners, basket weavers,
    // whittlers and timber hands — the amateur woodcraft street economy of
    // bowls, baskets and firewood under the nose of the master artisans
    // (CitizenArtisans), who are excluded; this owns woodlots, goods-order
    // requests, woodcraft lessons, pro-carpenter small talk and
    // timber-delay / windfall set-pieces. LOD-gated via brainTickDue
    // inside (near-band citizens always due). Data tier, zero LLM.
    try {
      tickWoodfolk(this, nowMs);
    } catch (error) {
      this.log("woodfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen laborfolk (CitizenBuilders2): hod carriers, mortar mixers,
    // scaffolders' mates, day laborers and rubble clearers — the amateur
    // muscle-and-mortar side of the building trade under the master builders
    // (CitizenBuilders), who are excluded via the real module's getBuilderInfo
    // null path; this owns work sites, the daily master-project bridge,
    // day-labor hires, boss callouts, and topping-out / scaffold-slip /
    // supply-delay set-pieces. LOD-gated via brainTickDue inside (near-band
    // citizens always due). Data tier, zero LLM.
    try {
      tickLaborfolk(this, nowMs);
    } catch (error) {
      this.log("laborfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen timefolk (CitizenClockmakers2): knocker-uppers, bell-tenders,
    // hour-callers and sandglass-minders — the amateur public-time side of
    // the horology trade under the master clockmakers (CitizenClockmakers),
    // who are excluded via the real module's clockmakerTypeOf null path; this
    // owns rounds/bells/squares/glasses, the daily guild-workshop bridge,
    // wake-up calls, player callouts, and the full-peal / rope-snap /
    // hoarse-caller / clogged-glass set-pieces. LOD-gated via brainTickDue
    // inside (near-band citizens always due). Data tier, zero LLM.
    try {
      tickTimefolk(this, nowMs);
    } catch (error) {
      this.log("timefolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen hawkerfolk (CitizenHawkers2): amateur street hawkers and cryers
    // — the "2" layer under the professional stall merchants (CitizenMarketStalls,
    // who are excluded via the role gate before the share roll); this owns
    // pitches/baskets, the daily market-wares bridge, crowd-gathering moments
    // and the hoarse-crier / heckled-pitch set-pieces. LOD-gated via
    // brainTickDue inside (near-band citizens always due). Data tier, zero LLM.
    try {
      tickHawker(this, nowMs);
    } catch (error) {
      this.log("hawkerfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen stallfolk (CitizenMarketStalls2): amateur market-stall
    // keepers — barrow-folk, blanket-folk and crate-folk running rough
    // provisional stalls under the professional merchants (CitizenMarketStalls,
    // excluded via the role gate, and CitizenHawkers2, excluded via its real
    // claim function, both before the share roll); this owns fringe pitches,
    // daily goods, morning setup flavor, the master day-wares bridge, the
    // haggle-crowd moment and the wheel-off / moved-along set-pieces.
    // LOD-gated via brainTickDue inside (near-band citizens always due).
    // Data tier, zero LLM.
    try {
      tickStallfolk(this, nowMs);
    } catch (error) {
      this.log("stallfolk failed", { error: String(error?.message ?? error) });
    }
    // Citizen fishing tournaments: weekly per-kingdom tournaments
    // (announcement -> registration -> competition -> weigh-in -> prizes).
    // Catches simulated data-tier, trash-talk and results player-visible.
    // Players can register/compete via fishing:tournament-* events.
    // Data tier, zero LLM.
    try {
      tickFishingTournaments(this, nowMs);
    } catch (error) {
      this.log("fishing tournaments failed", { error: String(error?.message ?? error) });
    }
    // Citizen funerals (mortality): elders die of old age, anyone can die
    // in an accident, guards can fall in battle. Deaths are journaled,
    // the close circle grieves, funerals are scheduled, and the deceased
    // feed the newspaper obituaries. Data tier, zero LLM. Runs before the
    // newspaper so this week's deaths make this week's paper.
    try {
      tickMortality(this, nowMs);
    } catch (error) {
      this.log("funerals (mortality) failed", { error: String(error?.message ?? error) });
    }
    // Citizen newspaper: once a week, compile the paper from journals,
    // rumors, festivals, elections, and retirements — headlines, gossip
    // column, announcements, obituaries. Data tier, zero LLM.
    try {
      tickNewspaper(this, nowMs);
    } catch (error) {
      this.log("newspaper failed", { error: String(error?.message ?? error) });
    }
    // Trade caravans: merchant-led expeditions between capitals on a
    // staggered schedule — muster, travel (data-tier), bandit risk on
    // arrival, profit splits, player guard/trader signups. Data tier,
    // zero LLM.
    try {
      tickCaravans(this, nowMs);
    } catch (error) {
      this.log("trade caravans failed", { error: String(error?.message ?? error) });
    }
    // Citizen diplomats: courtier-envoys run trade/culture missions and
    // negotiators work peace treaties and alliance proposals between
    // capitals on a slow per-kingdom cadence — travel abstracted (data
    // tier), personality-weighted negotiation outcomes, real tension
    // effects (treaties ease it, collapsed talks spike it), successful
    // envoys stationed abroad as ambassadors. Everything journaled.
    // Data tier, zero LLM.
    try {
      tickDiplomacy(this, nowMs);
    } catch (error) {
      this.log("diplomacy failed", { error: String(error?.message ?? error) });
    }
    // Citizen spies: covert intelligence rings run missions (steal documents,
    // eavesdrop, sabotage, counter-intelligence) on a slow per-kingdom
    // cadence — briefed -> operating -> debrief, detection risk creates real
    // diplomatic incidents, gathered intel can trigger early warnings that
    // ease hot borders. Everything journaled. Data tier, zero LLM.
    try {
      tickSpies(this, nowMs);
    } catch (error) {
      this.log("spies failed", { error: String(error?.message ?? error) });
    }
    // Citizen explorers: scouts, treasure hunters, naturalists, and
    // pathfinders form expeditions on a slow per-kingdom cadence — muster,
    // journey (data-tier, abstracted), return with discoveries and dangers.
    // Muster shouts, departure calls, and tavern tales are player-visible
    // only near a real player; everything is journaled. Data tier, zero LLM.
    try {
      tickExplorers(this, nowMs);
    } catch (error) {
      this.log("explorers failed", { error: String(error?.message ?? error) });
    }
    // Citizen explorers v2 (frontier layer): scout recon trips, pioneer
    // settlements at discovery sites, amateur map sketches for sale,
    // naturalist field notes, and player funding of expeditions. Builds on
    // the CitizenExplorers simulation — data tier, zero LLM.
    try {
      tickExplorers2(this, nowMs);
    } catch (error) {
      this.log("explorers2 failed", { error: String(error?.message ?? error) });
    }
    // Citizen relationships: friend citizens hail friend players passing
    // nearby, by name. Data tier, zero LLM.
    try {
      CitizenRelationships.tickRelationships(this, nowMs);
    } catch (error) {
      this.log("relationships failed", { error: String(error?.message ?? error) });
    }
    // Citizen↔citizen bond formation: rapport from real interactions and
    // personality compatibility promotes into friends/rivals. Data tier.
    try {
      BrainRelationships.tickRelationships(this, nowMs);
    } catch (error) {
      this.log("bond formation failed", { error: String(error?.message ?? error) });
    }
    // Citizen secret societies: hidden orders (Gilded Ledger, Shadow Circle,
    // Old Guard) hold night meetings, advance agendas, and quietly recruit
    // trusted players. Data tier, zero LLM.
    try {
      tickSocieties(this, nowMs);
    } catch (error) {
      this.log("societies failed", { error: String(error?.message ?? error) });
    }
    // Citizen clans: formation, growth, player invites, outings,
    // celebrations and skill moots. Data tier, zero LLM.
    try {
      tickClans(this, nowMs);
    } catch (error) {
      this.log("clans failed", { error: String(error?.message ?? error) });
    }
    // Citizen homes: assignment, rent collection, furnishing, gatherings.
    // Data tier, zero LLM.
    try {
      tickHomes(this, nowMs);
    } catch (error) {
      this.log("homes failed", { error: String(error?.message ?? error) });
    }
    // Citizen careers: assignment, promotions, wages, changes, teaching.
    // Data tier, zero LLM.
    try {
      tickCareers(this, nowMs);
    } catch (error) {
      this.log("careers failed", { error: String(error?.message ?? error) });
    }
    // Citizen families: formation, births, growing up, coming of age,
    // teaching, inheritance, protection. Data tier, zero LLM.
    try {
      tickFamilies(this, nowMs);
    } catch (error) {
      this.log("families failed", { error: String(error?.message ?? error) });
    }
    // Citizen aging: birthdays, life stages, wisdom, career retirement,
    // immigration. Data tier, zero LLM.
    try {
      tickAging(this, nowMs);
    } catch (error) {
      this.log("aging failed", { error: String(error?.message ?? error) });
    }
    // Citizen government: councils, elections, laws, unrest. Data tier,
    // zero LLM.
    try {
      tickGovernments(this, nowMs);
    } catch (error) {
      this.log("governments failed", { error: String(error?.message ?? error) });
    }
    // Citizen faith: gods, devotion, priests, holy days, holy wars.
    // Data tier, zero LLM.
    try {
      tickFaith(this, nowMs);
    } catch (error) {
      this.log("faith failed", { error: String(error?.message ?? error) });
    }
    // Citizen festival life: merged festival calendar (seasonal +
    // religious feasts), council festival weeks, anticipation, unrest
    // relief. Data tier, zero LLM.
    try {
      tickFestivalLife(this, nowMs);
    } catch (error) {
      this.log("festival life failed", { error: String(error?.message ?? error) });
    }
    // Citizen schools: schoolhouses, family-children pupils, tuition,
    // graduation. Data tier, zero LLM.
    try {
      tickSchools(this, nowMs);
    } catch (error) {
      this.log("schools failed", { error: String(error?.message ?? error) });
    }
    // Citizen health: illness onset, contagion, recovery, healers,
    // hospitals, epidemics. Data tier, zero LLM.
    try {
      tickHealth(this, nowMs);
    } catch (error) {
      this.log("health failed", { error: String(error?.message ?? error) });
    }
    // Citizen justice: crime onset, curfew, trials, punishments, jail.
    // Data tier, zero LLM.
    try {
      tickJustice(this, nowMs);
    } catch (error) {
      this.log("justice failed", { error: String(error?.message ?? error) });
    }
    // Citizen legal: judges, appeals, pardons, player trials.
    // Data tier, zero LLM.
    try {
      tickLegalLife(this, nowMs);
    } catch (error) {
      this.log("legal failed", { error: String(error?.message ?? error) });
    }
    // Citizen surgery: surgeons, procedures, research, quarantine.
    // Data tier, zero LLM. Complements CitizenHealth (never duplicates).
    try {
      tickSurgery(this, nowMs);
    } catch (error) {
      this.log("surgery failed", { error: String(error?.message ?? error) });
    }
    // Citizen travel: ship/caravan journeys, arrivals, danger, cargo.
    // Data tier, zero LLM.
    try {
      tickTravel(this, nowMs);
    } catch (error) {
      this.log("travel failed", { error: String(error?.message ?? error) });
    }
    // Citizen entertainment: taverns, bards, theater, arena, sobriety.
    // Data tier, zero LLM.
    try {
      tickEntertain(this, nowMs);
    } catch (error) {
      this.log("entertainment failed", { error: String(error?.message ?? error) });
    }
    // Citizen day/night: transitions, sleep, night watch, stargazing.
    // Data tier, zero LLM.
    try {
      tickDayNight(this, nowMs);
    } catch (error) {
      this.log("daynight failed", { error: String(error?.message ?? error) });
    }
    // Citizen reputation: fame decay, crime sync, skill-mastery renown,
    // fame announcements, bard songs. Data tier, zero LLM.
    try {
      tickReputation(this, nowMs);
    } catch (error) {
      this.log("reputation failed", { error: String(error?.message ?? error) });
    }
    // Citizen guilds: favor decay, rank announcements, mission expiry,
    // rivalry drift, training favor. Data tier, zero LLM.
    try {
      tickGuilds(this, nowMs);
    } catch (error) {
      this.log("guilds failed", { error: String(error?.message ?? error) });
    }
    // Citizen pets: hunger/happiness decay, breeding, taming.
    // Data tier, zero LLM.
    try {
      tickPets(this, nowMs);
    } catch (error) {
      this.log("pets failed", { error: String(error?.message ?? error) });
    }
    // Citizen art: exhibitions, market expiry, inspiration.
    // Data tier, zero LLM.
    try {
      tickArt(this, nowMs);
    } catch (error) {
      this.log("art failed", { error: String(error?.message ?? error) });
    }

// Citizen tournaments: seasonal brackets, entries, payouts, betting.
    // Data tier, zero LLM.
    try {
      tickTournaments(this, nowMs);
    } catch (error) {
      this.log("tournaments failed", { error: String(error?.message ?? error) });
    }
    // Citizen covert diplomacy: marriage alliances, espionage.
    // Data tier, zero LLM. (CitizenDiplomats owns the overt layer.)
    try {
      tickCovertDiplomacy(this, nowMs);
    } catch (error) {
      this.log("diplomacy failed", { error: String(error?.message ?? error) });
    }
    // Citizen discoveries: trade-route adoption, fame deeds, announcements.
    // Data tier, zero LLM. (CitizenExplorers owns the expedition sim.)
    try {
      tickDiscoveryLife(this, nowMs);
    } catch (error) {
      this.log("discovery failed", { error: String(error?.message ?? error) });
    }
    // Citizen inventions: research progress, breakthroughs, patents.
    // Data tier, zero LLM. (CitizenEngineers owns the flavor layer.)
    try {
      tickInventionLife(this, nowMs);
    } catch (error) {
      this.log("invention failed", { error: String(error?.message ?? error) });
    }
    // Citizen philosophy: debates, sage announcements, wisdom.
    // Data tier, zero LLM. (CitizenFaith owns gods/devotion/priests.)
    try {
      tickPhilosophy(this, nowMs);
    } catch (error) {
      this.log("philosophy failed", { error: String(error?.message ?? error) });
    }    try {
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
      if (CitizenClans.save()) {
        this.log("citizen clans saved");
      }
    } catch (error) {
      this.log("citizen clans save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenHomes.save()) {
        this.log("citizen homes saved");
      }
    } catch (error) {
      this.log("citizen homes save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenCareers.save()) {
        this.log("citizen careers saved");
      }
    } catch (error) {
      this.log("citizen careers save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenFamilies.save()) {
        this.log("citizen families saved");
      }
    } catch (error) {
      this.log("citizen families save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (Aging.save()) {
        this.log("citizen aging saved");
      }
    } catch (error) {
      this.log("citizen aging save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenGovernment.save()) {
        this.log("citizen government saved");
      }
    } catch (error) {
      this.log("citizen government save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenFaith.save()) {
        this.log("citizen faith saved");
      }
    } catch (error) {
      this.log("citizen faith save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenSchools.save()) {
        this.log("citizen schools saved");
      }
    } catch (error) {
      this.log("citizen schools save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenHealth.save()) {
        this.log("citizen health saved");
      }
    } catch (error) {
      this.log("citizen health save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenCrime.save()) {
        this.log("citizen crime saved");
      }
    } catch (error) {
      this.log("citizen crime save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenLegalCode.save()) {
        this.log("citizen legal code saved");
      }
    } catch (error) {
      this.log("citizen legal code save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      const CitizenSurgery = require("../lib/CitizenSurgery");
      if (CitizenSurgery.save()) {
        this.log("citizen surgery saved");
      }
    } catch (error) {
      this.log("citizen surgery save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenTravel.save()) {
        this.log("citizen travel saved");
      }
    } catch (error) {
      this.log("citizen travel save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenEntertainment.save()) {
        this.log("citizen entertainment saved");
      }
    } catch (error) {
      this.log("citizen entertainment save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (require("../lib/CitizenSeasons").save()) {
        this.log("citizen seasons saved");
      }
    } catch (error) {
      this.log("citizen seasons save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (require("../lib/CitizenDayNight").save()) {
        this.log("citizen daynight saved");
      }
    } catch (error) {
      this.log("citizen daynight save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenReputation.save()) {
        this.log("citizen reputation saved");
      }
    } catch (error) {
      this.log("citizen reputation save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenGuilds.save()) {
        this.log("citizen guilds saved");
      }
    } catch (error) {
      this.log("citizen guilds save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      CitizenPets.save();
    } catch (error) {
      this.log("citizen pets save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenArt.save()) {
        this.log("citizen art saved");
      }
    } catch (error) {
      this.log("citizen art save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {

if (CitizenTournaments.save()) {
        this.log("citizen tournaments saved");
      }
    } catch (error) {
      this.log("citizen tournaments save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenDiplomacy.save()) {
        this.log("citizen diplomacy saved");
      }
    } catch (error) {
      this.log("citizen diplomacy save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenDiscovery.save()) {
        this.log("citizen discoveries saved");
      }
    } catch (error) {
      this.log("citizen discoveries save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenInventions.save()) {
        this.log("citizen inventions saved");
      }
    } catch (error) {
      this.log("citizen inventions save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (CitizenPhilosophy.save()) {
        this.log("citizen philosophy saved");
      }
    } catch (error) {
      this.log("citizen philosophy save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {      if (saveFuneralsIfDirty()) {
        this.log("citizen funerals saved");
      }
    } catch (error) {
      this.log("citizen funerals save failed", {
        error: String(error?.message ?? error),
      });
    }
    try {
      if (saveDeathsIfDirty()) {
        this.log("citizen deaths saved");
      }
    } catch (error) {
      this.log("citizen deaths save failed", {
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
