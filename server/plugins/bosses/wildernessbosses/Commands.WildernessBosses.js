/**
 * Testing commands for the Wilderness bosses:
 *   ::wildboss <callisto|artio|vetion|calvarion|venenatis|spindel>   to that lair's entrance
 *   ::wildbosshp <percent>   the boss nearby to that much life (healed, or hit by you)
 */
const Common = require("./Common.WildernessBosses");

let core = null;
/** The six lair bosses and Scorpia. */
let BOSS_IDS = new Set();

function toEntrance({ player, parts }) {
  const lair = Common.LAIR_BY_KEY.get(String(parts[1] ?? "").toLowerCase());
  if (!lair) {
    player.sendMessage(`Usage: ::wildboss <${Common.LAIRS.map((entry) => entry.key).join("|")}>`);
    return true;
  }
  const [x, y, z] = lair.entrance.stand;
  player.moveTo(new core.Location(x, y, z));
  return true;
}

function bossHitpoints({ player, parts }) {
  const percent = Number(parts[1]);
  const boss = core.World.getNpcsNear(player.getLocation(), 32)
    .find((npc) => npc.isRegistered() && BOSS_IDS.has(npc.getRealId()));
  if (!boss || !Number.isFinite(percent)) {
    player.sendMessage("Usage: ::wildbosshp <percent>, near a Wilderness boss.");
    return true;
  }
  const name = boss.getCurrentDefinition().getName();
  const wanted = Math.max(1, Math.round(boss.getMaxHitpoints() * percent / 100));
  if (wanted >= boss.getHitpoints()) {
    boss.setHitpoints(wanted);
  } else {
    // A real hit from the player, so the boss's own rules (thresholds, immunity) and the
    // damage record see it.
    const hit = new core.PendingHit(player, boss, core.CombatFactory.getMethod(player), { delay: 0, rollAccuracy: false, experience: false });
    hit.setTotalDamage(boss.getHitpoints() - wanted);
    core.CombatFactory.addPendingHit(hit);
  }
  player.sendMessage(`${name}: ${boss.getHitpoints()} / ${boss.getMaxHitpoints()}, to ${wanted}.`);
  return true;
}

function attach(api) {
  core = api.core;
  BOSS_IDS = new Set([...Common.LAIRS.flatMap((lair) => lair.bossIds), core.NpcIdentifiers.SCORPIA]);
  api.registerCommand("wildboss", toEntrance, api.core.PlayerRights.OWNER, "Go to a Wilderness boss lair's entrance: ::wildboss <boss>");
  api.registerCommand("wildbosshp", bossHitpoints, api.core.PlayerRights.OWNER, "Set the boss of your Wilderness lair to a share of its life: ::wildbosshp <percent>");
}

module.exports = { attach };
