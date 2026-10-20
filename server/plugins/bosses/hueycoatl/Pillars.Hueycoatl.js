/**
 * The three pillars and their braziers, as captured (rsprox 3274, 3399; docs/hueycoatl.md):
 * from the seer reaching them until the kill, every 2 ticks each pillar's engraving climbs a
 * stage (empty, s1-s5) while enough players hold its protection prayer, and drops one while
 * not. The seer's charge bar (headbar 34, 0 -> 60 over 900 cycles) fills every 30 ticks;
 * when it does, three full pillars light the braziers (a 30% damage boost, Wiki) or keep them
 * lit, and anything less puts them out. Required prayers per pillar grow with the team: everyone
 * in the arena counts (Wiki).
 */
const Shared = require("./Shared.Hueycoatl");
const Seer = require("./Seer.Hueycoatl");

const STAGE_TICKS = 2;
const BAR_TICKS = 30;
const BAR = Object.freeze({ id: 34, fill: 0, endFill: 60, duration: 900 });
const ORB_TICKS = 5;

let core = null;
let PrayerHandler = null;

const PRAYER = () => ({
  magic: PrayerHandler.PROTECT_FROM_MAGIC,
  missiles: PrayerHandler.PROTECT_FROM_MISSILES,
  melee: PrayerHandler.PROTECT_FROM_MELEE,
});

function showStage(session, pillar, stage) {
  session.setLoc(pillar.tile, Shared.PILLAR_ENGRAVING_SHAPE, 0, pillar.stages[stage]);
}

function showBrazier(session, pillar, lit) {
  session.setLoc(pillar.tile, Shared.PILLAR_BRAZIER_SHAPE, Shared.PILLAR_BRAZIER_ROTATION, lit ? pillar.on : pillar.off);
}

/** Empty pillars and cold braziers (a fresh set). */
function reset(session) {
  session.pillars = { active: false, lit: false, stages: { magic: 0, missiles: 0, melee: 0 }, nextStage: 0, nextBar: 0, nextOrb: 0, bars: 0 };
  for (const pillar of Shared.PILLARS) {
    showStage(session, pillar, 0);
    showBrazier(session, pillar, false);
  }
}

/** The seer reaches the pillars: the first bar starts. */
function start(session) {
  const state = session.pillars;
  const t = core.World.getProcessCycle();
  state.active = true;
  state.nextStage = t;
  state.nextBar = t;
  state.nextOrb = t;
  state.bars = 0;
  Seer.say(session, "Keep praying to bolster your strength!");
}

function stop(session) {
  const state = session.pillars;
  if (!state?.active) return;
  state.active = false;
  Seer.stopCharging(session, BAR.id);
}

/** How many players in the arena hold each protection prayer. */
function prayerCounts(players) {
  const prayers = PRAYER();
  const counts = { magic: 0, missiles: 0, melee: 0 };
  for (const player of players) {
    for (const kind of Object.keys(counts)) {
      if (PrayerHandler.isActivated(player, prayers[kind])) counts[kind] += 1;
    }
  }
  return counts;
}

/** A pillar's next stage: up while charged, down while not. */
function nextStage(stage, charged) {
  return charged ? Math.min(Shared.PILLAR_STAGES, stage + 1) : Math.max(0, stage - 1);
}

function check(session) {
  const state = session.pillars;
  const full = Shared.PILLARS.every((pillar) => state.stages[pillar.kind] >= Shared.PILLAR_STAGES);
  if (full) {
    if (!state.lit) {
      for (const pillar of Shared.PILLARS) showBrazier(session, pillar, true);
      Seer.light(session);
    }
    state.lit = true;
    Seer.say(session, "Excellent! The pillars are boosting your strength!");
    return;
  }
  if (state.lit) {
    for (const pillar of Shared.PILLARS) showBrazier(session, pillar, false);
  }
  state.lit = false;
  Seer.say(session, "We need to charge all of the pillars using our prayers!");
}

function tick(session, players) {
  const state = session.pillars;
  if (!state?.active) return;
  const t = core.World.getProcessCycle();
  if (t >= state.nextStage) {
    state.nextStage = t + STAGE_TICKS;
    const need = Shared.prayersPerPillar(players.length);
    const counts = prayerCounts(players);
    for (const pillar of Shared.PILLARS) {
      const stage = nextStage(state.stages[pillar.kind], counts[pillar.kind] >= need);
      if (stage === state.stages[pillar.kind]) continue;
      state.stages[pillar.kind] = stage;
      showStage(session, pillar, stage);
    }
  }
  if (t >= state.nextOrb) {
    state.nextOrb = t + ORB_TICKS;
    Seer.orb(session);
  }
  if (t >= state.nextBar) {
    if (state.bars > 0) check(session);
    state.bars += 1;
    state.nextBar = t + BAR_TICKS;
    Seer.charge(session, BAR);
  }
}

/** The braziers' boost on a player's hit (Wiki: 30% while lit). */
function damageBoost(session) {
  return session.pillars?.lit ? Shared.BRAZIER_BONUS : 1;
}

function attach(pluginApi) {
  core = pluginApi.core;
  PrayerHandler = core.PrayerHandler;
}

module.exports = { attach, reset, start, stop, tick, damageBoost, _test: { nextStage, prayerCounts } };
