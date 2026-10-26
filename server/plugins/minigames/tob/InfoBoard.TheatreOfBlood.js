"use strict";

/**
 * The strategy table in Verzik Vitur's vault (tob_dungeon_treasure_room_library_table_a: Read),
 * interface tob_infoboard: the raid's performance.
 *
 * rsprox 237/01163, 227/01758 and six more: Read opens tob_infoboard as the main modal and writes
 * each wave's name and time (ch1-ch6, "1:29.40"-style), the MVP's name, the challenge time and the
 * overall time, then each member's name and deaths (playername0-4 / deaths0-4) and the total.
 * Wiki (Theatre of Blood): the challenge time is the time spent fighting the bosses, the overall
 * time also counts the time between waves; the MVP is decided by damage dealt and deaths.
 *
 * Here the challenge time adds up the rooms' fight times (RaidState's room times) and the overall
 * time runs from the Maiden's fight starting to Verzik's defeat (both match 237/01163's numbers).
 * The members are the party at Verzik's defeat. The MVP is the member with the most damage after
 * the reward's own death penalty (Rewards.standing): the Wiki gives no formula.
 */

const Shared = require("./Shared.TheatreOfBlood");
const Raid = require("./RaidState.TheatreOfBlood");
const Rewards = require("./Rewards.TheatreOfBlood");

const INTERFACE_NAME = "tob_infoboard";
const WAVES = ["MAIDEN", "BLOAT", "NYLOCAS", "SOTETSEG", "XARPUS", "VERZIK"];

const uid = (component) => Shared.core().CacheDefinitions.getComponentId(`${INTERFACE_NAME}:${component}`);

/** m:ss.cc, as the board shows times; "-" for a wave not timed. */
function formatTime(ticks) {
  if (!(ticks > 0)) return "-";
  const centis = Math.round(ticks * 60);
  return `${Math.floor(centis / 6000)}:${String(Math.floor(centis / 100) % 60).padStart(2, "0")}.${String(centis % 100).padStart(2, "0")}`;
}

function damageOf(member) {
  return Object.values(member.rooms ?? {}).reduce((sum, stats) => sum + (stats.damage ?? 0), 0);
}

/** Who took part: the party at Verzik's defeat, else whoever is in the raid now. */
function rosterOf(raid) {
  return raid.roster ?? [...raid.members].map(([player, member]) => ({ name: Shared.displayName(player), member }));
}

/** The member with the most damage after the death penalty; null with nobody scored. */
function mvpOf(roster) {
  let best = null;
  let bestScore = 0;
  for (const entry of roster) {
    const score = damageOf(entry.member) * Rewards.standing(entry.member);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

function lines(raid) {
  const strings = new Map();
  WAVES.forEach((key, index) => {
    strings.set(`ch${index + 1}_name`, Shared.ROOMS[key].name);
    strings.set(`ch${index + 1}_time`, formatTime(raid.roomTicks?.[key]));
  });
  const roster = rosterOf(raid);
  const mvp = mvpOf(roster);
  strings.set("mvp_player", mvp ? mvp.name : "-");
  strings.set("challenge_time_time", formatTime(raid.totalTicks));
  strings.set("overall_time_time", formatTime(raid.overallTicks));
  let total = 0;
  roster.slice(0, Shared.MAX_PARTY_SIZE).forEach(({ name, member }, index) => {
    total += member.deaths;
    strings.set(`deaths${index}`, String(member.deaths));
    strings.set(`playername${index}`, name);
  });
  strings.set("totaldeaths", String(total));
  return strings;
}

/** Only in the vault of the reader's own raid; anywhere else the table is left alone. */
function read(event) {
  const raid = Raid.raidOf(event.player);
  if (!raid || raid.room?.key !== "REWARDS") return false;
  const sender = event.player.getPacketSender();
  sender.sendInterface(Shared.core().CacheDefinitions.getInterfaceId(INTERFACE_NAME));
  for (const [component, text] of lines(raid)) sender.sendString(text, uid(component));
  return true;
}

module.exports = function registerTheatreInfoBoard(api) {
  Shared.bind(api);
  api.onObjectInteraction("Strategy table", { Read: read });
};

Object.assign(module.exports, { read, lines, mvpOf, rosterOf, formatTime, uid });
