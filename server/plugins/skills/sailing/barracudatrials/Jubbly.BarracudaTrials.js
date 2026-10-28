// The Jubbly Jive's jubblies (rsprox, recordings 907 and 908):
//   Balloon toads come from the pile on the toad boat at the course's far west (Collect-from):
//   4 at Unranked and Swordfish, 12 at Shark, 9 at Marlin. "You collect four balloon toads. Time
//   to lure some jubblies!" (a refill: "You collect five balloon toads. You now have nine in total.
//   ..."), sound 10696, the toads thrown to the player (3502) and onto the deck 2 ticks later;
//   full: "You already have enough balloon toads!"
//   Launch-toad-at on an outcrop that's free (state 1), up to 18 tiles from the boat: "You throw a
//   balloon toad onto the outcrop in an attempt to lure a jubbly.", sound 10752, the toad thrown
//   to it; it's there 2 ticks later (state 2). Again before it lands: "There is already a balloon
//   toad on that outcrop!"; none left: "You don't have any balloon toads to throw!" The last one
//   thrown, the arrow points back at the toad boat.
//   The jubbly starts on outcrop 3 and hops to the next outcrop (N to N+1, never skipping) once a
//   toad has been waiting there 2 ticks, after at least 11 ticks on its own (checked every 2 ticks).
//   Reaching outcrop 7, beside Gurtob, is a lure: "You successfully lure a jubbly to Gurtob (k/N)!"
//   (no count when one is needed); the next jubbly appears on outcrop 0 at once, and outcrop 7 is
//   free again 7 ticks later. Outcrop states: 0 unused (Swordfish's first three), 1 free, 2 toad
//   waiting, 3 jubbly.
//   The bird (15114), a tick after a hop: the old one turns to the next outcrop, flies up (6806)
//   with "Rawk!" and is gone 3 ticks later; the new one lands (6805) with "Sqwark!" and gobbles 3
//   ticks later. Outcrop 7's bird stays until the outcrop is free, flies off a tick after and is
//   gone 3 ticks later; after the last lure it's gone 7 ticks on without flying.
const common = require("./Common.BarracudaTrials");
const ships = require("./Ships.BarracudaTrials");
const run = require("./Run.BarracudaTrials");

const LOC_TOAD_PILE = 59169;
const BIRD = 15114;
const SEQ_FLY_DOWN = 6805;
const SEQ_FLY_UP = 6806;
const PROJECTILE_TOAD = 3502;
const SOUND_COLLECT = 10696;
const SOUND_THROW = 10752;
const LAND_TICKS = 2;
const MIN_STAY = 11;
const CHECK_TICKS = 2;
const LURE_PILLAR = 7;
const PILLAR_RESET_TICKS = 7;
const GOBBLE_TICKS = 3;
const BIRD_GONE_TICKS = 3;
const TOAD_WAIT = 2;
const LAST_BIRD_TICKS = 4;
const THROW_REACH = 18;
/** The toads on the player's deck (rsprox: skiff). */
const DECK_TOADS = { id: 59172, x: 4, y: 4, level: 1, shape: 22, rotation: 2 };

let pluginApi;

function trial() {
  return common.trialByKey("jubbly_jive");
}

function pillarVarbit(n) {
  return common.varbit(`sailing_bt_jubbly_jive_pillar_${n}_state_player`);
}

function setPillar(player, jubbly, n, value) {
  jubbly.pillars[n] = value;
  player.getPacketSender().sendVarbit(pillarVarbit(n), value);
}

function later(jubbly, ticks, action) {
  jubbly.timers.push({ due: common.clock() + ticks, action });
}

/** The bird on outcrop `n`, landing there with "Sqwark!" (or already there at the start). */
function spawnBird(player, jubbly, n, { flyDown = true } = {}) {
  const [x, y] = trial().pillars[n].bird;
  const bird = pluginApi.spawnNpc({ id: BIRD, x, y, z: 0, owner: player, ownerOnly: true });
  if (!bird) return;
  const { Animation } = common.core();
  if (flyDown) {
    bird.performAnimation(new Animation(SEQ_FLY_DOWN));
    bird.forceChat("Sqwark!");
    later(jubbly, GOBBLE_TICKS, () => bird.isRegistered?.() && bird.forceChat("*Gobble*"));
  }
  jubbly.birdOn.set(n, bird);
  jubbly.birds.add(bird);
}

