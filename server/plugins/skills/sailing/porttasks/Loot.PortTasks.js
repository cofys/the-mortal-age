// Wiki size pages, fetched 29 October 2026. See docs/port-tasks.md for source limits.
const DATA = require('../data/port-reward-bags.json');
const common = require('./Common.PortTasks');

function tableFor(itemId) {
  for (const [port, ids] of Object.entries(common.DATA.rewardBags)) {
    const size = ids.indexOf(itemId);
    if (size < 0) continue;
    const tier = DATA.tiers[size];
    const local = tier?.ports[port];
    return local ? { tier, local } : null;
  }
  return null;
}

function choose(rows, total, random) {
  let roll = Math.floor(random() * total);
  for (const row of rows) {
    roll -= row.weight;
    if (roll < 0) return row;
  }
  return null;
}

function roll(table, random = Math.random) {
  const shared = choose(table.tier.shared, table.tier.totalWeight, random);
  const row = shared ?? choose(table.local, table.local.reduce((sum, entry) => sum + entry.weight, 0), random);
  return { item: row.item, amount: row.min + Math.floor(random() * (row.max - row.min + 1)) };
}

/** Validate saved pending rolls against the current supported table before delivery. */
function valid(table, reward) {
  return reward && Number.isSafeInteger(reward.amount) &&
    [...table.tier.shared, ...table.local].some(row => row.item === reward.item &&
      reward.amount >= row.min && reward.amount <= row.max);
}

module.exports = { DATA, tableFor, roll, valid };
