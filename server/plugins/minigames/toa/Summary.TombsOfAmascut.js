"use strict";

/**
 * Tombs of Amascut: the scoreboard in Osmumten's burial chamber (toa_vault_scoreboard,
 * "Scoreboard": Read). It isn't the lobby's records board: it shows this raid's summary,
 * interface toa_raid_summary.
 *
 * rsprox 227/01852, 00581, 01753 and 01845: Read runs toplevel_mainmodal_open [-1, -1], opens
 * toa_raid_summary on the main modal, and sets:
 * - the nine room times, "m:ss.cc": kephri_time, baba_time, akkha_time, zebak_time and
 *   wardens_time (the bosses, the Wardens' phases together), then scabaras_time, apmeken_time,
 *   crondis_time and het_time (the puzzle rooms);
 * - challenge_total, the nine added up (01852: 17:37.80), and overall_total, the whole raid
 *   (20:00.60);
 * - active (the invocations on, "23") and raid_level ("530").
 * It then runs script 6590 once per party member, most damage dealt first: [name, damage dealt, damage taken, deaths,
 * title struct, -1, slot, party size, is the reader]. The script prints the three numbers and
 * the title's name (struct param 1525, "The Brawler"), or "-" for a title of -1.
 */

const Shared = require("./Shared.TombsOfAmascut");
const Raid = require("./RaidState.TombsOfAmascut");

const LOC_NAME = "toa_vault_scoreboard";
const INTERFACE_NAME = "toa_raid_summary";
/** No title: the row's title cell reads "-". */
const NO_TITLE = -1;

/** Each time component and the raid rooms (Shared.ROOMS keys) whose times it adds up. */
const ROOM_TIMES = [
  ["kephri_time", ["SCABARAS_BOSS"]],
  ["baba_time", ["APMEKEN_BOSS"]],
  ["akkha_time", ["HET_BOSS"]],
  ["zebak_time", ["CRONDIS_BOSS"]],
  ["wardens_time", ["WARDENS_P1", "WARDENS_P3"]],
  ["scabaras_time", ["SCABARAS_PUZZLE"]],
  ["apmeken_time", ["APMEKEN_PUZZLE"]],
  ["crondis_time", ["CRONDIS_PUZZLE"]],
  ["het_time", ["HET_PUZZLE"]],
];

const cache = () => Shared.core().CacheDefinitions;
const uid = (component) => cache().getComponentId(`${INTERFACE_NAME}:${component}`);

/** m:ss.cc (h:mm:ss.cc past an hour), as the summary prints times; "-" for a room not done. */
function formatTicks(ticks) {
  return ticks > 0 ? Shared.formatTicksHundredths(ticks) : "-";
}

/** The component texts for `raid`, in the recording's order. */
function texts(raid) {
  const ticksOf = (keys) => raid.results.filter((result) => keys.includes(result.key))
    .reduce((sum, result) => sum + result.ticks, 0);
  const rooms = ROOM_TIMES.map(([component, keys]) => [component, ticksOf(keys)]);
  const challenge = rooms.reduce((sum, [, ticks]) => sum + ticks, 0);
  return [
    ["overall_total", formatTicks(raid.totalTicks)],
    ["challenge_total", formatTicks(challenge)],
    ...rooms.map(([component, ticks]) => [component, formatTicks(ticks)]),
    ["active", String(raid.settings.activeCount)],
    ["raid_level", String(raid.raidLevel)],
  ];
}

/**
 * Script 6590's arguments for each member still in the raid. Every recording lists them by
 * damage dealt, most first, and numbers the slots in that order (in each, the reader also dealt
 * the most, so "reader first" would fit them as well).
 */
function rows(raid, reader) {
  const members = [...raid.members.entries()].sort(([, a], [, b]) => b.damageDone - a.damageDone);
  return members.map(([player, member], slot) => [
    Shared.displayName(player),
    Math.max(0, Math.trunc(member.damageDone)),
    Math.max(0, Math.trunc(member.damageTaken)),
    member.deaths,
    NO_TITLE,
    -1,
    slot,
    members.length,
    player === reader ? 1 : 0, // a clientscript boolean is an int
  ]);
}

function read(event) {
  if (event.objectId !== cache().getLocId(LOC_NAME)) return false;
  const { player } = event;
  const raid = Raid.raidOf(player);
  if (!raid) return false;
  const sender = player.getPacketSender();
  sender.sendInterfaceScript(Shared.SCRIPT.MAINMODAL_OPEN, [-1, -1]);
  sender.sendInterface(cache().getInterfaceId(INTERFACE_NAME));
  for (const [component, text] of texts(raid)) sender.sendString(text, uid(component));
  for (const row of rows(raid, player)) sender.sendInterfaceScript(Shared.SCRIPT.SUMMARY_MEMBER_ROW, row);
  return true;
}

module.exports = function registerTombsSummary(api) {
  Shared.bind(api);
  api.onObjectInteraction("Scoreboard", { Read: read });
};

Object.assign(module.exports, { read, texts, rows, formatTicks, ROOM_TIMES, LOC_NAME, INTERFACE_NAME });
