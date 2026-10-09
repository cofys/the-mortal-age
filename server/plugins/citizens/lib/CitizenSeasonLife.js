"use strict";

/**
 * CitizenSeasonLife — director tick dynamics for seasons and climate.
 * Data tier, zero LLM.
 *
 * Each slow tick (~60s):
 *  1. Season transitions: when the season changes, every roster citizen
 *     journals it once (shared history for the LLM mouth), and citizens
 *     near a real player announce it with personality-gated lines.
 *     The announcement is persisted so restarts don't repeat it.
 *  2. Rain growth: when the Sky says rain (or storm), citizen-tended farms
 *     get bonus growth — botFarm.advanceFarm(farm, now + bonusMs), the same
 *     engine function the farming tick uses, with extra elapsed time.
 *     Rain in spring is the fastest growth in the realm. Player farms are
 *     untouched: the farming tick owns those.
 *  3. Seasonal reactions: near real players only, cooldown-gated —
 *     winter cold complaints and warm-clothes talk, spring planting hope,
 *     summer heat grumbles, autumn harvest excitement.
 *  4. Storm shelter: during a storm, online citizens near players walk
 *     home (complements CitizenWeatherReactions' storm lines).
 *
 * Wiring: CitizenDirector calls tickSeasonLife(this, nowMs) in the slow
 * tick inside try/catch. CitizenSeasons.save() goes in the save section.
 * Plain-node testable: CitizenSeasonLife.test.js.
 */

const Seasons = require("./CitizenSeasons");
const { agentRng } = require("./humanizer");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");

// === Tuning ===
const REACTION_RADIUS = 16; // tiles — close enough to see/hear
const SEASON_ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // a citizen announces a season at most this often
const SEASONAL_COMMENT_CHANCE = 0.12; // per eligible citizen per tick
const SEASONAL_COMMENT_COOLDOWN_MS = 3 * 60 * 60 * 1000;

// === Sky access (same lazy pattern as CitizenWeatherReactions) ===
let Sky = null;
function getSky() {
  if (!Sky) {
    try {
      Sky = require("../../skills/fishing/Conditions.Fishing");
    } catch {
      Sky = null;
    }
  }
  return Sky;
}
/** Test seam: inject a fake sky. */
function _setSky(fake) {
  Sky = fake;
}

// === Cooldown state ===
const lastSeasonAnnounce = new Map(); // username -> timestamp
const lastSeasonalComment = new Map(); // username -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastSeasonAnnounce) if (at < cutoff) lastSeasonAnnounce.delete(k);
  for (const [k, at] of lastSeasonalComment) if (at < cutoff) lastSeasonalComment.delete(k);
}
/** Test seam: reset cooldown state. */
function _resetState() {
  lastSeasonAnnounce.clear();
  lastSeasonalComment.clear();
  lastPruneAt = 0;
}

// === Scripted line pools (zero LLM, personality-gated) ===
const LINES = Object.freeze({
  seasonAnnounce: {
    spring: [
      "Spring's here! Time to get the fields planted.",
      "Smell that? Spring. New beginnings, friend.",
      "Spring at last. The planting season begins!",
    ],
    summer: [
      "Summer's come. Long days, warm nights.",
      "Ah, summer. Best time of the year, if you ask me.",
      "Summer! The fields are green and the days are long.",
    ],
    autumn: [
      "Autumn's here. Harvest time — every hand in the fields!",
      "Fall is come. The harvest won't wait, you know.",
      "Autumn. My favorite season — the harvest, the colors...",
    ],
    winter: [
      "Winter's here. Bundle up, it's going to be a cold one.",
      "Brrr. Winter. Time for cloaks and firesides.",
      "Winter come. Stock the larder and mend the roof.",
    ],
  },
  cold: [
    "Freezing out here. My fingers are numb.",
    "This cold bites right through my cloak.",
    "Winter's got teeth this year.",
    "*shivers* Need to get inside by a fire.",
  ],
  warmClothes: [
    "Good thing I've got my winter cloak. You should get one.",
    "Furs and wool — that's the secret to winter.",
    "Dressed warm today. Learned that lesson the hard way once.",
  ],
  springHope: [
    "Planted the first seeds yesterday. Fingers crossed.",
    "Spring planting — the most hopeful work there is.",
    "The soil's warming up. Going to be a good year, I can feel it.",
  ],
  summerHeat: [
    "Too hot to work the fields at midday. Mornings and evenings.",
    "This heat... I miss the spring already.",
    "Shade and water, that's the summer rule.",
  ],
  autumnHarvest: [
    "Harvest's coming in well this year. The barns will be full.",
    "Nothing like harvest time. All that work paying off.",
    "Have you seen the wheat? Tallest in years, I'd wager.",
  ],
  stormShelter: [
    "Storm's getting worse. I'm heading in.",
    "Not staying out in this. Home, now.",
  ],
});

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch {
    return false;
  }
}

