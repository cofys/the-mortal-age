"use strict";

const C = require("./Context.Hunter");
const { H, roll } = C;
const data = require("../data/impling-spawns.json");
// Wiki (Implings, "Overworld spawning"): every 30 minutes the wandering implings despawn and new
// ones appear at random spawn points, invisible for two minutes. Four come from the high table,
// N (5-10) rolls on the mid table and 2N on the low table. Prifddinas gets one crystal impling on
// the same timer. The spawn tiles are the impling spawn points of the rev237 cache's map data
// (ii_*_impling_precursor), deduplicated; the Wiki gives no coordinates. Hunter is a members plugin,
// so none of this exists on free worlds.
const CYCLE_TICKS = 3000;
const MANIFEST_TICKS = 200;
const CAUGHT_TICKS = 2;
// Estimate: the Wiki does not give the wander range.
const WANDER_RADIUS = 8;
const HIGH_COUNT = 4;
/** npc -> { visibleAt, removeAt } */
const spawned = new Map();

function weighted(table) {
  let draw = roll(1, Object.values(table).reduce((sum, w) => sum + w, 0));
  for (const [key, weight] of Object.entries(table)) if ((draw -= weight) <= 0) return key;
}

function spawn(key, [x, y]) {
  const npc = H.api.spawnNpc({ id: H.core.NpcIdentifiers[`${key}_IMPLING`], x, y, z: 0, wanderRadius: WANDER_RADIUS });
  if (!npc) return;
  npc.setVisible(false);
  spawned.set(npc, { visibleAt: H.tick + MANIFEST_TICKS, removeAt: 0 });
}

function clear() {
  for (const npc of spawned.keys()) H.api.removeNpc(npc);
  spawned.clear();
}

function cycle() {
  clear();
  const keys = [];
  for (let i = 0; i < HIGH_COUNT; i++) keys.push(weighted(data.tables.high));
  const mids = roll(5, 10);
  for (let i = 0; i < mids; i++) keys.push(weighted(data.tables.mid));
  for (let i = 0; i < mids * 2; i++) keys.push(weighted(data.tables.low));
  for (const key of keys) spawn(key, data.points[roll(0, data.points.length - 1)]);
  spawn("CRYSTAL", data.prifddinas);
}

/** Takes over a caught overworld impling: it is removed after its animation and not replaced until the next cycle. */
function caught(event) {
  const state = spawned.get(event.npc);
  if (!state) return;
  event.handled = true;
  state.removeAt = H.tick + CAUGHT_TICKS;
  event.npc.untargetable = true;
}

function process() {
  if (H.tick % CYCLE_TICKS === 1) cycle();
  for (const [npc, state] of spawned) {
    if (state.visibleAt && H.tick >= state.visibleAt) { state.visibleAt = 0; npc.setVisible(true); }
    if (state.removeAt && H.tick >= state.removeAt) { H.api.removeNpc(npc); spawned.delete(npc); }
  }
}

module.exports = { process, caught, clear, cycle, spawned, CYCLE_TICKS, MANIFEST_TICKS };
