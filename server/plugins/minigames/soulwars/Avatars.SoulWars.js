/**
 * The avatars, as recorded (rsprox 227/00079, 234/03277; soul-wars.json `avatars`):
 * - the Avatar of Creation (blue) and of Destruction (red) stand in their bases; strength, from
 *   100%, is the share of damage they block: at 100% every hit is nothing ("Your attacks seem to
 *   have no effect on the avatar.", about every 18 ticks while attacking);
 * - "You can't attack your teammates!" at one's own;
 * - defeated: "The red team has defeated the Avatar of Creation!", a kill to that team; it returns
 *   35 ticks later at full health and strength ("The Avatar of Creation has returned!").
 * Wiki: 1,500 HP; each attacks only the other team.
 */
const Common = require("./Common.SoulWars");
const Match = require("./Match.SoulWars");

const AVATAR_OF = new Map();

function spawnAvatar(game, team) {
  const { avatars, avatarHp } = Common.data;
  const npc = game.spawn(avatars[team].npc, avatars[team].tile);
  npc.setMaxHitpoints?.(avatarHp);
  npc.setHitpoints?.(avatarHp);
  npc.getMovementCoordinator?.().setRadius?.(0);
  const avatar = game.avatars[team];
  avatar.npc = npc;
  avatar.alive = true;
  avatar.strength = 100;
  AVATAR_OF.set(npc, { game, team });
  for (const player of game.players()) Common.varbit(player, `soul_wars_${team}_avatar_check`, 1);
  return npc;
}

function started(game) {
  game.avatars = { blue: { strength: 100, alive: false }, red: { strength: 100, alive: false } };
  game.lastNoEffect = new Map();
  for (const team of Common.TEAMS) spawnAvatar(game, team);
}

/** Strength blocks that share of each hit; 100% blocks all, with the recorded line. */
function blockDamage({ npc, hit }) {
  const found = AVATAR_OF.get(npc);
  if (!found) return;
  const { game, team } = found;
  const avatar = game.avatars[team];
  const attacker = hit.getAttacker?.()?.getAsPlayer?.() ?? hit.getAttacker?.();
  const left = 1 - avatar.strength / 100;
  for (const part of hit.getHits?.() ?? []) part.setDamage(Math.floor(part.getDamage() * left));
  hit.updateTotalDamage?.();
  const dealt = Math.min(hit.getTotalDamage?.() ?? 0, npc.getHitpoints?.() ?? 0);
  if (attacker?.isPlayer?.() && game.teamOf(attacker)) {
    if (left <= 0) noEffect(game, attacker);
    else game.statsOf(attacker).damage += dealt;
  }
}

function noEffect(game, player) {
  const last = game.lastNoEffect.get(player) ?? -Infinity;
  if (game.elapsed - last < Common.data.noEffectEvery) return;
  game.lastNoEffect.set(player, game.elapsed);
  player.sendMessage(Common.message("noEffect"));
}

function avatarDied({ npc }) {
  const found = AVATAR_OF.get(npc);
  if (!found) return;
  AVATAR_OF.delete(npc);
  const { game, team } = found;
  if (game.over) return;
  const scorer = Common.other(team);
  const avatar = game.avatars[team];
  avatar.alive = false;
  game.npcs.delete(npc);
  const line = Common.message("defeated", { colour: Common.COLOURS[scorer], team: scorer, avatar: Common.data.avatars[team].name });
  for (const player of game.players()) {
    player.sendMessage(line);
    Common.varbit(player, `soul_wars_${team}_avatar_check`, 0);
  }
  game.scored(scorer);
  Common.later(Common.data.returnTicks, () => {
    if (game.over) return;
    spawnAvatar(game, team);
    const back = Common.message("returned", { colour: Common.COLOURS[team], avatar: Common.data.avatars[team].name });
    for (const player of game.players()) player.sendMessage(back);
  });
}

/** Players fight only the other team and its avatar; each avatar fights only the other team. */
function attackRule(game, attacker, target) {
  const player = attacker?.isPlayer?.() ? attacker.getAsPlayer?.() ?? attacker : null;
  const avatarTarget = AVATAR_OF.get(target);
  if (player && avatarTarget) {
    if (avatarTarget.team === game.teamOf(player)) {
      player.sendMessage(Common.message("teammates"));
      return false;
    }
    return true;
  }
  const avatarAttacker = AVATAR_OF.get(attacker);
  if (avatarAttacker && target?.isPlayer?.()) return game.teamOf(target.getAsPlayer?.() ?? target) !== avatarAttacker.team;
  return null;
}

function aggressionRule(game, player, npc) {
  const avatar = AVATAR_OF.get(npc);
  if (!avatar) return null;
  return game.teamOf(player) !== avatar.team;
}

/** The enemy avatar's strength falls (the obelisk) or one's own rises (bones), within 0-100. */
function adjust(game, team, change) {
  const avatar = game.avatars[team];
  avatar.strength = Math.max(0, Math.min(100, avatar.strength + change));
  return avatar.strength;
}

function ended(game) {
  for (const [npc, found] of [...AVATAR_OF]) if (found.game === game) AVATAR_OF.delete(npc);
}

function attachAvatars(api) {
  Match.onStart(started);
  Match.onEnd(ended);
  Match.onAttackRule(attackRule);
  Match.onAggressionRule(aggressionRule);
  api.onNpcHitModify(blockDamage);
  api.onNpcDeath(avatarDied);
}

module.exports = { attachAvatars, adjust, blockDamage, avatarDied, AVATAR_OF };
