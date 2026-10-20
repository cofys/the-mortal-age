/**
 * Moons of Peril: what the units share - the plugin api, the data from
 * plugins/bosses/data/moons-of-peril.json, tick helpers, tiles relative to a Moon, and the
 * per-player sends (varbits, sounds, graphics, locs and projectiles only that player sees).
 */
const fs = require("fs");
const path = require("path");

/** Which Moons the player has subdued since they last opened the Lunar Chest (bit per Moon). */
const DEAD_ATTRIBUTE = "moons-of-peril:dead";
/** Set while the player is in an arena, so a login there puts them in the antechamber. */
const INSIDE_ATTRIBUTE = "moons-of-peril:inside";
/** The player chose "Yes, and don't ask me again." at a statue. */
const NO_WARNING_ATTRIBUTE = "moons-of-peril:no-warning";

const MOONS = ["blood", "blue", "eclipse"];
const DEAD_BIT = { blood: 1, blue: 2, eclipse: 4 };

const OVERLAY_HUD_UID = (161 << 16) | 8;
const OVERLAY_ATMOSPHERE_UID = (161 << 16) | 1;

let api = null;
let core = null;
let data = null;

/** Set once by the plugin before any unit attaches. */
function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "moons-of-peril.json"), "utf8"));
}

/** Runs `action` `ticks` ticks from now (at least one). */
function later(ticks, action) {
  const { Task, TaskManager } = core;
  TaskManager.submit(new (class extends Task {
    constructor() {
      super(Math.max(1, ticks), null, false);
    }
    execute() {
      this.stop();
      action();
    }
  })());
}

const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// ------------------------------------------------------------------ tiles

/** The world tile at an offset [dx, dy] from a Moon's south-west tile. */
function tileAt(moon, [dx, dy]) {
  const [x, y, z] = data.moons[moon].tile;
  return new core.Location(x + dx, y + dy, z);
}

/** A location's offset [dx, dy] from a Moon's south-west tile. */
function offsetOf(moon, location) {
  const [x, y] = data.moons[moon].tile;
  return [location.getX() - x, location.getY() - y];
}

const location = ([x, y, z]) => new core.Location(x, y, z ?? 0);

/** Whether a location lies in the 2x2 glyph for `focus`. */
function onGlyph(moon, focus, where) {
  const glyph = data.glyphs[focus];
  if (!glyph) return false;
  const [dx, dy] = offsetOf(moon, where);
  return dx >= glyph[0] && dx <= glyph[0] + 1 && dy >= glyph[1] && dy <= glyph[1] + 1;
}

// ------------------------------------------------------------------ per-player sends

function varbit(player, name, value) {
  player.getPacketSender().sendVarbit(data.varbits[name], value);
}

function graphic(id, { delay = 0, height = 0 } = {}) {
  const gfx = new core.Graphic(id);
  gfx.delay = delay;
  gfx.height = height;
  return gfx;
}

/** A map animation on a tile, for the player. */
function tileGraphic(player, where, id, options) {
  player.getPacketSender().sendGraphic(graphic(id, options), where);
}

function animate(mobile, id, delay = 0) {
  const animation = new core.Animation(id);
  if (delay) animation.delay = delay;
  mobile.performAnimation(animation);
}

/** A sound for the player: an id, or [id, delay]. */
function sound(player, spec) {
  if (spec == null) return;
  const [id, delay] = Array.isArray(spec) ? spec : [spec, 0];
  player.getPacketSender().sendSoundEffect(id, 1, delay ?? 0);
}

function sounds(player, specs) {
  for (const spec of specs ?? []) sound(player, spec);
}

/** A sound heard around a tile, for the player. */
function areaSound(player, where, [id, delay], radius) {
  player.getPacketSender().sendAreaSound(id, where.getX(), where.getY(), where.getZ(), 1, delay ?? 0, radius ?? 0);
}

