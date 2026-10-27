/**
 * The lethal fog, as captured (rsprox 20261026T161730, game 8 the whole way), from "The fight for
 * survival has begun!":
 * - +100: "Lethal fog will soon fill the island! The safezone is <col=ef1020>the Trading
 *   Post</col>." (a broadcast), a 13x13 square of fog markers (br_safezone_indicator) round the
 *   safe zone, and a hint arrow over its centre when it's near, else 30 tiles ahead of the player
 *   towards it, moving with them;
 * - +250: the overlay reads "Approaching"; varbits br_safecoord_x/z (the centre, as instance
 *   coordinates) and br_saferadius 100, which the client draws the fog from; the radius falls by
 *   one every 4 then 6 ticks;
 * - +625: "Danger", the radius drops to 16 and keeps falling to 6;
 * - in the fog br_fog_damagecount climbs by one every 2 ticks to 6 and the hits run 1, 1, 1, 1,
 *   2, 2, 3...; out of it the count falls 6 -> 3 -> 0.
 * Wiki: 16 or more tiles into the fog, up to 10 every other tick; outside the safe zone once it is
 * "Danger", 1 a tick rising to 10. Inferred: the fog's edge is square (the markers are).
 */
const Common = require("./Common.LastManStanding");
const Match = require("./Match.LastManStanding");

/** Each player's run of ticks in the fog. */
const exposure = new Map();
/** Where each player's hint arrow points now ("x,y"). */
const arrows = new Map();
/** Captured: the arrow sits on the centre within 58 tiles, and 30 tiles ahead at 75 and 90. */
const ARROW_IN_SIGHT = 64;
const ARROW_AHEAD = 30;
/** The hint arrow's tile position (its centre) and height, as captured. */
const ARROW_POSITION = 2;
const ARROW_HEIGHT = 60;

function centreOf(game) {
  return game.area.at([...game.zone.centre, 0]);
}

/** The fog markers round the final zone, skipping tiles something else stands on. */
function placeMarkers(game) {
  const { GameObject, ObjectManager } = Common.core;
  const marker = Common.locId("br_safezone_indicator");
  const [cx, cy] = game.zone.centre;
  const r = Common.data.timing.finalRadius;
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
      const tile = game.area.at([cx + dx, cy + dy, 0]);
      if (Common.occupied(tile.getX(), tile.getY(), 0, game.area)) continue;
      // Captured: each marker turned at random.
      ObjectManager.register(new GameObject(marker, tile, 10, Common.randomInt(0, 3), game.area), true);
    }
  }
}

function warn(game) {
  const line = Common.message("fogWarning", { zone: game.zone.name });
  placeMarkers(game);
  for (const player of game.alive) {
    Common.broadcast(player, line);
  }
}

/**
 * Captured: over the safe zone's centre when it is near; when it is far, 30 tiles from the player
 * straight along the axis the centre is furthest on. Inferred: "near" is within 64 tiles (the
 * capture has the centre at 58 and an arrow ahead at 75).
 */
function arrowTile(game, player) {
  const centre = centreOf(game);
  const here = player.getLocation();
  const dx = centre.getX() - here.getX();
  const dy = centre.getY() - here.getY();
  if (Math.max(Math.abs(dx), Math.abs(dy)) <= ARROW_IN_SIGHT) return centre;
  const { Location } = Common.core;
  return Math.abs(dx) >= Math.abs(dy)
    ? new Location(here.getX() + Math.sign(dx) * ARROW_AHEAD, here.getY(), 0)
    : new Location(here.getX(), here.getY() + Math.sign(dy) * ARROW_AHEAD, 0);
}

function pointArrow(game, player) {
  const tile = arrowTile(game, player);
  const key = `${tile.getX()},${tile.getY()}`;
  if (arrows.get(player) === key) return;
  arrows.set(player, key);
  player.getPacketSender().sendPositionalHint(tile, ARROW_POSITION, ARROW_HEIGHT, 0);
}