/** The bird leaving outcrop `n`, turned toward `toward` (the next outcrop) if any. */
function flyAway(jubbly, n, toward) {
  const bird = jubbly.birdOn.get(n);
  jubbly.birdOn.delete(n);
  if (!bird) return;
  const { Animation, Location } = common.core();
  if (toward !== undefined) {
    const [x, y] = trial().pillars[toward].bird;
    bird.faceTile(new Location(x, y, 0));
  }
  bird.performAnimation(new Animation(SEQ_FLY_UP, 30));
  bird.forceChat("Rawk!");
  later(jubbly, BIRD_GONE_TICKS, () => {
    pluginApi.removeNpc(bird);
    jubbly.birds.delete(bird);
  });
}

function start(player, current) {
  const swordfish = current.rank === 1;
  const jubbly = { toads: 0, pillars: [], pending: new Set(), at: 3, since: common.clock(), lured: 0, timers: [], birdOn: new Map(), birds: new Set(), landed: [] };
  current.state = jubbly;
  for (let n = 0; n < 8; n++) setPillar(player, jubbly, n, swordfish && n < 3 ? 0 : 1);
  setPillar(player, jubbly, 3, 3);
  spawnBird(player, jubbly, 3, { flyDown: false });
}

function capacity(current) {
  return trial().toads[current.rank];
}

function deckToads(player, place, boat = common.core().Sailing.instanceAboard(player)) {
  if (!boat) return;
  if (place) common.core().BoatManager.setDeckLoc(boat, DECK_TOADS);
  else common.core().BoatManager.removeDeckLoc(boat, DECK_TOADS);
}

function collect(player, current) {
  const jubbly = current.state;
  const full = capacity(current);
  if (jubbly.toads >= full) return player.sendMessage("<col=ff3045>You already have enough balloon toads!");
  const added = full - jubbly.toads;
  const refill = jubbly.toads > 0;
  jubbly.toads = full;
  player.sendMessage(refill
    ? `<col=3366ff>You collect ${common.numberWord(added)} balloon toads. You now have ${common.numberWord(full)} in total. Time to lure some jubblies!</col>`
    : `<col=3366ff>You collect ${common.numberWord(added)} balloon toads. Time to lure some jubblies!</col>`);
  const out = player.getPacketSender();
  out.sendSoundEffect(SOUND_COLLECT, 1, 0);
  run.clearHint(player);
  const boat = ships.shipOf("bt_toad_boat")?.boat;
  if (boat) {
    out.sendProjectile(new (common.core().Location)(boat.tileX, boat.tileY, 0), common.core().BoatManager.rootLocation(player),
      0, 60, PROJECTILE_TOAD, 5, 32, player, 0, 30, 10);
  }
  if (!refill) later(jubbly, LAND_TICKS, () => common.runs.get(player) === current && jubbly.toads > 0 && deckToads(player, true));
}

function throwToad(player, current, n) {
  const jubbly = current.state;
  if (jubbly.toads <= 0) return player.sendMessage("<col=ff3045>You don't have any balloon toads to throw!");
  if (jubbly.pillars[n] !== 1 || jubbly.pending.has(n)) {
    return player.sendMessage("<col=ff3045>There is already a balloon toad on that outcrop!");
  }
  jubbly.toads--;
  jubbly.pending.add(n);
  player.sendMessage("You throw a balloon toad onto the outcrop in an attempt to lure a jubbly.");
  const out = player.getPacketSender();
  out.sendSoundEffect(SOUND_THROW, 1, 0);
  const pillar = trial().pillars[n];
  const { Location, BoatManager } = common.core();
  out.sendProjectile(BoatManager.rootLocation(player), new Location(pillar.landing[0], pillar.landing[1], 0),
    0, 60, PROJECTILE_TOAD, pillar.heights[0] / 4, pillar.heights[1] / 4, undefined, 0, 30, pillar.progress ?? 70);
  later(jubbly, LAND_TICKS, () => {
    jubbly.pending.delete(n);
    if (common.runs.get(player) !== current || jubbly.pillars[n] !== 1) return;
    setPillar(player, jubbly, n, 2);
    jubbly.landed[n] = common.clock();
  });
  if (jubbly.toads === 0) {
    deckToads(player, false);
    run.sendHint(player, current);
  }
}