/** A loc only this player sees (pools, fires, floor sigils). */
function personalLoc(id, where, shape = 10, rotation = 0) {
  return {
    getId: () => id,
    getLocation: () => where,
    getType: () => shape,
    getFace: () => rotation,
  };
}

function addLoc(player, loc) {
  player.getPacketSender().sendObject(loc);
}

function removeLoc(player, loc) {
  player.getPacketSender().sendObjectRemoval(loc);
}

function locAnim(player, loc, animationId) {
  player.getPacketSender().sendObjectAnimation(loc, { id: animationId });
}

/**
 * A projectile only the player sees, as captured: `from`/`to` are mobiles or tiles; `spec` has
 * id, start, end (cycles), angle, progress and the heights.
 */
function projectile(player, from, to, spec) {
  const { Projectile, Location } = core;
  const tileOf = (thing) => (thing instanceof Location ? thing : Projectile.centreOf(thing));
  const lockon = to instanceof Location ? null : to;
  const source = from instanceof Location ? null : from;
  player.getPacketSender().sendProjectile(
    tileOf(from), tileOf(to), 0, spec.end, spec.id, spec.startHeight, spec.endHeight, lockon,
    spec.start, spec.angle, spec.progress ?? 0, source,
  );
}

// ------------------------------------------------------------------ the HUD and the portal

function openHud(player) {
  player.getPacketSender().sendSubInterface(OVERLAY_HUD_UID, data.hud.interface, 1);
}

function closeHud(player) {
  if (player.getPacketSender().isSubInterfaceOpen?.(data.hud.interface) === false) return;
  player.getPacketSender().closeSubInterface(OVERLAY_HUD_UID);
}

/** The portal overlay the statues and a kill show (gotr_overlay with its colours). */
function portal(player, colours) {
  const { portal: spec } = data;
  player.getPacketSender().sendSubInterface(OVERLAY_ATMOSPHERE_UID, spec.interface, 1, {
    postScripts: [{ scriptId: spec.script, args: colours }],
  });
  sound(player, spec.sound);
}

function closePortal(player) {
  player.getPacketSender().sendClientScript(data.portal.removeScript);
  player.getPacketSender().closeSubInterface(OVERLAY_ATMOSPHERE_UID);
}

/** A track by its id: unlocked (with its message) and played. */
function playMusic(player, trackId) {
  api.emitCustomEvent("music:unlock-track", { player, trackId });
  player.getPacketSender().sendSong(trackId);
}

// ------------------------------------------------------------------ the dead Moons

const deadMask = (player) => Math.max(0, Math.trunc(Number(player.getAttribute(DEAD_ATTRIBUTE)) || 0));
const isDead = (player, moon) => (deadMask(player) & DEAD_BIT[moon]) !== 0;

function setDead(player, moon, dead) {
  const mask = dead ? deadMask(player) | DEAD_BIT[moon] : deadMask(player) & ~DEAD_BIT[moon];
  player.setAttribute(DEAD_ATTRIBUTE, mask);
  player.getPacketSender().sendVarbit(data.moons[moon].deadVarbit, dead ? 1 : 0);
}

function sendDead(player) {
  for (const moon of MOONS) player.getPacketSender().sendVarbit(data.moons[moon].deadVarbit, isDead(player, moon) ? 1 : 0);
}

/** Whether the player can still be hit (not dying, not gone). */
const alive = (player) => player.isRegistered() && player.getHitpoints() > 0 && !player.isDyingReturn?.();

module.exports = {
  init, later, randomInt, pick,
  tileAt, offsetOf, location, onGlyph,
  varbit, graphic, tileGraphic, animate, sound, sounds, areaSound,
  personalLoc, addLoc, removeLoc, locAnim, projectile,
  openHud, closeHud, portal, closePortal, playMusic,
  deadMask, isDead, setDead, sendDead, alive,
  MOONS, DEAD_ATTRIBUTE, INSIDE_ATTRIBUTE, NO_WARNING_ATTRIBUTE,
  get api() { return api; },
  get core() { return core; },
  get data() { return data; },
};
