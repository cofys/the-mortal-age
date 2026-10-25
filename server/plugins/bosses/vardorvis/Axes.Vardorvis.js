/**
 * The swinging axes (rsprox 3285):
 * - Large Tendrils rise on as many of the arena's eight edge quadrants as his hitpoints call for
 *   (Wiki: one above 690, two from 231 with a chance of a third, three below; awakened two, three
 *   with a chance of a fourth from 462, four below), facing the centre, and wind up a tick later.
 * - Three ticks after rising they go and each throws its axe: the axe appears two tiles in from
 *   its tendril (a 3x3 spinning axe) and an axe stub plays on the tendril's spot for a tick. The
 *   axe crosses the arena 2, 2, 2 and 1 tiles a tick and is gone the tick after.
 * - Each tick, before it moves, an axe cuts whoever stands under it, once per axe: up to 35 (96
 *   awakened, Wiki), half through Protect from Melee, and the cut starts the player bleeding.
 *   Awakened, the throw also cuts whoever stands on the tendril's own quadrant (no bleed, Wiki).
 * - The bleed (captured): "You have started bleeding!", then 3 (5 awakened) every 5 ticks while
 *   standing still - the first 6 ticks after the cut - and a tick after any step, for 16 ticks.
 *   It keeps going wherever the player goes (Wiki).
 */
const Common = require("./Common.Vardorvis");

const MELEE_PRAYER = "PROTECT_FROM_MELEE";
const DIRECTION_NAMES = {
  "0,1": "NORTH", "1,1": "NORTH_EAST", "1,0": "EAST", "1,-1": "SOUTH_EAST",
  "0,-1": "SOUTH", "-1,-1": "SOUTH_WEST", "-1,0": "WEST", "-1,1": "NORTH_WEST",
};

/** Per player: their bleed, which outlives the fight. */
const bleeds = new WeakMap();

function axeCount(fight) {
  const { count } = Common.data.axes;
  const hp = fight.boss.getHitpoints();
  const rules = count[fight.awakened ? "awakened" : "normal"];
  const [, base, extra] = rules.find(([above]) => hp > above) ?? rules[rules.length - 1];
  return base + (extra && Math.random() < count.extraChance ? 1 : 0);
}

/** The way an anchor's tendril faces and its axe travels: towards the arena's centre. */
function heading([x, y]) {
  const [cx, cy] = Common.data.axes.centre;
  return [Math.sign(cx - (x + 1)), Math.sign(cy - (y + 1))];
}

function throwSet(fight) {
  const { axes, npcs } = Common.data;
  const anchors = Common.shuffle([...axes.anchors]).slice(0, axeCount(fight));
  const { session } = fight;
  Common.sound(fight.player, axes.sound);
  const tendrils = anchors.map((anchor) => {
    const [dx, dy] = heading(anchor);
    const tendril = session.spawn(npcs.largeTendril, [anchor[0], anchor[1], 0], DIRECTION_NAMES[`${dx},${dy}`]);
    tendril?.performAnimation(new Common.core.Animation(axes.tendrilAnim));
    return { anchor, tendril };
  });
  fight.tendrils = tendrils;
  fight.at(axes.windupTicks, () => {
    for (const { tendril } of tendrils) if (tendril?.isRegistered()) tendril.performAnimation(new Common.core.Animation(axes.windupAnim));
  });
  fight.at(axes.throwTicks, () => {
    for (const { tendril } of tendrils) if (tendril?.isRegistered()) Common.api.removeNpc(tendril);
    fight.tendrils = null;
    if (!fight.alive()) return;
    for (const { anchor } of tendrils) launch(fight, anchor);
  });
}

