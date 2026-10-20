/**
 * The Curse of the Moon (docs/moons-of-peril.md): stacks in pmoon_boss_condition, gained from the
 * Moon's hits, its specials and standing off the glyph, and wearing off by 2 every 5 ticks (Wiki).
 * - Blue Moon's cold: warnings at 3 and 9; at 18 the player's next attack is cancelled ("Your
 *   joints lock up...") and 16 stacks go (capture: always 18 -> 2).
 * - Eclipse Moon's blinding: a chance of a glancing attack (max hit -12, -8 during Clones) that
 *   reaches certainty at 100 stacks (Wiki).
 * The Blood Moon's curse is its thirst, which heals it (Attacks.MoonsOfPeril), not a stack.
 */
const Common = require("./Common.MoonsOfPeril");

const CURSE = { blue: "cold", eclipse: "blind" };

function curseOf(fight) {
  return CURSE[fight.moon] ?? null;
}

function set(fight, value) {
  const { max } = Common.data.curses;
  fight.condition = Math.max(0, Math.min(max, Math.floor(value)));
  Common.varbit(fight.player, "condition", fight.condition);
}

/** More stacks, with the cold's warnings when a threshold is crossed. */
function add(fight, amount) {
  if (!curseOf(fight) || amount <= 0 || fight.killed) return;
  const before = fight.condition;
  set(fight, before + amount);
  if (curseOf(fight) !== "cold") return;
  const crossed = Common.data.curses.cold.warnings.filter(({ at }) => before < at && fight.condition >= at).pop();
  if (crossed) fight.player.sendMessage(crossed.message);
}

/** Some stacks go (the braziers, Searing Rays' end). */
function remove(fight, amount) {
  if (fight.condition <= 0) return;
  set(fight, fight.condition - amount);
}

function clear(fight) {
  if (fight.condition !== 0) set(fight, 0);
}

/** 2 every 5 ticks (Wiki), as the captures' condition shows it falling. */
function decay(fight) {
  if (fight.condition <= 0) {
    fight.decayTicks = 0;
    return;
  }
  const { decayTicks, decayAmount } = Common.data.curses;
  if (++fight.decayTicks < decayTicks) return;
  fight.decayTicks = 0;
  remove(fight, decayAmount);
}

/**
 * The player's hit on the Moon as it lands: the cold may cancel it outright, blinding may make
 * it glance. Returns the damage to apply.
 */
function onPlayerHit(fight, hit) {
  const curse = curseOf(fight);
  if (curse === "cold" && fight.condition >= Common.data.curses.cold.lockAt) {
    const { lockMessage, lockRemoves, lockSpot } = Common.data.curses.cold;
    fight.player.sendMessage(lockMessage);
    fight.player.performGraphic(Common.graphic(lockSpot.id, { height: lockSpot.height }));
    remove(fight, lockRemoves);
    zero(hit);
    return 0;
  }
  if (curse === "blind" && fight.condition > 0) {
    const { glanceMaxHit, fullAt } = Common.data.curses.blind;
    if (Math.random() < Math.min(1, fight.condition / fullAt)) {
      const less = fight.state.clones ? glanceMaxHit * 2 / 3 : glanceMaxHit;
      for (const part of hit.getHits()) part.setDamage(Math.max(0, part.getDamage() - Math.floor(less)));
      hit.updateTotalDamage();
    }
  }
  return hit.getTotalDamage();
}

function zero(hit) {
  for (const part of hit.getHits()) part.setDamage(0);
  hit.updateTotalDamage();
}

module.exports = { add, remove, clear, decay, onPlayerHit, curseOf, set };
