/**
 * Tai Bwo Wannai Cleanup: hacking the light, medium and dense jungle (Hack) with a wielded machete.
 * The Wiki gives the Woodcutting levels (10, 20, 35), the XP (32, 55, 80; 1 for a miss) and the
 * favour (0.3%, 0.5%, 1%). rsprox 227/01858 gives the swing: the machete's hack animation every
 * tick, tbw_chippings on the jungle every 2 ticks, the result on the 6th, then 3 ticks before the
 * next swing (9 a hack). Every tick before the result may instead disturb something (Events),
 * which ends the hack. A success takes the jungle one stage down in place and gives its spar;
 * the favour follows 3 ticks later. Stage 5 has no Hack; the jungle grows back (Locs).
 *
 * The success chance is ours: the recordings (red topaz machete, Woodcutting 88 and 72) only bound
 * it, so each jungle has a low/high chance out of 256 interpolated over Woodcutting 1-99 (fitted
 * to them), scaled down for the lesser machetes, which the Wiki says cut slower.
 */
const Common = require("./Common.TaiBwoWannaiCleanup");
const Favour = require("./Favour.TaiBwoWannaiCleanup");
const Locs = require("./Locs.TaiBwoWannaiCleanup");
const Events = require("./Events.TaiBwoWannaiCleanup");

/** By player: { jungle, location, machete, tick }. */
const sessions = new Map();

/** The jungle entry and stage (0-4) of a loc id, or null. */
function jungleOf(id) {
  for (const jungle of Common.data.jungle) {
    const stage = jungle.locs.findIndex((name) => Common.locId(name) === id);
    if (stage >= 0) return { jungle, stage };
  }
  return null;
}

/** OSRS's usual interpolation: low at level 1 to high at 99, out of 256. */
function successChance(jungle, level, machete) {
  const lerp = (jungle.low * (99 - level) + jungle.high * (level - 1)) / 98;
  return Math.max(0, Math.min(1, (lerp / 256) * machete.chance));
}

function stop(player) {
  if (!sessions.delete(player)) return;
  player.performAnimation(Common.core.Animation.DEFAULT_RESET_ANIMATION);
}

function hack(event) {
  const { player, object } = event;
  const found = jungleOf(object.getId());
  if (!found || found.stage >= 4) return false;
  event.handled = true;
  const { jungle } = found;
  if (!Common.questComplete(player) || Common.progress(player) < Common.data.progress.told) {
    Common.statement(player, Common.message("notTold"));
    return true;
  }
  const machete = Common.wieldedMachete(player);
  if (!machete) {
    player.sendMessage(Common.message("noMachete"));
    return true;
  }
  if (Common.level(player, "WOODCUTTING") < jungle.level) {
    player.sendMessage(Common.message("level", { level: jungle.level }));
    return true;
  }
  if (player.getInventory().getFreeSlots() <= 0) {
    player.sendMessage(Common.message("fullInventory"));
    return true;
  }
  Common.stopActions(player);
  sessions.set(player, { jungle, location: object.getLocation().clone(), machete, tick: 0 });
  return true;
}

function result(player, session, current) {
  const { jungle } = session;
  Events.counted(player);
  const found = jungleOf(current.getId());
  if (Math.random() >= successChance(jungle, Common.level(player, "WOODCUTTING"), session.machete)) {
    Common.animate(player, "fail", 30);
    Common.sound(player, Common.data.sounds.fail);
    Common.xp(player, "WOODCUTTING", Common.data.failXp);
    return;
  }
  // The bag may have filled during the swing (a pickup): no room, no cut, nothing lost.
  const spar = new Common.core.Item(Common.objId(jungle.spar), 1);
  if (player.getInventory().getAddableAmount(spar) < 1) {
    stop(player);
    player.sendMessage(Common.message("fullInventory"));
    return;
  }
  Common.animate(player, "success", 30);
  for (const id of Common.data.sounds.success) Common.sound(player, id);
  player.getInventory().add(spar);
  Locs.swap(current, Common.locId(jungle.locs[found.stage + 1]), Common.data.hack.regrowTicks, Common.locId(jungle.locs[0]));
  Common.xp(player, "WOODCUTTING", jungle.xp);
  Common.advance(player, Common.data.progress.hacked);
  Favour.gain(player, jungle.points, Common.data.hack.favourDelay);
  if (found.stage + 1 >= 4) {
    stop(player);
    Common.later(player, Common.data.hack.pause, () => player.sendMessage(Common.message("cutBack")));
  } else if (player.getInventory().getFreeSlots() <= 0) {
    stop(player);
    Common.later(player, Common.data.hack.pause, () => player.sendMessage(Common.message("fullInventory")));
  }
}

/** One tick of a player's swing: 0 swings, chips every 2, the result at 6, the next swing at 9. */
function step(player, session) {
  const { hack: timing } = Common.data;
  const cycle = timing.resultAt + timing.pause;
  const at = session.tick % cycle;
  session.tick++;
  const current = Locs.find(session.jungle.locs.slice(0, 4).map(Common.locId), session.location);
  if (!current) return stop(player);
  if (at > timing.resultAt) return;
  // An event takes the swing's place (its stall is the animation) and ends the hack.
  if (at < timing.resultAt && Events.roll(player, session.jungle, current)) {
    sessions.delete(player);
    return;
  }
  Common.animate(player, session.machete.hack);
  if (at === 0) {
    player.setPositionToFace(session.location);
    Common.sound(player, Common.data.sounds.swing, 30);
  } else if (at === timing.resultAt) {
    result(player, session, current);
  } else if (at % timing.chipEvery === 0) {
    const { Graphic } = Common.core;
    player.getPacketSender().sendGlobalGraphic(new Graphic(Common.core.CacheDefinitions.getSpotanimId(Common.data.spotanims.chippings)), session.location);
    Common.sound(player, Common.data.sounds.chip);
  }
}

function process() {
  for (const [player, session] of [...sessions]) {
    if (session.paused) continue;
    if (Common.interrupted(player, session.location) || Common.wieldedMachete(player) !== session.machete) {
      stop(player);
      continue;
    }
    step(player, session);
  }
}

function pause(event) {
  Common.pauseOnLevelUp(event, sessions, stop);
}

function forget({ player }) {
  sessions.delete(player);
}

function attachJungle(api) {
  const { Task, TaskManager } = Common.core;
  for (const name of new Set(Common.data.jungle.map((jungle) => Common.core.CacheDefinitions.getObject(Common.locId(jungle.locs[0])).name))) {
    api.onObjectInteraction(name, { Hack: hack });
  }
  Common.onStop(stop);
  api.onPlayerLogout(forget);
  api.onCustomEvent("level-up:popup-opened", pause);
  TaskManager.submit(new (class extends Task {
    constructor() {
      super(1, "tai-bwo-wannai-cleanup:jungle", false);
    }
    execute() {
      process();
    }
  })());
}

module.exports = { attachJungle, hack, process, successChance, jungleOf, stop, _sessions: sessions };