function begin(game) {
  const centre = centreOf(game);
  game.fog = { radius: Common.data.timing.fogStartRadius, nextShrink: game.clock + 4, step: 0, danger: false };
  for (const player of game.alive) {
    Common.varbit(player, "br_safecoord_x", centre.getX());
    Common.varbit(player, "br_safecoord_z", centre.getY());
    Common.varbit(player, "br_saferadius", game.fog.radius);
  }
}

function setRadius(game, radius) {
  game.fog.radius = radius;
  for (const player of game.alive) Common.varbit(player, "br_saferadius", radius);
}

/** The radius: one less every 4 then 6 ticks, down to the final square. */
function shrink(game) {
  const { fogShrinkEvery, dangerAt, dangerRadius, finalRadius } = Common.data.timing;
  if (!game.fog.danger && game.clock >= dangerAt) {
    game.fog.danger = true;
    if (game.fog.radius > dangerRadius) setRadius(game, dangerRadius);
  }
  if (game.clock < game.fog.nextShrink || game.fog.radius <= finalRadius) return;
  game.fog.nextShrink = game.clock + fogShrinkEvery[game.fog.step++ % fogShrinkEvery.length];
  setRadius(game, game.fog.radius - 1);
}

/** How far into the fog a player is (0: in the safe zone). */
function depthOf(game, player) {
  const here = player.getLocation();
  const centre = centreOf(game);
  const distance = Math.max(Math.abs(here.getX() - centre.getX()), Math.abs(here.getY() - centre.getY()));
  return Math.max(0, distance - game.fog.radius);
}

function hit(player, damage) {
  const { HitDamage, HitMask } = Common.core;
  player.getCombat().getHitQueue().addPendingDamage([new HitDamage(damage, HitMask.RED)]);
}

/** One player's tick in or out of the fog. */
function expose(game, player) {
  const { damageEvery, rampTo, greaterDepth, greaterDamage, dangerDamageStart, dangerDamageMax, dangerRampEvery } = Common.data.fog;
  const depth = depthOf(game, player);
  const state = exposure.get(player) ?? { ticks: 0, count: 0, danger: 0 };
  exposure.set(player, state);
  if (depth <= 0) {
    if (state.count > 0 && game.clock % damageEvery === 0) {
      state.count = Math.max(0, state.count - rampTo / 2);
      Common.varbit(player, "br_fog_damagecount", state.count);
    }
    state.ticks = 0;
    state.danger = 0;
    return;
  }
  if (game.fog.danger) {
    // Wiki: caught outside once it's "Danger", 1 a tick climbing to 10.
    hit(player, Math.min(dangerDamageMax, dangerDamageStart + Math.floor(state.danger++ / dangerRampEvery)));
    return;
  }
  state.ticks++;
  if (state.ticks % damageEvery !== 1) return;
  const hits = Math.floor(state.ticks / damageEvery);
  if (state.count < rampTo) {
    state.count++;
    Common.varbit(player, "br_fog_damagecount", state.count);
  }
  const damage = depth >= greaterDepth ? Common.randomInt(greaterDamage[0], greaterDamage[1]) : hits < 4 ? 1 : hits < 6 ? 2 : 3;
  hit(player, damage);
}

function tick(game) {
  const { fogWarning, fogStart } = Common.data.timing;
  if (!game.begun) return;
  if (game.clock === fogWarning) warn(game);
  if (game.clock >= fogWarning) for (const player of game.alive) pointArrow(game, player);
  if (game.clock === fogStart) begin(game);
  if (!game.fog) return;
  shrink(game);
  for (const player of game.alive) {
    if (player.getHitpoints() > 0) expose(game, player);
  }
}

/** Captured: "Safe" before the fog, "Approaching" from +250 (in the fog or not), "Danger" from +625. */
function status(game) {
  return () => (!game.fog ? "Safe" : game.fog.danger ? "Danger" : "Approaching");
}

function started(game) {
  game.fogStatus = status(game);
}

function ended(game) {
  for (const player of game.players) {
    exposure.delete(player);
    arrows.delete(player);
  }
}

function attachFog() {
  Match.onStart(started);
  Match.onTick(tick);
  Match.onEnd(ended);
}

module.exports = { attachFog, depthOf, tick, placeMarkers };
