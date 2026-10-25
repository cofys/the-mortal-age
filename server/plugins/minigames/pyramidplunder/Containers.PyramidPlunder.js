"use strict";

/**
 * The room containers: urns, the Grand Gold Chest and the sarcophagus.
 *
 * - **Urns** (ntk_urn_type*_multi_1..15; per-player varbit ntk_urnN_state: 0 closed,
 *   1 searched, 2 snake showing, 3 snake charmed). Search may be bitten (1-4 damage and
 *   poison); Check for Snakes shows the snake; a snake charm makes the search safe. A full
 *   search gives the room's urn XP; checking first splits it (1/3 then 2/3), and a charmed
 *   search pays 2/3 of that again (the Wiki: "only about 2/3rds").
 * - **Grand Gold Chest** (ntk_golden_chest_multi; ntk_golden_chest_state): always opens. A
 *   scarab swarm may come out instead of the XP (3 damage, then the swarm attacks); the
 *   artefact and the sceptre roll happen either way.
 * - **Sarcophagus** (ntk_sarcophagus_multi; ntk_sarcophagus_state: 0 closed, 1 open,
 *   2 opening): a Strength roll every few ticks until the lid moves. Strength XP, an artefact,
 *   the sceptre roll and a (room/9) chance of a mummy that attacks only the opener.
 *
 * Each container opens once per room visit, guarded on the server as well as by its varbit,
 * so a repeated click or a reconnect can't loot it again. A search takes a few ticks, and a
 * click while the last one is still going is ignored. When the sceptre turns up, the run ends
 * first, so the artefact found with it lands outside rather than on the tomb floor.
 *
 * Wiki: https://oldschool.runescape.wiki/w/Urn_(Pyramid_Plunder),
 * https://oldschool.runescape.wiki/w/Grand_Gold_Chest,
 * https://oldschool.runescape.wiki/w/Sarcophagus_(Pyramid_Plunder)
 */

const Common = require("./Common.PyramidPlunder");

const URN = { CLOSED: 0, SEARCHED: 1, SNAKE: 2, CHARMED: 3 };
const SARCOPHAGUS = { CLOSED: 0, OPEN: 1, OPENING: 2 };
/** Ticks between sarcophagus pushes, and the most a single Open keeps pushing. */
const PUSH_TICKS = 3;
const MAX_PUSHES = 20;
const SWARM_DAMAGE = 3;
/** Ticks an urn search, a snake check or a chest search takes. */
const SEARCH_TICKS = 3;
const MUMMY_CHANCE_DIVISOR = 9;

/** The run and room this object belongs to, or null (and a message) when it isn't this run's. */
function runFor(event) {
  const run = Common.sessionOf(event.player);
  if (!run) return null;
  const at = event.location;
  if (Common.roomAt(at.x, at.y, at.z) !== run.room) return null;
  return run;
}

function animate(player, animation) {
  player.performAnimation(new (Common.getCore().Animation)(animation));
}

function bite(player, random) {
  const { CombatFactory } = Common.getCore();
  animate(player, Common.ids().anim.urnBitten);
  player.sendMessage(Common.MESSAGES.bitten);
  Common.hit(player, Common.rollHit(random));
  player.sendMessage(Common.MESSAGES.urnPoisoned);
  CombatFactory.poisonEntity(player, Common.rollHit(random));
}

// --- Urns

function urnVarbit(objectId) {
  return Common.ids().urns.get(objectId);
}

