/**
 * The arena's seer (huey_seer), as captured (rsprox 3399; lines from the Wiki transcript,
 * Seer (The Darkfrost)): she waits at the chain, runs to the body when the fight starts, to
 * the barrier when the body is beaten ("Nicely done!", "Steady now!", "Let's go!" as it
 * retracts 9 ticks later) and on to the pillars, where she charges them (npc_dwarf_summon_orb
 * every 5 ticks, the charge bar every 30) until the kill.
 */
const Shared = require("./Shared.Hueycoatl");

/** Her runs, as captured tile by tile. */
const TO_BODY = Object.freeze([[1530, 3282], [1529, 3278], [1527, 3276]]);
const TO_GATE = Object.freeze([[1525, 3275], [1523, 3273], [1521, 3272], [1519, 3272], [1518, 3271]]);
const TO_PILLARS = Object.freeze([[1516, 3271], [1512, 3271], [1510, 3272], [1510, 3284], [1508, 3286], [1506, 3288]]);
const STEADY_TICKS = 5;
const LETS_GO_TICKS = 9;
const BODY_LINES = Object.freeze(["Block its attacks with your prayers!", "Let's convince that beastie to move!"]);
const TAIL_LINES = Object.freeze(["Watch out for its slam!", "Go for the tail! It's a weakspot!"]);

let core = null;

function seerOf(session) {
  const seer = session.fight?.seer;
  return seer?.isRegistered() || core.World.getAddNPCQueue().includes(seer) ? seer : null;
}

function spawn(session) {
  const seer = session.spawnNpc(Shared.NPC.ARENA_SEER, Shared.SEER_TILE);
  seer.setMovementSteps(2);
  return seer;
}

function run(session, path) {
  const seer = seerOf(session);
  if (!seer) return;
  const queue = seer.getMovementQueue();
  queue.reset();
  for (const tile of path) queue.addSteps(session.tile(tile));
}

function say(session, text) {
  seerOf(session)?.forceChat(text);
}

function runToBody(session) {
  say(session, Shared.pick(BODY_LINES));
  run(session, TO_BODY);
}

function bodyLine(session) {
  say(session, Shared.pick(BODY_LINES));
}

function tailLine(session) {
  say(session, Shared.pick(TAIL_LINES));
}

function runToPillars(session) {
  say(session, "Nicely done!");
  run(session, TO_GATE);
  session.schedule(STEADY_TICKS, () => say(session, "Steady now!"));
  session.schedule(LETS_GO_TICKS, () => {
    say(session, "Let's go!");
    run(session, TO_PILLARS);
  });
}

function orb(session) {
  seerOf(session)?.performAnimation(new core.Animation(Shared.SEQ.SEER_ORB));
}

function light(session) {
  seerOf(session)?.performAnimation(new core.Animation(Shared.SEQ.SEER_LIGHT));
}

function charge(session, bar) {
  seerOf(session)?.showHeadbar(bar.id, { fill: bar.fill, endFill: bar.endFill, duration: bar.duration });
}

function stopCharging(session, barId) {
  const seer = seerOf(session);
  if (!seer) return;
  seer.removeHeadbar(barId);
  seer.performAnimation(new core.Animation(Shared.SEQ.SEER_ORB_END));
}

function defeated(session) {
  say(session, "We did it! Well done!");
}

function remove(session) {
  session.removeNpc(session.fight?.seer);
}

function attach(pluginApi) {
  core = pluginApi.core;
}

module.exports = {
  attach, spawn, say, runToBody, bodyLine, tailLine, runToPillars, orb, light, charge, stopCharging, defeated, remove,
};
