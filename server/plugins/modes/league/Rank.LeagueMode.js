/**
 * League ranks (data/league-ranks.json): Bronze to Dragon at a league's League Points thresholds,
 * the brackets the trophies are awarded in. The rank interface (64) reads the league struct's
 * threshold and trophy enums; the cache carries them for Leagues IV-VI and this unit sends
 * Leagues I-III's as overrides (league:content-rows). As captured, varbit league_rank_notification
 * holds the number of ranks reached, sent at login and on the award that crosses a threshold,
 * with one game message per rank. Other plugins ask
 *
 *   api.emitCustomEvent("league:rank", { player })  -> rank (0-7), name, next (points to the next rank, or null)
 */
const Common = require("./Common.LeagueMode");

const data = require("../data/league-ranks.json");

/** A league whose thresholds the cache lacks: its rows here carry the trophies and are sent as overrides. */
function overridden(type) {
  return Array.isArray(data.leagues[type]?.trophies);
}

function enumInts(id) {
  const values = Common.core.CacheDefinitions.getEnumValues(id);
  return [...values.entries()].sort(([a], [b]) => a - b).map(([, value]) => Number(value));
}

/** The league's thresholds, lowest first: the Wiki's for an overridden league, else the cache's enum. */
function thresholds(type) {
  const row = data.leagues[type];
  if (!row) return [];
  if (overridden(type)) return row.wiki;
  const params = Common.core.CacheDefinitions.getStructParams(Common.league(type).struct);
  const enumId = params?.get(data.params.thresholdsEnum);
  return Number.isInteger(enumId) && enumId >= 0 ? enumInts(enumId) : [];
}

/** The league's trophy item ids by rank. */
function trophies(type) {
  const row = data.leagues[type];
  if (!row) return [];
  if (overridden(type)) return row.trophies.map((name) => Common.core.ItemIdentifiers[name]).filter(Number.isInteger);
  const params = Common.core.CacheDefinitions.getStructParams(Common.league(type).struct);
  const enumId = params?.get(data.params.trophiesEnum);
  return Number.isInteger(enumId) && enumId >= 0 ? enumInts(enumId) : [];
}

function points(player) {
  const query = { player, points: 0, tasks: 0 };
  Common.api.emitCustomEvent("league:points", query);
  return query.points | 0;
}

/** How many ranks `total` points reach in the league. */
function rankFor(type, total) {
  return thresholds(type).filter((threshold) => total >= threshold).length;
}

function sendRank(player, rank) {
  player.getPacketSender().sendVarbit(data.varbit, rank);
}

function login({ player, league }) {
  sendRank(player, rankFor(league, points(player)));
}

function pointsChanged({ player, points: total, previous }) {
  const type = Common.leagueOf(player);
  if (type === null) return;
  const before = rankFor(type, previous);
  const after = rankFor(type, total);
  if (after <= before) return;
  sendRank(player, after);
  for (let rank = before; rank < after; rank++) {
    player.sendMessage(data.message.text.replace("{rank}", data.names[rank]));
  }
}

function answerRank(query) {
  if (!query?.player) return;
  const type = Common.leagueOf(query.player);
  if (type === null) return;
  const steps = thresholds(type);
  const rank = rankFor(type, points(query.player));
  query.rank = rank;
  query.name = rank > 0 ? data.names[rank - 1] : null;
  query.next = rank < steps.length ? steps[rank] : null;
}

/** Leagues I-III: the struct params and enums the rank interface reads, as the cache has them for IV-VI. */
function content(query) {
  const type = query?.league;
  if (!overridden(type)) return;
  const thresholdsEnum = query.base + data.virtualIdOffsets.thresholdsEnum;
  const trophiesEnum = query.base + data.virtualIdOffsets.trophiesEnum;
  query.structs.push({ structId: Common.league(type).struct, params: {
    [data.params.thresholdsEnum]: thresholdsEnum,
    [data.params.trophiesEnum]: trophiesEnum,
  } });
  query.enums.push({ enumId: thresholdsEnum, valueType: "i", defaultValue: 0, entries: thresholds(type).map((value, rank) => [rank, value]) });
  query.enums.push({ enumId: trophiesEnum, valueType: "O", defaultValue: -1, entries: trophies(type).map((item, rank) => [rank, item]) });
}

module.exports = function attach(api) {
  api.onCustomEvent("league:login", login);
  api.onCustomEvent("league:points-changed", pointsChanged);
  api.onCustomEvent("league:rank", answerRank);
  api.onCustomEvent("league:content-rows", content);
};

module.exports.thresholds = thresholds;
module.exports.trophies = trophies;
module.exports.rankFor = rankFor;
module.exports.data = data;