/** Search: closed (bite risk), with a snake showing (worse), or charmed (safe). */
function searchUrn(event, random = Math.random) {
  const varbit = urnVarbit(event.objectId);
  if (varbit === undefined) return false;
  const run = runFor(event);
  if (!run) return true;
  const player = event.player;
  const stage = Common.varbitOf(player, varbit);
  if (stage === URN.SEARCHED || run.cleared.has(`urn:${varbit}`)) {
    player.sendMessage(Common.MESSAGES.looted);
    return true;
  }
  if (!Common.takeAction(run, SEARCH_TICKS)) return true;
  const room = Common.roomData(run.room);
  const level = Common.thievingLevel(player);
  const chance = stage === URN.CHARMED ? 1
    : stage === URN.SNAKE ? Common.chanceOf("searchPastSnake", level, run.room)
      : Common.chanceOf("urnSearch", level, run.room);
  animate(player, Common.ids().anim.urnSearch);
  if (!Common.roll(chance, random)) {
    bite(player, random);
    return true;
  }
  if (!Common.claim(run, `urn:${varbit}`)) return true;
  const xp = stage === URN.CLOSED ? room.urnXp
    : stage === URN.SNAKE ? (room.urnXp * 2) / 3
      : (room.urnXp * 4) / 9;
  Common.send(player, varbit, URN.SEARCHED);
  animate(player, Common.ids().anim.urnSuccess);
  player.sendMessage(Common.MESSAGES.urnLooted);
  Common.addXp(player, "THIEVING", xp);
  Common.giveArtefact(player, Common.rollUrnArtefact(run.room, random));
  return true;
}

/** Check for Snakes: shows the snake (a third of the urn's XP), or bites on a failed check. */
function checkUrn(event, random = Math.random) {
  const varbit = urnVarbit(event.objectId);
  if (varbit === undefined) return false;
  const run = runFor(event);
  if (!run) return true;
  const player = event.player;
  if (Common.varbitOf(player, varbit) !== URN.CLOSED) return true;
  if (!Common.takeAction(run, SEARCH_TICKS)) return true;
  if (!Common.roll(Common.chanceOf("checkForSnakes", Common.thievingLevel(player), run.room), random)) {
    bite(player, random);
    return true;
  }
  Common.send(player, varbit, URN.SNAKE);
  player.sendMessage(Common.MESSAGES.snake);
  Common.addXp(player, "THIEVING", Common.roomData(run.room).urnXp / 3);
  return true;
}

/** Charm Snake: always works with a snake charm (snake_flute) in the pack. */
function charmUrn(event) {
  const varbit = urnVarbit(event.objectId);
  if (varbit === undefined) return false;
  const run = runFor(event);
  if (!run) return true;
  const player = event.player;
  if (Common.varbitOf(player, varbit) !== URN.SNAKE) return true;
  if (player.getInventory().getAmount(Common.ids().item.snakeCharm) <= 0) {
    player.sendMessage(Common.MESSAGES.noCharm);
    return true;
  }
  animate(player, Common.ids().anim.charm);
  Common.send(player, varbit, URN.CHARMED);
  player.sendMessage(Common.MESSAGES.charmed);
  return true;
}

// --- The Grand Gold Chest

function searchChest(event, random = Math.random) {
  if (event.objectId !== Common.ids().chest) return false;
  const run = runFor(event);
  if (!run) return true;
  const player = event.player;
  const v = Common.ids().varbit;
  if (Common.varbitOf(player, v.chest) !== 0 || run.cleared.has("chest")) {
    player.sendMessage(Common.MESSAGES.looted);
    return true;
  }
  if (!Common.takeAction(run, SEARCH_TICKS) || !Common.claim(run, "chest")) return true;
  animate(player, Common.ids().anim.chest);
  Common.sound(player, Common.ids().sound.chest);
  Common.send(player, v.chest, 1);
  const room = Common.roomData(run.room);
  const swarm = !Common.roll(Common.chanceOf("chestNoSwarm", Common.thievingLevel(player), run.room), random);
  if (swarm) {
    player.sendMessage(Common.MESSAGES.swarm);
    Common.hit(player, SWARM_DAMAGE);
    spawnHostile(player, Common.ids().npc.scarabs);
  } else {
    Common.addXp(player, "THIEVING", room.chestXp);
  }
  loot(player, run, Common.rollChestArtefact(run.room, random), random);
  return true;
}

/** The sceptre roll comes first: finding it ends the run, then the artefact follows outside. */
function loot(player, run, artefact, random) {
  if (Common.rollSceptre(run.room, random)) Common.awardSceptre(player);
  Common.giveArtefact(player, artefact);
}

// --- The sarcophagus

