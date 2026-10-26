/**
 * Soul fragments and the Soul Obelisk, as recorded (rsprox 227/00079, 234/03277; soul-wars.json
 * `creatures`, `obelisk`):
 * - Forgotten Souls roam the ruins and drop 2 fragments; wolves roam too (Wiki: they drop bones);
 * - Sacrifice-fragments at the obelisk takes them all: "You charge the Soul Obelisk with soul
 *   fragments and weaken the enemy avatar.", 2% enemy strength each with the team holding it,
 *   0.5% otherwise ("Your soul fragments will have a greater effect if your team controls the Soul
 *   Obelisk."); refused once the enemy avatar is down ("You don't need to do that as the enemy
 *   avatar has been defeated."), fully weakened, or the game over.
 * Calibrated: how many roam at once, their respawn, and where they appear (the recorded tiles).
 */
const Common = require("./Common.SoulWars");
const Match = require("./Match.SoulWars");
const Control = require("./Control.SoulWars");
const Avatars = require("./Avatars.SoulWars");

const CREATURE_OF = new Map();
/** Run after a creature's drop is set (bots pocket theirs). */
const dropHooks = [];

function spawnCreature(game, kind) {
  const creature = Common.data.creatures[kind];
  const tiles = Common.data.spawnTiles[kind];
  for (let tries = 0; tries < 10; tries++) {
    const [x, y] = Common.pick(tiles);
    if (Common.core.RegionManager.blocked(game.area.at([x, y, 0]), game.area)) continue;
    const npc = game.spawn(Common.pick(creature.npcs), [x, y, 0]);
    npc.getMovementCoordinator?.().setRadius?.(4);
    CREATURE_OF.set(npc, { game, kind });
    return npc;
  }
  return null;
}

function started(game) {
  for (const kind of Object.keys(Common.data.creatures)) {
    for (let i = 0; i < Common.data.creatures[kind].count; i++) spawnCreature(game, kind);
  }
}

/**
 * The arena's creatures drop only what Soul Wars gives (a soul's fragments, a wolf's bones):
 * their generated tables name the tutorial's fragment, which is no use here.
 */
function rollDrops(event) {
  const found = CREATURE_OF.get(event.npc);
  if (!found) return;
  const [itemId, amount] = Common.data.creatures[found.kind].drop;
  event.drops.length = 0;
  event.drops.push({ itemId, amount });
  for (const hook of dropHooks) hook(event);
}

/** Another creature of its kind comes in its place. */
function creatureDied(event) {
  const found = CREATURE_OF.get(event.npc);
  if (!found) return;
  Common.later(1, () => CREATURE_OF.delete(event.npc));
  const { game, kind } = found;
  game.npcs.delete(event.npc);
  if (game.over) return;
  Common.later(Common.randomInt(...Common.data.creatureRespawn), () => {
    if (!game.over) spawnCreature(game, kind);
  });
}

function sacrifice({ player }) {
  const game = Match.gameOf(player);
  if (!game) return false;
  if (game.over) {
    player.sendMessage(Common.message("gameEnded"));
    return true;
  }
  if (game.isGhost?.(player)) return true;
  const team = game.teamOf(player);
  const enemy = Common.other(team);
  const avatar = game.avatars[enemy];
  const { fragment } = Common.data.items;
  const count = player.getInventory().getAmount(fragment);
  if (count <= 0) {
    player.sendMessage(Common.message("noFragments"));
    return true;
  }
  if (!avatar.alive) {
    player.sendMessage(Common.message("avatarDown"));
    return true;
  }
  if (avatar.strength <= 0) {
    player.sendMessage(Common.message("avatarWeak"));
    return true;
  }
  const held = Control.holder(game, "obelisk") === team;
  const { held: heldRate, unheld } = Common.data.obelisk;
  player.getInventory().delete(fragment, count);
  Avatars.adjust(game, enemy, -count * (held ? heldRate : unheld));
  game.statsOf(player).fragments += count;
  game.active?.(player);
  player.sendMessage(Common.message("charged"));
  if (!held) player.sendMessage(Common.message("notHeld"));
  return true;
}

function ended(game) {
  for (const [npc, found] of [...CREATURE_OF]) if (found.game === game) CREATURE_OF.delete(npc);
}

function attachSouls(api) {
  Match.onStart(started);
  Match.onEnd(ended);
  api.onNpcDeath(creatureDied);
  api.onCustomEvent("npc-drops:roll", rollDrops);
  api.onObjectInteraction("Soul Obelisk", { "Sacrifice-fragments": sacrifice });
}

module.exports = {
  attachSouls,
  sacrifice,
  creatureDied,
  rollDrops,
  spawnCreature,
  CREATURE_OF,
  onDrops: (hook) => dropHooks.push(hook),
};
