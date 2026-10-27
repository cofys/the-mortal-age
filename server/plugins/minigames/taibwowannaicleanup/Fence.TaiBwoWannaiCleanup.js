/**
 * Tai Bwo Wannai Cleanup: repairing the village fence (Repair on the rotten, partial, short and
 * medium fence; Reinforce on the finished one) with a machete and a thatching spar. rsprox
 * 227/01858: the prepare-wood animation and sound on arrival, the fence animations from the 5th
 * tick (the middle one with its sound each tick), and on the 10th the fence one stage up in place
 * and the spar used. Other players' fences in 231/03030 went up a stage every 13 ticks, so a
 * repair carries on, a spar at a time, until the fence is finished; Reinforce is one spar. The Wiki
 * gives the XP and favour per spar (light 28.1 and 0.1%, medium 42.1 and 0.3%, dense 65.1 and
 * 0.5%). A fence falls back to rotten 1000 ticks after its last repair (Locs).
 */
const Common = require("./Common.TaiBwoWannaiCleanup");
const Favour = require("./Favour.TaiBwoWannaiCleanup");
const Locs = require("./Locs.TaiBwoWannaiCleanup");

/** By player: { location, tick, reinforce }. */
const sessions = new Map();

const fenceIds = () => Common.data.fence.locs.map(Common.locId);
const stageOf = (id) => fenceIds().indexOf(id);
const finished = () => Common.data.fence.locs.length - 1;

/** The first thatching spar in the inventory, as its data entry. */
function firstSpar(player) {
  for (const item of player.getInventory().getItems()) {
    const spar = item && Common.data.spars.find((entry) => Common.objId(entry.item) === item.getId());
    if (spar) return spar;
  }
  return null;
}

function stop(player) {
  if (!sessions.delete(player)) return;
  player.performAnimation(Common.core.Animation.DEFAULT_RESET_ANIMATION);
}

function start(event, reinforce) {
  const { player, object } = event;
  const stage = stageOf(object.getId());
  if (stage < 0 || (stage === finished()) !== reinforce) return false;
  event.handled = true;
  if (!Common.questComplete(player) || Common.progress(player) < Common.data.progress.told) {
    Common.statement(player, Common.message("notToldFence"));
    return true;
  }
  if (!Common.hasMachete(player)) {
    player.sendMessage(Common.message("noFenceMachete"));
    return true;
  }
  if (!firstSpar(player)) {
    player.sendMessage(Common.message("noSpars"));
    return true;
  }
  Common.stopActions(player);
  const session = { location: object.getLocation().clone(), tick: 0, reinforce };
  sessions.set(player, session);
  // The prepare-wood animation plays on the arrival tick itself.
  step(player, session);
  return true;
}

const repair = (event) => start(event, false);
const reinforce = (event) => start(event, true);

/** The 10th tick: a spar goes into the fence. Returns whether to carry on. */
function finish(player, session, current) {
  const spar = firstSpar(player);
  if (!spar) {
    player.sendMessage(Common.message("noSpars"));
    return false;
  }
  const stage = stageOf(current.getId());
  // Someone else may have finished it (or it fell back to rotten) since this repair began.
  if (session.reinforce ? stage !== finished() : stage >= finished()) return false;
  const next = session.reinforce ? stage : stage + 1;
  Common.animate(player, "fenceEnd");
  player.getInventory().delete(Common.objId(spar.item), 1);
  Locs.swap(current, fenceIds()[next], Common.data.fence.decayTicks, fenceIds()[0]);
  Common.xp(player, "WOODCUTTING", spar.xp);
  Favour.gain(player, spar.points);
  Common.advance(player, Common.data.progress.repaired);
  return !session.reinforce && next < finished();
}

function step(player, session) {
  const { fence } = Common.data;
  const at = session.tick % (fence.doneAt + fence.pause);
  session.tick++;
  const current = Locs.find(fenceIds(), session.location);
  if (!current) return stop(player);
  if (at === 0) {
    player.setPositionToFace(session.location);
    Common.animate(player, "prepare", 30);
    Common.sound(player, Common.data.sounds.prepare, 30);
  } else if (at === fence.startAt) {
    Common.animate(player, "fenceStart");
  } else if (at > fence.startAt && at < fence.doneAt) {
    Common.animate(player, "fenceMid");
    Common.sound(player, Common.data.sounds.fence);
  } else if (at === fence.doneAt && !finish(player, session, current)) {
    sessions.delete(player);
  }
}

function process() {
  for (const [player, session] of [...sessions]) {
    if (session.paused) continue;
    if (Common.interrupted(player, session.location)) {
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

function attachFence(api) {
  const { CacheDefinitions, Task, TaskManager } = Common.core;
  const names = Common.data.fence.locs.map((name) => CacheDefinitions.getObject(Common.locId(name)).name);
  for (const name of names.slice(0, -1)) api.onObjectInteraction(name, { Repair: repair });
  api.onObjectInteraction(names[names.length - 1], { Reinforce: reinforce });
  Common.onStop(stop);
  api.onPlayerLogout(forget);
  api.onCustomEvent("level-up:popup-opened", pause);
  TaskManager.submit(new (class extends Task {
    constructor() {
      super(1, "tai-bwo-wannai-cleanup:fence", false);
    }
    execute() {
      process();
    }
  })());
}

module.exports = { attachFence, repair, reinforce, process, stop, _sessions: sessions };