/** The jubbly's hop to the next outcrop once a toad waits there, and the lure at the last one. */
function hop(player, current) {
  const jubbly = current.state;
  const stay = common.clock() - jubbly.since;
  if (stay < MIN_STAY || (stay - MIN_STAY) % CHECK_TICKS !== 0) return;
  const next = jubbly.at + 1;
  if (next > LURE_PILLAR || jubbly.pillars[next] !== 2) return;
  if (common.clock() - (jubbly.landed[next] ?? 0) < TOAD_WAIT) return;
  const from = jubbly.at;
  setPillar(player, jubbly, from, 1);
  setPillar(player, jubbly, next, 3);
  later(jubbly, 1, () => {
    flyAway(jubbly, from, next);
    spawnBird(player, jubbly, next);
  });
  jubbly.at = next;
  jubbly.since = common.clock();
  if (next === LURE_PILLAR) lure(player, current);
}

function lure(player, current) {
  const jubbly = current.state;
  jubbly.lured++;
  const required = current.rankData.objectives;
  player.sendMessage(required > 1
    ? `<col=3366ff>You successfully lure a jubbly to Gurtob (${jubbly.lured}/${required})!</col>`
    : "<col=3366ff>You successfully lure a jubbly to Gurtob!</col>");
  later(jubbly, PILLAR_RESET_TICKS, () => {
    if (common.runs.get(player) !== current || jubbly.pillars[LURE_PILLAR] !== 3) return;
    setPillar(player, jubbly, LURE_PILLAR, 1);
    later(jubbly, 1, () => flyAway(jubbly, LURE_PILLAR));
  });
  if (jubbly.lured >= required) return;
  // The next jubbly appears on the first outcrop at once.
  setPillar(player, jubbly, 0, 3);
  jubbly.at = 0;
  jubbly.since = common.clock();
  later(jubbly, 1, () => spawnBird(player, jubbly, 0));
}

function tick(player, current) {
  const jubbly = current.state;
  const now = common.clock();
  const due = jubbly.timers.filter((timer) => timer.due <= now);
  jubbly.timers = jubbly.timers.filter((timer) => timer.due > now);
  for (const timer of due) timer.action();
  if (common.runs.get(player) === current) hop(player, current);
}

function pillarString(jubbly) {
  return jubbly.pillars.map((state, n) => `${jubbly.pending.has(n) ? 2 : state}|`).join("");
}

function end(player, current, { packets }) {
  const jubbly = current.state;
  if (!jubbly?.pillars) return;
  // The birds go a few ticks on (rsprox: the last lure's bird 7 ticks after it, at the completion's +4).
  const birds = [...jubbly.birds];
  jubbly.birds.clear();
  jubbly.birdOn.clear();
  const { CountdownTask, TaskManager } = common.core();
  TaskManager.submit(new CountdownTask(player, LAST_BIRD_TICKS, () => birds.forEach((bird) => pluginApi.removeNpc(bird))));
  jubbly.timers = [];
  if (jubbly.toads > 0) deckToads(player, false, current.boat);
  if (!packets) return;
  for (let n = 0; n < 8; n++) player.getPacketSender().sendVarbit(pillarVarbit(n), 0);
}

const mechanic = {
  start,
  tick,
  end,
  hud: (player, current) => {
    const jubbly = current.state;
    return [jubbly.lured, jubbly.toads, jubbly.toads > 0 ? 1 : 0, pillarString(jubbly)];
  },
  done: (player, current) => current.state.lured >= current.rankData.objectives,
};

function onLoc(event) {
  if (event.clickType !== 1) return;
  const current = common.runs.get(event.player);
  if (current?.trial.key !== "jubbly_jive" || current.finishing) return;
  if (event.objectId === LOC_TOAD_PILE) {
    event.handled = true;
    return collect(event.player, current);
  }
  const n = trial().pillars.findIndex((pillar) => pillar.loc === event.objectId);
  if (n < 0) return;
  event.handled = true;
  throwToad(event.player, current, n);
}

function attach(api) {
  pluginApi = api;
  common.init(api);
  run.registerMechanic("jubbly_jive", mechanic);
  api.onObjectInteraction(onLoc);
  api.setDeckReach?.(trial().pillars.map((pillar) => pillar.loc), THROW_REACH);
}

module.exports = attach;
module.exports.mechanic = mechanic;
module.exports.collect = collect;
module.exports.throwToad = throwToad;
module.exports.pillarString = pillarString;
