/**
 * Deaths, graveyards and barriers, as recorded (rsprox 227/00079, 234/03277; soul-wars.json
 * `graveyards`):
 * - a death keeps everything; the player comes back in the graveyard their team holds (else their
 *   base: inferred) as a ghost for 17 ticks (varbit soul_wars_recent_death, and the look of
 *   soul_wars_player_ghost: the appearance is re-sent at both ends, 234/03277 [2149]-[2166]); their bones fall
 *   where they died, with every bone and fragment they carried (Wiki);
 * - a sanctuary's barriers let the living out only: "You can only exit this sanctuary, not enter
 *   it.", "You must wait for another N second(s) before you rejoin the battle."; on the way out a
 *   short immunity (the soul_wars_immune graphic);
 * - a base barrier lets its own team through either way (unrecorded for the other team: refused);
 * - teammates can't fight: "You can't attack your teammates!".
 */
const Common = require("./Common.SoulWars");
const Match = require("./Match.SoulWars");
const Control = require("./Control.SoulWars");

/** Each player's ghost and immunity ends, in game ticks. */
const ghosts = new Map();
const immune = new Map();
/** Players whose death began in a game: it ends there too, even if the game ends meanwhile. */
const dying = new Map();
const NORMAL_BONES = 526;
const GHOST_NPC = "soul_wars_player_ghost";

function ghostLook(player, on) {
  player.setNpcTransformationId?.(on ? Common.core.CacheDefinitions.getNpcId(GHOST_NPC) : -1);
}

function started(game) {
  game.isGhost = (player) => (ghosts.get(player) ?? 0) > game.elapsed;
  game.isImmune = (player) => (immune.get(player) ?? 0) > game.elapsed;
}

function respawnTile(game, team) {
  for (const place of ["east", "west"]) {
    if (Control.holder(game, place) === team) {
      const [x, y] = Common.pick(Common.data.graveyards[place].respawn);
      return [x, y, 0];
    }
  }
  return Common.data.bases[team];
}

function dropOnDeath(game, player, where) {
  const { bones, fragment } = Common.data.items;
  const inventory = player.getInventory();
  const carried = { [bones]: inventory.getAmount(bones), [fragment]: inventory.getAmount(fragment) };
  // Anyone may take them at once (the enemy's bones are the point).
  const drop = (id, amount) => {
    if (amount > 0) Common.core.ItemOnGroundManager.registerGlobal(player, new Common.core.Item(id, amount));
  };
  for (const id of [bones, fragment]) if (carried[id] > 0) inventory.delete(id, carried[id]);
  drop(bones, carried[bones] + 1);
  drop(fragment, carried[fragment]);
}

function dyingStarts(event) {
  const game = Match.gameOf(event.player);
  if (game) dying.set(event.player, game);
}

/** The core drops ordinary bones at every death; the arena's own are Soul Wars bones. */
function takeNormalBones(player, killer, where) {
  const { ItemOnGroundManager } = Common.core;
  for (const owner of [killer?.getUsername?.(), player.getUsername(), null]) {
    const bones = ItemOnGroundManager.getGroundItem?.(owner, NORMAL_BONES, where, player.getPrivateArea?.() ?? null);
    if (bones) {
      ItemOnGroundManager.deregister(bones);
      return;
    }
  }
}