function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch {
    return false;
  }
}

function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = [...(director.roster?.values() ?? [])]
      .filter((r) => director.isOnline(r))
      .map((r) => director.getBot(r))
      .filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function rosterRecords(director) {
  try {
    const roster = director?.roster;
    if (!roster) return [];
    if (typeof roster.values === "function") return Array.from(roster.values());
    if (Array.isArray(roster)) return roster;
    return Object.values(roster);
  } catch {
    return [];
  }
}

function traitsOf(record) {
  return new Set(record?.personality?.traits ?? []);
}

function say(bot, line) {
  try {
    const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [String(line).slice(0, 120)] }));
  } catch {
    // Non-fatal.
  }
}

function journal(username, text, data) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(username, "season", text, { data });
  } catch {
    // The journal must never break the seasons.
  }
}

function makeLocation(director, x, y, z) {
  try {
    const Loc = director?.api?.core?.Location;
    if (Loc) return new Loc(x, y, z ?? 0);
  } catch {
    // Non-fatal.
  }
  return null;
}

function walkHome(director, bot, record) {
  try {
    const home = record?.home;
    if (!home || typeof home.x !== "number") return false;
    const loc = makeLocation(director, home.x, home.y, home.z);
    if (!loc) return false;
    bot.moveTo?.(loc);
    return true;
  } catch {
    return false;
  }
}

// --- Rain growth boost -------------------------------------------------------
// Citizen farms (not player farms — the farming tick owns those) grow faster
// in the rain. We find online citizen bots, get their farm via botFarm, and
// advance the real growth clock by the bonus. Defensive throughout: a missing
// farming plugin or a weird farm object just skips.

function botFarmModule() {
  try {
    return require("../../skills/farming/Patches.Farming")?.botFarm ?? null;
  } catch {
    return null;
  }
}

function applyRainGrowth(director, nowMs, weather, rng) {
  const bonusMs = Seasons.rainBonusMs(nowMs, weather);
  if (bonusMs <= 0) return 0;
  const BF = botFarmModule();
  if (!BF || typeof BF.advanceFarm !== "function" || typeof BF.farmFor !== "function") return 0;
  let boosted = 0;
  for (const record of rosterRecords(director)) {
    try {
      if (!director.isOnline(record)) continue;
      const bot = director.getBot(record);
      if (!bot) continue;
      const farm = BF.farmFor(bot);
      if (!farm) continue;
      BF.advanceFarm(farm, nowMs + bonusMs, rng);
      boosted++;
    } catch {
      // One bad farm never breaks the rain.
    }
  }
  return boosted;
}

// --- Season transition announcements ----------------------------------------

