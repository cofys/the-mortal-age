/**
 * Diary reward teleports (Wiki: each item's page; tiles, casts and counters from rsprox captures
 * where recorded, docs/diary-rewards.md). Each option works worn or carried, its inventory and
 * worn names both. A daily allowance is counted per destination, so upgrading an item keeps
 * the day's uses (Wiki: Ardougne cloak 3), and the elite tiers keep counting in the varbit.
 */
const Rewards = require("./Common.DiaryRewards");

const USED_MESSAGE = (used, limit, label) => `You have used ${used} of your ${limit} ${label} teleports for today.`;
const SPENT_MESSAGE = (limit, label) => `You have already used all ${limit} of your ${label} teleports for today.`;

function destinationFor(teleport, tier) {
  return Array.isArray(teleport.to) ? teleport.to[tier] : teleport.to;
}

/** The day's allowance at this tier: null for unlimited, 0 when the tier can't use it yet. */
function perDay(teleport, tier) {
  if (!teleport.perDay) return null;
  return teleport.perDay[tier] ?? null;
}

function useTeleport(player, family, teleport, tier) {
  const limit = perDay(teleport, tier);
  if (limit === 0) {
    player.sendMessage(family.locked ?? "Nothing interesting happens.");
    return;
  }
  const key = teleport.limit;
  if (key && limit !== null && Rewards.dailyUses(player, key) >= limit) {
    player.sendMessage(SPENT_MESSAGE(limit, Rewards.DATA.limits[key].label));
    return;
  }
  Rewards.teleport(player, destinationFor(teleport, tier), key ? () => countUse(player, key, limit) : undefined);
}

function countUse(player, key, limit) {
  const used = Rewards.useDaily(player, key);
  Rewards.sendCount(player, Rewards.LIMIT_VARBITS.get(key), used);
  if (limit !== null) player.sendMessage(USED_MESSAGE(used, limit, Rewards.DATA.limits[key].label));
}

/** `{ "Monastery Teleport": handler, "Kandarin Monastery": handler, ... }` for one tier. */
function actionsFor(family, tier) {
  const actions = {};
  for (const teleport of family.teleports) {
    for (const option of teleport.options) {
      actions[option] = ({ player }) => useTeleport(player, family, teleport, tier);
    }
  }
  return actions;
}

function syncOnLogin({ player }) {
  Rewards.syncCounters(player);
}

module.exports = function attachTeleports(api) {
  for (const family of Rewards.DATA.families) {
    for (const { name, tier } of Rewards.tierNames(family.objs)) api.onItemAction(name, actionsFor(family, tier));
  }
  api.onPlayerLogin(syncOnLogin);
};

module.exports._test = { useTeleport, perDay, destinationFor, actionsFor };