function openSarcophagus(event, random = Math.random) {
  if (event.objectId !== Common.ids().sarcophagus) return false;
  const run = runFor(event);
  if (!run) return true;
  const player = event.player;
  const v = Common.ids().varbit;
  const stage = Common.varbitOf(player, v.sarcophagus);
  if (stage === SARCOPHAGUS.OPEN || run.cleared.has("sarcophagus")) {
    player.sendMessage(Common.MESSAGES.looted);
    return true;
  }
  if (stage === SARCOPHAGUS.OPENING) return true;
  if (Common.sarcophagusChance(Common.strengthLevel(player), run.room) <= 0) {
    player.sendMessage(Common.MESSAGES.sarcophagusWeak);
    return true;
  }
  Common.send(player, v.sarcophagus, SARCOPHAGUS.OPENING);
  const at = player.getLocation();
  push(player, run, { x: at.getX(), y: at.getY() }, 0, random);
  return true;
}

/** The open lid's Search: it's been looted. */
function searchOpenSarcophagus(event) {
  if (event.objectId !== Common.ids().sarcophagus) return false;
  event.player.sendMessage(Common.MESSAGES.looted);
  return true;
}

/** One push; keeps going until the lid moves, the player walks off or the run ends. */
function push(player, run, tile, attempt, random) {
  const v = Common.ids().varbit;
  if (Common.sessionOf(player) !== run) return;
  const at = player.getLocation();
  if (at.getX() !== tile.x || at.getY() !== tile.y) {
    Common.send(player, v.sarcophagus, SARCOPHAGUS.CLOSED);
    return;
  }
  animate(player, Common.ids().anim.push);
  if (Common.roll(Common.sarcophagusChance(Common.strengthLevel(player), run.room), random)) {
    lidOff(player, run, random);
    return;
  }
  if (attempt + 1 >= MAX_PUSHES) {
    Common.send(player, v.sarcophagus, SARCOPHAGUS.CLOSED);
    return;
  }
  Common.later(PUSH_TICKS, () => {
    if (Common.varbitOf(player, v.sarcophagus) !== SARCOPHAGUS.OPENING) return;
    push(player, run, tile, attempt + 1, random);
  });
}

function lidOff(player, run, random) {
  const v = Common.ids().varbit;
  if (!Common.claim(run, "sarcophagus")) return;
  Common.send(player, v.sarcophagus, SARCOPHAGUS.OPEN);
  animate(player, Common.ids().anim.lidOff);
  player.sendMessage(Common.MESSAGES.sarcophagusOpen);
  Common.addXp(player, "STRENGTH", Common.roomData(run.room).sarcophagusXp);
  const artefact = Common.rollSarcophagusArtefact(run.room, random);
  if (Common.roll(run.room / MUMMY_CHANCE_DIVISOR, random)) {
    player.sendMessage(Common.MESSAGES.mummy);
    spawnHostile(player, Common.ids().npc.mummy);
  }
  loot(player, run, artefact, random);
}

/** A swarm or mummy beside the player, attacking only them; it goes when the run ends. */
function spawnHostile(player, npcId) {
  const api = Common.getApi();
  const at = player.getLocation();
  const npc = api.spawnNpc({ id: npcId, x: at.getX(), y: at.getY(), z: at.getZ(), owner: player, ownerOnly: true, wanderRadius: 0 });
  if (!npc) return null;
  npc.getCombat?.().attack(player);
  const run = Common.sessionOf(player);
  if (run) (run.hostiles ??= []).push(npc);
  return npc;
}

module.exports = function registerContainers(api) {
  Common.bind(api);
  api.onObjectInteraction("Urn", { Search: searchUrn, "Check for Snakes": checkUrn, "Charm Snake": charmUrn });
  api.onObjectInteraction("Grand Gold Chest", { Search: searchChest });
  api.onObjectInteraction("Sarcophagus", { Open: openSarcophagus, Search: searchOpenSarcophagus });
};

module.exports._test = { URN, SARCOPHAGUS, SEARCH_TICKS, searchUrn, searchOpenSarcophagus, checkUrn, charmUrn, searchChest, openSarcophagus, spawnHostile };