function seasonTransition(director, nowMs, rng) {
  const season = Seasons.seasonOf(nowMs);
  const announced = Seasons._getAnnouncedSeason();
  if (announced === season) return; // already announced (persists across restarts)
  Seasons._setAnnouncedSeason(season);
  const seasonLabel = Seasons.SEASONS[season]?.label ?? season;
  const lines = LINES.seasonAnnounce[season] ?? [];
  for (const record of rosterRecords(director)) {
    try {
      const username = record?.username;
      if (!username) continue;
      journal(username, `${seasonLabel} has arrived.`, { season });
      // Visible announcement: near a real player, cooldown-gated, one line.
      const last = lastSeasonAnnounce.get(username) || 0;
      if (nowMs - last < SEASON_ANNOUNCE_COOLDOWN_MS) continue;
      const bot = director.isOnline(record) ? director.getBot(record) : null;
      if (!bot || !anyRealPlayerNear(director, bot, REACTION_RADIUS)) continue;
      if (!lines.length) continue;
      say(bot, pickOne(rng, lines));
      lastSeasonAnnounce.set(username, nowMs);
    } catch {
      // Per-citizen try/catch.
    }
  }
}

// --- Seasonal ambient reactions (near players, cooldown + chance) ------------

function seasonalReaction(director, nowMs, rng) {
  const season = Seasons.seasonOf(nowMs);
  const pool =
    season === "winter" ? [...LINES.cold, ...LINES.warmClothes]
    : season === "spring" ? LINES.springHope
    : season === "summer" ? LINES.summerHeat
    : LINES.autumnHarvest;
  for (const record of rosterRecords(director)) {
    try {
      const username = record?.username;
      if (!username) continue;
      const last = lastSeasonalComment.get(username) || 0;
      if (nowMs - last < SEASONAL_COMMENT_COOLDOWN_MS) continue;
      if (rng() >= SEASONAL_COMMENT_CHANCE) continue;
      const bot = director.isOnline(record) ? director.getBot(record) : null;
      if (!bot || !anyRealPlayerNear(director, bot, REACTION_RADIUS)) continue;
      say(bot, pickOne(rng, pool));
      lastSeasonalComment.set(username, nowMs);
    } catch {
      // Per-citizen try/catch.
    }
  }
}

// --- Storm shelter: walk home during storms -----------------------------------

function stormShelter(director, nowMs, weather) {
  if (String(weather ?? "").toLowerCase() !== "storm") return;
  for (const record of rosterRecords(director)) {
    try {
      const username = record?.username;
      if (!username) continue;
      const bot = director.isOnline(record) ? director.getBot(record) : null;
      if (!bot || !anyRealPlayerNear(director, bot, REACTION_RADIUS)) continue;
      // Guards hold their post; everyone else gets inside.
      if (String(record?.role ?? "").toLowerCase() === "guard") continue;
      if (walkHome(director, bot, record)) {
        journal(username, "Took shelter from the storm.", { weather: "storm" });
      }
    } catch {
      // Per-citizen try/catch.
    }
  }
}

// --- The tick -----------------------------------------------------------------

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {function} rng - random source (default agentRng; inject for tests)
 */
function tickSeasonLife(director, nowMs, rng = agentRng) {
  pruneCooldowns(nowMs);
  const sky = getSky();
  let weather = "clear";
  try {
    weather = String(sky?.getWeather?.() ?? "clear").toLowerCase();
  } catch {
    weather = "clear";
  }

  try {
    seasonTransition(director, nowMs, rng);
  } catch (e) {
    console.warn("[citizen-seasons] transition failed:", e?.message ?? e);
  }
  try {
    const boosted = applyRainGrowth(director, nowMs, weather, rng);
    if (boosted > 0 && process.env.CITIZEN_DEBUG) {
      console.log(`[citizen-seasons] rain boosted ${boosted} citizen farms`);
    }
  } catch (e) {
    console.warn("[citizen-seasons] rain growth failed:", e?.message ?? e);
  }
  try {
    seasonalReaction(director, nowMs, rng);
  } catch (e) {
    console.warn("[citizen-seasons] reactions failed:", e?.message ?? e);
  }
  try {
    stormShelter(director, nowMs, weather);
  } catch (e) {
    console.warn("[citizen-seasons] storm shelter failed:", e?.message ?? e);
  }
}

module.exports = {
  tickSeasonLife,
  // Pure-ish helpers for tests:
  seasonTransition,
  applyRainGrowth,
  seasonalReaction,
  stormShelter,
  pickOne,
  // Test seams:
  _setSky,
  _resetState,
};
