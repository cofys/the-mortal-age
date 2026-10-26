/**
 * Who holds the Soul Obelisk and the two graveyards, as recorded (rsprox 227/00079, 234/03277;
 * soul-wars.json `control`):
 * - each has an alignment from 0 (blue) through 60 (neutral) to 120 (red), and contested (who's
 *   gaining) and holder varbits;
 * - the side with more players in its zone moves it 2 a tick, up to 8 with a big majority; at an
 *   end the holder changes: "The red team has taken control of the Soul Obelisk!", and its locs
 *   change colour (the obelisk, the graveyard's barriers);
 * - left alone short of an end, it drifts back to its holder at 2 a tick.
 * Calibrated: the zones' bounds, 2 a tick for each player of majority.
 */
const Common = require("./Common.SoulWars");
const Match = require("./Match.SoulWars");

const PLACES = ["obelisk", "east", "west"];

function started(game) {
  game.control = {};
  for (const place of PLACES) game.control[place] = { alignment: Common.ALIGNMENT.neutral, holder: null, gaining: null };
}

function show(game, place) {
  const { alignment, contested, holder } = Common.data.control[place];
  const state = game.control[place];
  for (const player of game.players()) {
    Common.varbit(player, alignment, state.alignment);
    Common.varbit(player, contested, state.gaining ? Common.TEAM_VALUE[state.gaining] : 0);
    Common.varbit(player, holder, state.holder ? Common.TEAM_VALUE[state.holder] : 0);
  }
}

/** The living players of each team inside the place's zone. */
function counts(game, place) {
  const zone = Common.data.control[place].zone;
  const out = { blue: 0, red: 0 };
  for (const player of game.players()) {
    if (game.isGhost?.(player)) continue;
    const at = game.area.templateOf(player.getLocation());
    if (at[2] === 0 && at[0] >= zone[0] && at[0] <= zone[2] && at[1] >= zone[1] && at[1] <= zone[3]) out[game.teamOf(player)]++;
  }
  return out;
}

function step(game, place) {
  const state = game.control[place];
  const { min, max, perPlayer, drift } = Common.data.captureRate;
  const { blue, red } = counts(game, place);
  let gaining = null;
  let rate = 0;
  if (blue !== red) {
    gaining = blue > red ? "blue" : "red";
    rate = Math.min(max, Math.max(min, perPlayer * Math.abs(blue - red)));
  }
  const before = { alignment: state.alignment, gaining: state.gaining, holder: state.holder };
  if (gaining && state.alignment !== Common.ALIGNMENT[gaining]) {
    const target = Common.ALIGNMENT[gaining];
    state.alignment = gaining === "blue" ? Math.max(target, state.alignment - rate) : Math.min(target, state.alignment + rate);
    state.gaining = gaining;
    if (state.alignment === target && state.holder !== gaining) capture(game, place, gaining, blue, red);
  } else {
    state.gaining = null;
    // Left alone it drifts back to its holder's end, or to neutral when nobody holds it.
    const target = Common.ALIGNMENT[state.holder ?? "neutral"];
    if (!gaining && state.alignment !== target) {
      state.alignment = state.alignment > target ? Math.max(target, state.alignment - drift) : Math.min(target, state.alignment + drift);
    }
  }
  if (before.alignment !== state.alignment || before.gaining !== state.gaining || before.holder !== state.holder) show(game, place);
}

function capture(game, place, team) {
  const state = game.control[place];
  state.holder = team;
  const line = Common.message("captured", { colour: Common.COLOURS[team], team, place: Common.data.control[place].name });
  for (const player of game.players()) player.sendMessage(line);
  const zone = Common.data.control[place].zone;
  for (const player of game.players()) {
    if (game.teamOf(player) !== team || game.isGhost?.(player)) continue;
    const at = game.area.templateOf(player.getLocation());
    if (at[2] === 0 && at[0] >= zone[0] && at[0] <= zone[2] && at[1] >= zone[1] && at[1] <= zone[3]) game.statsOf(player).areas++;
  }
  recolour(game, place, team);
}

/** The obelisk and the graveyard barriers take the holder's colour. */
function recolour(game, place, team) {
  const { GameObject, ObjectManager } = Common.core;
  const put = (id, [x, y], type, face) => ObjectManager.register(new GameObject(id, game.area.at([x, y, 0]), type, face, game.area), true);
  if (place === "obelisk") {
    const { tile, locs } = Common.data.obelisk;
    put(locs[team ?? "neutral"], tile, 10, 1);
    return;
  }
  const yard = Common.data.graveyards[place];
  for (const [x, y, face] of yard.barrierTiles) put(yard.barriers[team ?? "neutral"], [x, y], 0, face);
}

function tick(game) {
  for (const place of PLACES) step(game, place);
}

function holder(game, place) {
  return game.control?.[place]?.holder ?? null;
}

function attachControl() {
  Match.onStart(started);
  Match.onTick(tick);
}

module.exports = { attachControl, holder, step, capture, counts, PLACES };