function launch(fight, anchor) {
  const { axes, npcs } = Common.data;
  const { session } = fight;
  const [dx, dy] = heading(anchor);
  const face = DIRECTION_NAMES[`${dx},${dy}`];
  const start = [anchor[0] + dx * axes.inset, anchor[1] + dy * axes.inset];
  const axe = session.spawn(npcs.axe, [start[0], start[1], 0], face);
  if (!axe) return;
  axe.setScriptedMovement?.(true);
  axe.performAnimation(new Common.core.Animation(axes.spinAnim));
  const stub = session.spawn(npcs.axeStatic, [anchor[0], anchor[1], 0], "SOUTH");
  stub?.performAnimation(new Common.core.Animation(axes.staticAnim));
  fight.at(1, () => stub?.isRegistered() && Common.api.removeNpc(stub));
  if (fight.awakened) cutPlayer(fight, { at: anchor, struck: new Set() }, false);
  fight.axes.push({ npc: axe, at: start, dx, dy, step: 0, struck: new Set() });
}

function covers([x, y], player, session) {
  const size = Common.data.axes.size;
  const [px, py] = Common.siteTile(session.area, player.getLocation());
  return px >= x && px < x + size && py >= y && py < y + size;
}

function cutPlayer(fight, axe, bleed) {
  const { player, session } = fight;
  if (axe.struck.has(player) || player.getHitpoints() <= 0 || !covers(axe.at, player, session)) return;
  axe.struck.add(player);
  const { maxHit } = Common.data.axes;
  Common.strike(fight.boss, player, "melee", maxHit[fight.awakened ? "awakened" : "normal"], 0, {
    prayer: MELEE_PRAYER, prayerShare: Common.data.axes.prayerShare, accurate: true,
    onApplied: (amount) => fight.recordDamage(amount),
  });
  if (bleed) startBleed(player, fight.awakened, fight);
}

/** Each tick: every axe cuts under it, then moves on (or goes, after its last step). */
function process(fight) {
  if (fight.axes.length === 0) return;
  const { steps } = Common.data.axes;
  for (const axe of [...fight.axes]) {
    if (!axe.npc.isRegistered()) {
      fight.axes.splice(fight.axes.indexOf(axe), 1);
      continue;
    }
    if (!fight.over) cutPlayer(fight, axe, true);
    if (axe.step >= steps.length) {
      Common.api.removeNpc(axe.npc);
      fight.axes.splice(fight.axes.indexOf(axe), 1);
      continue;
    }
    const length = steps[axe.step++];
    axe.at = [axe.at[0] + axe.dx * length, axe.at[1] + axe.dy * length];
    axe.npc.exactMove(fight.session.tile([axe.at[0], axe.at[1], 0]));
    axe.npc.performAnimation(new Common.core.Animation(Common.data.axes.spinAnim));
  }
}

function clear(fight) {
  for (const { tendril } of fight.tendrils ?? []) if (tendril?.isRegistered()) Common.api.removeNpc(tendril);
  fight.tendrils = null;
  for (const axe of fight.axes) if (axe.npc.isRegistered()) Common.api.removeNpc(axe.npc);
  fight.axes = [];
}

// ------------------------------------------------------------------ the bleed

function startBleed(player, awakened, fight) {
  const { bleed } = Common.data.axes;
  const existing = bleeds.get(player);
  if (existing) {
    existing.left = bleed.durationTicks;
    existing.fight = fight;
    return;
  }
  player.sendMessage(bleed.message);
  for (const id of bleed.sounds) Common.sound(player, id);
  const state = {
    fight,
    damage: bleed.damage[awakened ? "awakened" : "normal"],
    left: bleed.durationTicks,
    next: bleed.firstTicks,
    since: 0,
    last: player.getLocation().clone(),
  };
  bleeds.set(player, state);
  const { Task, TaskManager } = Common.core;
  TaskManager.submit(new (class extends Task {
    constructor() {
      super(1, null, false);
    }
    execute() {
      if (!player.isRegistered() || player.getHitpoints() <= 0 || state.left <= 0) {
        bleeds.delete(player);
        this.stop();
        return;
      }
      state.left--;
      state.since++;
      state.next--;
      const moved = !player.getLocation().equals(state.last);
      state.last = player.getLocation().clone();
      if (state.next <= 0 || (moved && state.since > 1)) {
        const owner = state.fight;
        Common.damage(player, state.damage, bleed.splat, (amount) => owner?.recordDamage(amount));
        state.since = 0;
        state.next = bleed.intervalTicks;
      }
    }
  })());
}

module.exports = { throwSet, process, clear, startBleed };
