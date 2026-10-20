/**
 * One Hueycoatl fight: the public one on the world map, or a private one in an instance that
 * copies the camp and the arena (meeting flag). A session maps the captured world tiles into
 * its space (tile()), keeps the locs it changed, spawns its NPCs and sends graphics, loc
 * animations and sounds to everyone who can see it.
 */
const Shared = require("./Shared.Hueycoatl");

/** Players further than this from the arena's middle don't see the public fight's effects. */
const VIEW_DISTANCE = 40;
const ARENA_MIDDLE = [1515, 3280];

let core = null;

class Session {
  /** `area` is the private instance, or null for the public fight on the world map. */
  constructor(area, owner = null, kind = "public") {
    this.area = area;
    this.owner = owner;
    this.kind = kind;
    this.dx = area ? area.getBaseX() - Shared.INSTANCE_SOURCE_CHUNK.x * 8 : 0;
    this.dy = area ? area.getBaseY() - Shared.INSTANCE_SOURCE_CHUNK.y * 8 : 0;
    /** Everyone in the fight's space: the arena, and for a private fight its camp too. */
    this.members = new Set();
    /** The locs this fight replaced, by tile and shape. */
    this.locs = new Map();
    this.npcs = new Set();
    this.lobby = [];
    this.fight = null;
  }

  /** Runs `action` `ticks` ticks into the current fight; dropped if it resets first. A tagged
   * event can be dropped on its own (the whole tail's cycle, when it breaks). */
  schedule(ticks, action, tag = null) {
    const { fight } = this;
    if (!fight) return;
    fight.events.push({ at: core.World.getProcessCycle() + Math.max(1, ticks), action, generation: fight.generation, tag });
  }

  isPrivate() {
    return this.area != null;
  }

  /** The session's tile for a captured world tile. */
  tile([x, y], z = 0) {
    return new core.Location(x + this.dx, y + this.dy, z);
  }

  /** The captured world tile a session tile copies. */
  authored(location) {
    return [location.getX() - this.dx, location.getY() - this.dy];
  }

  /** True when an entity stands in the arena (beyond the chain). */
  inArena(entity) {
    const at = entity?.getLocation();
    if (!at || at.getZ() !== 0 || entity.getPrivateArea?.() !== this.area) return false;
    const [x, y] = this.authored(at);
    return Shared.ARENA_BOUNDS.some((bounds) => Shared.within(bounds, x, y));
  }

  inBounds(entity, bounds) {
    const at = entity?.getLocation();
    if (!at || entity.getPrivateArea?.() !== this.area) return false;
    const [x, y] = this.authored(at);
    return Shared.within(bounds, x, y);
  }

  /** The living players in the arena: the team (Wiki: everyone there counts). */
  arenaPlayers() {
    return [...this.members].filter((player) => player.isRegistered() && this.inArena(player));
  }

  /** Everyone who can see the fight: the instance, or players near the public arena. */
  viewers() {
    if (this.area) return [...this.members].filter((player) => player.isRegistered());
    const middle = this.tile(ARENA_MIDDLE);
    const list = [];
    core.World.forEachNetworkPlayer((player) => {
      if (player.getPrivateArea() == null && player.getLocation().getDistance(middle) <= VIEW_DISTANCE) list.push(player);
    });
    return list;
  }

  /** The loc of a shape on a session tile now: one this fight placed, else the map's. */
  currentLoc(location, shape) {
    const key = `${location.getX()},${location.getY()},${shape}`;
    if (this.locs.has(key)) return this.locs.get(key);
    if (this.area) return this.area.getTemplateObject(location, shape);
    return core.MapObjects.getType(location, shape, null);
  }

  /** Puts loc `id` (or nothing, for null) on a captured tile, replacing what is there. */
  setLoc(tile, shape, rotation, id) {
    const location = this.tile(tile);
    const key = `${location.getX()},${location.getY()},${shape}`;
    const current = this.currentLoc(location, shape);
    if (current && id != null && current.getId() === id && current.getFace() === rotation) return current;
    if (current) {
      core.ObjectManager.deregister(current, true);
      this.area?.detach?.(current);
    }
    if (id == null) {
      this.locs.set(key, null);
      return null;
    }
    const object = new core.GameObject(id, location, shape, rotation, this.area);
    core.ObjectManager.register(object, true);
    if (this.area) this.area.add(object);
    this.locs.set(key, object);
    return object;
  }

  animateLoc(tile, shape, animation) {
    const object = this.currentLoc(this.tile(tile), shape);
    if (!object) return;
    const anim = new core.Animation(animation);
    for (const viewer of this.viewers()) viewer.getPacketSender().sendObjectAnimation(object, anim);
  }

  /** A graphic on a captured tile, `delay` client cycles in. */
  graphic(tile, id, delay = 0, viewers = this.viewers()) {
    const graphic = new core.Graphic(id);
    graphic.delay = delay;
    graphic.height = 0;
    const location = this.tile(tile);
    for (const viewer of viewers) viewer.getPacketSender().sendGraphic(graphic, location);
  }

  /** An area sound on a captured tile, heard within `radius` tiles. */
  sound(tile, id, { delay = 0, radius = 10, loops = 1 } = {}) {
    const [x, y] = tile;
    for (const viewer of this.viewers()) {
      viewer.getPacketSender().sendAreaSound(id, x + this.dx, y + this.dy, 0, loops, delay, radius);
    }
  }

  spawnNpc(id, tile, { radius = 0, face = null } = {}) {
    const npc = core.NPC.create(id, this.tile(tile));
    npc.__skipDefaultRespawn = true;
    npc.getMovementCoordinator().setRadius(radius);
    if (face) npc.setPositionToFace(this.tile(face));
    npc.setAttribute(Shared.SESSION_ATTRIBUTE, this);
    if (this.area) this.area.add(npc);
    core.World.getAddNPCQueue().push(npc);
    this.npcs.add(npc);
    return npc;
  }

  removeNpc(npc) {
    if (!npc) return;
    this.npcs.delete(npc);
    const addQueue = core.World.getAddNPCQueue();
    for (let index = addQueue.indexOf(npc); index !== -1; index = addQueue.indexOf(npc)) addQueue.splice(index, 1);
    if (npc.isRegistered() && !core.World.getRemoveNPCQueue().includes(npc)) core.World.getRemoveNPCQueue().push(npc);
  }

  /** Puts back every loc the fight changed and takes its NPCs away (an instance's end). */
  dispose() {
    for (const npc of [...this.npcs]) this.removeNpc(npc);
    for (const npc of this.lobby) this.removeNpc(npc);
    for (const object of this.locs.values()) {
      if (object) core.ObjectManager.deregister(object, true);
    }
    this.locs.clear();
  }
}

function init(pluginApi) {
  core = pluginApi.core;
}

module.exports = { Session, init };