/** Recorded: the death never leaves the arena; the player wakes a ghost in a graveyard. */
function died(event) {
  const player = event.player;
  const began = dying.get(player);
  dying.delete(player);
  const game = Match.gameOf(player) ?? (began?.over ? began : null);
  if (!game) return;
  event.handled = true;
  if (game.over) {
    // The game ended while they were dying: they're already out, with everything.
    player.moveTo(Common.toLocation(Common.data.lobby.afterGame));
    return;
  }
  takeNormalBones(player, event.killer?.getAsPlayer?.() ?? event.killer, player.getLocation());
  const team = game.teamOf(player);
  const where = player.getLocation().clone();
  dropOnDeath(game, player, where);
  Common.addVarp(player, "total_deaths", 1);
  const killer = event.killer?.getAsPlayer?.() ?? event.killer;
  if (killer?.isPlayer?.() && game.teamOf(killer) && game.teamOf(killer) !== team) {
    game.statsOf(killer).kills++;
    Common.addVarp(killer, "total_kills", 1);
    game.active?.(killer);
  }
  player.moveTo(game.area.at(respawnTile(game, team)));
  ghosts.set(player, game.elapsed + Common.data.ghostTicks);
  Common.varbit(player, "soul_wars_recent_death", 1);
  ghostLook(player, true);
  Common.later(Common.data.ghostTicks, () => {
    Common.varbit(player, "soul_wars_recent_death", 0);
    ghostLook(player, false);
  });
}

function keepItems(event) {
  if (Match.gameOf(event.player) || dying.has(event.player)) event.shouldDrop = false;
}

/** Barriers: base ones let their team through, sanctuary ones the living out. */
function pass({ player, object }) {
  const game = Match.gameOf(player);
  if (!game || !object) return false;
  const team = game.teamOf(player);
  const [bx, by] = game.area.templateOf(object.getLocation());
  const here = game.area.templateOf(player.getLocation());
  const across = [2 * bx - here[0], 2 * by - here[1], 0];
  const sanctuary = Object.values(Common.data.graveyards).find((yard) => yard.barrierTiles.some(([x, y]) => x === bx && y === by));
  if (sanctuary) {
    const inside = sanctuary.respawn.some(([x, y]) => x === here[0] && y === here[1]);
    if (!inside) {
      player.sendMessage(Common.message("exitOnly"));
      return true;
    }
    if (game.isGhost(player)) {
      const seconds = Math.max(1, Math.ceil(((ghosts.get(player) - game.elapsed) * 0.6)));
      player.sendMessage(Common.message("ghostWait", { seconds, s: seconds === 1 ? "" : "s" }));
      return true;
    }
    player.moveTo(game.area.at(across));
    immune.set(player, game.elapsed + Common.data.immuneTicks);
    player.performGraphic?.(new Common.core.Graphic(0));
    return true;
  }
  const name = Common.core.CacheDefinitions.getObject(object.getId())?.name ?? "";
  if (!name.toLowerCase().startsWith(team)) {
    player.sendMessage(Common.message("enemyBarrier"));
    return true;
  }
  player.moveTo(game.area.at(across));
  return true;
}

/** Teammates don't fight; ghosts and the newly risen can't be hit, or hit back. */
function attackRule(game, attacker, target) {
  const a = attacker?.isPlayer?.() ? attacker.getAsPlayer?.() ?? attacker : null;
  const t = target?.isPlayer?.() ? target.getAsPlayer?.() ?? target : null;
  if (a && game.isGhost?.(a)) return false;
  if (t && (game.isGhost?.(t) || game.isImmune?.(t))) return false;
  if (a && t) {
    if (game.teamOf(a) && game.teamOf(a) === game.teamOf(t)) {
      a.sendMessage(Common.message("teammates"));
      return false;
    }
    return Boolean(game.teamOf(a) && game.teamOf(t));
  }
  return null;
}

function ended() {
  for (const player of ghosts.keys()) ghostLook(player, false);
  ghosts.clear();
  immune.clear();
}

function attachDeath(api) {
  Match.onStart(started);
  Match.onEnd(ended);
  Match.onAttackRule(attackRule);
  api.onPlayerBeforeDeath(dyingStarts);
  api.onPlayerDeath(died);
  api.onShouldDropItemsOnDeath(keepItems);
  for (const name of ["Blue Barrier", "Red Barrier", "Neutral Barrier"]) api.onObjectInteraction(name, { Pass: pass });
}

module.exports = { attachDeath, died, pass, respawnTile, attackRule };
