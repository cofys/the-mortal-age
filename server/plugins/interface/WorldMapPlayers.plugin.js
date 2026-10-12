// Admins with the world map open see a dot per player, refreshed this often.
// Citizens are included as activity-colored dots when the citizen layer is on
// (sidebar toggle; defaults on).
const REFRESH_TICKS = 4;
const WORLD_MAP_PLAYERS_DATASET = "worldMapPlayers";

// Citizen layer toggle, shared with AdminWorldMapApi (declared there).
let CITIZEN_LAYER_ATTRIBUTE = "worldmap:citizen-layer";
try {
  CITIZEN_LAYER_ATTRIBUTE =
    require("./AdminWorldMapApi").CITIZEN_LAYER_ATTRIBUTE || CITIZEN_LAYER_ATTRIBUTE;
} catch {
  /* standalone: fall back to the literal */
}

const ticks = new WeakMap();
let core = null;
let citizenDirector = null;

function getCitizenDirector() {
  if (citizenDirector) return citizenDirector;
  try {
    citizenDirector = require("../citizens/director/CitizenDirector").getDirector?.() || null;
  } catch {
    citizenDirector = null;
  }
  return citizenDirector;
}

// Activity-category indexes for citizen dots. Order MUST match
// WORLD_MAP_CITIZEN_CAT_HEX in client/game/worldMap/WorldMapTypes.ts.
const CAT_SKILLING = 0;
const CAT_IDLE = 1;
const CAT_SOCIAL = 2;
const CAT_TRAVEL = 3;
const CAT_COMBAT = 4;
const CAT_WORK = 5;
const CAT_OTHER = 6;

/** Mirror of the client's activity categorization. */
function citizenCategory(activityId) {
  if (!activityId) return CAT_IDLE;
  const a = String(activityId).toLowerCase();
  if (/mine|chop|fish|gather|fire|smelt|craft|cook|herb|fletch|_rc|agility|hunt|farm|thieve|build|archaeolog|artisan|weav|tailor|chef/.test(a)) return CAT_SKILLING;
  if (/slayer|pker|patrol|guard|combat|attack|fight|war|siege|raid|boss/.test(a)) return CAT_COMBAT;
  if (/social|tavern|entertain|celebrate|perform|chat|gossip|mingle/.test(a)) return CAT_SOCIAL;
  if (/travel|stroll|flight|journey|walk|caravan|migrate/.test(a)) return CAT_TRAVEL;
  if (/rest|routine|idle|sleep|wait|stand|meal|bank/.test(a)) return CAT_IDLE;
  if (/merchant|tend|shop|stall|duty|tithe|work|job|service|courtier/.test(a)) return CAT_WORK;
  return CAT_OTHER;
}

/** [x, y, plane, isBot] per online player. */
function playerRows() {
  const rows = [];
  core.World.getPlayers().forEach((player) => {
    const loc = player.getLocation();
    rows.push([loc.getX(), loc.getY(), loc.getZ(), player.isPlayerBot?.() === true ? 1 : 0]);
  });
  return rows;
}

/**
 * [x, y, plane, 2, categoryIndex, username, online01, brainPaused01] per citizen.
 * Drawn on the admin's world map as activity-colored dots.
 */
function citizenRows() {
  const rows = [];
  const director = getCitizenDirector();
  const roster = director?.roster;
  if (!roster) return rows;
  for (const record of roster.values()) {
    try {
      const pos = record.position || record.home;
      if (!pos) continue;
      let online = 0;
      try {
        online = director.getBot?.(record) ? 1 : 0;
      } catch { /* offline */ }
      rows.push([
        Math.round(pos.x || 0),
        Math.round(pos.y || 0),
        Math.round(pos.z || 0),
        2,
        citizenCategory(record.currentActivityId),
        record.username,
        online,
        record.brainPaused ? 1 : 0,
      ]);
    } catch { /* skip bad records */ }
  }
  return rows;
}

/** Citizen layer defaults ON; the admin toggles it via the sidebar button. */
function citizenLayerOn(player) {
  try {
    return String(player.getAttribute?.(CITIZEN_LAYER_ATTRIBUTE) ?? "").trim() !== "0";
  } catch {
    return true;
  }
}

function sendPlayerDots({ player }) {
  const sender = player.getPacketSender?.();
  if (!sender?.isWorldMapOpen?.() || !core.PlayerRights.hasAdminRights(player)) {
    ticks.delete(player);
    return;
  }
  const tick = ticks.get(player) ?? 0;
  ticks.set(player, tick + 1);
  if (tick % REFRESH_TICKS === 0) {
    const rows = playerRows();
    if (citizenLayerOn(player)) {
      for (const row of citizenRows()) rows.push(row);
    }
    sender.sendContentData("server", [{ key: WORLD_MAP_PLAYERS_DATASET, rows }]);
  }
}

module.exports = {
  name: "World Map Players",
  register(api) {
    core = api.core;
    api.onPlayerProcess(sendPlayerDots);
  },
};
