/**
 * Explorer's ring (Wiki: Explorer's ring 1-4): Energy restores 50% run energy two, three or four
 * times a day (ring 4: 100%, three times), and Check reports the day's charges, as captured on
 * ring 4: "You have # out of # alchemy charges left and # of your # energy restores left for
 * today." Rings 2-4 carry Energy in their Functions submenu. The cabbage patch teleport is in
 * Teleports.DiaryRewards.js; Alchemy.DiaryRewards.js supplies the native free-casting panel.
 */
const Rewards = require("./Common.DiaryRewards");
const Daily = require("./DailyRing.DiaryRewards");
const Alchemy = require("./Alchemy.DiaryRewards");

const ENERGY_KEY = Daily.ENERGY_KEY;
const ALCHEMY_KEY = Daily.ALCHEMY_KEY;
const TELEPORT_KEY = "cabbage-patch";
const FUNCTIONS_OPTION = "Functions";
const ENERGY_SUBOP = "Energy";
const FULL_ENERGY = 100;
const SPENT_MESSAGE = "You have used all of your energy restores for today.";
const ENERGY_MESSAGE = (left, max) =>
  `You have ${left} of your ${max} energy restores left for today.`;
const CHECK_MESSAGE = (alchs, alchMax, energy, energyMax) =>
  `You have ${alchs} out of ${alchMax} alchemy charges left and ${energy} of your ${energyMax} energy restores left for today.`;
const TELEPORTS_MESSAGE = (left, max) =>
  `You have ${left} of your ${max} teleports left for today.`;

function ring() {
  return Rewards.DATA.explorersRing;
}

function restoreEnergy(player, tier) {
  const max = ring().energyPerDay[tier];
  const used = Daily.uses(player, ENERGY_KEY);
  if (used >= max) {
    player.sendMessage(SPENT_MESSAGE);
    return;
  }
  player.setRunEnergy(
    Math.min(FULL_ENERGY, player.getRunEnergy() + ring().energyPercent[tier]),
  );
  player.getPacketSender().sendRunEnergy();
  const now = Daily.use(player, ENERGY_KEY);
  Rewards.sendCount(
    player,
    Rewards.gamevalId("varbit", ring().energyVarbit),
    now,
  );
  player.sendMessage(ENERGY_MESSAGE(max - now, max));
}

function check(player, tier) {
  const alchMax = ring().alchemyPerDay;
  const energyMax = ring().energyPerDay[tier];
  const alchs = Math.max(0, alchMax - Daily.uses(player, ALCHEMY_KEY));
  const energy = Math.max(0, energyMax - Daily.uses(player, ENERGY_KEY));
  player.sendMessage(CHECK_MESSAGE(alchs, alchMax, energy, energyMax));
  const teleports = teleportAllowance(tier);
  if (Number.isInteger(teleports) && teleports > 0) {
    player.sendMessage(
      TELEPORTS_MESSAGE(
        Math.max(0, teleports - Rewards.dailyUses(player, TELEPORT_KEY)),
        teleports,
      ),
    );
  }
}

/** The cabbage patch teleports a day at this tier (null: unlimited), from the teleport data. */
function teleportAllowance(tier) {
  const teleport = Rewards.DATA.families
    .flatMap((family) => family.teleports)
    .find((entry) => entry.limit === TELEPORT_KEY);
  return teleport?.perDay?.[tier] ?? null;
}

/** The Functions submenu's entry (cache subops), else false to fall through. */
function functions(event, tier) {
  const definition = Rewards.core.CacheDefinitions.getItem(event.itemId);
  const index = definition?.inventoryActions?.indexOf(FUNCTIONS_OPTION) ?? -1;
  const entry =
    index >= 0 && event.subOpId > 0
      ? definition.subops?.[index]?.[event.subOpId - 1]
      : null;
  if (entry === "Alchemy") { Alchemy.open(event, tier); return true; }
  if (entry !== ENERGY_SUBOP) return false;
  restoreEnergy(event.player, tier);
  return true;
}

function syncOnLogin({ player }) {
  Rewards.sendCount(
    player,
    Rewards.gamevalId("varbit", ring().energyVarbit),
    Daily.uses(player, ENERGY_KEY),
  );
  Rewards.sendCount(
    player,
    Rewards.gamevalId("varbit", ring().alchemyVarbit),
    Daily.uses(player, ALCHEMY_KEY),
  );
}

function actionsFor(tier) {
  return {
    Energy: ({ player }) => restoreEnergy(player, tier),
    Check: ({ player }) => check(player, tier),
    Alchemy: (event) => Alchemy.open(event, tier),
    [FUNCTIONS_OPTION]: (event) => functions(event, tier),
  };
}

module.exports = function attachExplorersRing(api) {
  Daily.attach(api);
  Alchemy.attach(api);
  for (const { name, tier } of Rewards.tierNames(ring().objs))
    api.onItemAction(name, actionsFor(tier));
  api.onPlayerLogin(syncOnLogin);
};

module.exports._test = {
  restoreEnergy,
  check,
  functions,
  teleportAllowance,
  ENERGY_KEY,
};
