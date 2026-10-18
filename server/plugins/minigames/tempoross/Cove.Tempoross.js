"use strict";

/**
 * One trip to Tempoross Cove: a copy of the cove's map squares (all four planes), the NPCs the
 * captures spawn there, and the players aboard. The fight itself is Fight.Tempoross.js; this
 * holds the place and what everyone in it sees.
 *
 * Tiles in DATA are template tiles; `tile()` turns one into the instance's copy and
 * `templateTile()` turns it back.
 */

const Shared = require("./Shared.Tempoross");

const { DATA, ITEM, VARBIT, CHUNK } = Shared;

/** player -> their cove while they are in one. */
const coves = new Map();
const INSIDE_ATTRIBUTE = "tempoross:inside";

let AreaClass = null;

function areaClass() {
  if (AreaClass) return AreaClass;
  AreaClass = class TemporossCove extends Shared.core().TemplatedInstanceArea {
    constructor() {
      super(DATA.cove.chunks, DATA.cove.chunks);
      this.cove = null;
    }

    getName() {
      return "Tempoross Cove";
    }

    /** Nothing here is fought with weapons: Tempoross takes no hits but cannon fire. */
    canAttack() {
      return false;
    }

    allowSummonPet() {
      return true;
    }

    destroy() {
      if (this.isDestroyed()) return;
      for (const entity of [...this.entities]) {
        if (!entity.isNpc?.()) continue;
        this.detach(entity);
        Shared.api().removeNpc(entity);
      }
      super.destroy();
    }

    postLeave(mobile, logout) {
      const player = mobile.isPlayer?.() ? mobile.getAsPlayer() : null;
      if (player && this.cove?.players.has(player)) this.cove.left(player, logout);
      super.postLeave(mobile, logout);
    }
  };
  return AreaClass;
}

class Cove {
  constructor() {
    this.area = new (areaClass())();
    this.area.cove = this;
    const { sourceChunkX, sourceChunkY, chunks, planes } = DATA.cove;
    for (let plane = 0; plane < planes; plane++) {
      this.area.copySquare(chunks, sourceChunkX, sourceChunkY, plane, 0, 0, plane, 0);
    }
    this.players = new Set();
    /** Everyone who sailed out, for the hosts' chatter and the per-player scaling. */
    this.crew = 0;
    this.npcs = [];
    this.ended = false;
    this.fight = null;
  }

  // ------------------------------------------------------------------ tiles

  /** The instance's copy of a template tile. */
  tile([x, y, z = 0]) {
    const { sourceChunkX, sourceChunkY } = DATA.cove;
    return this.area.tile(x - sourceChunkX * CHUNK, y - sourceChunkY * CHUNK, z);
  }

  /** The template tile an instance tile copies. */
  templateTile(location) {
    const { sourceChunkX, sourceChunkY } = DATA.cove;
    return [
      location.getX() - this.area.getBaseX() + sourceChunkX * CHUNK,
      location.getY() - this.area.getBaseY() + sourceChunkY * CHUNK,
      location.getZ(),
    ];
  }

  inBox(box, location) {
    const [x, y] = this.templateTile(location);
    return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
  }

  contains(location) {
    return this.area.contains(location);
  }

  // ------------------------------------------------------------------ what everyone sees

  forEachPlayer(action) {
    for (const player of this.players) {
      if (player.isRegistered()) action(player);
    }
  }

  message(text) {
    this.forEachPlayer((player) => player.sendMessage(text));
  }

  jingle(id) {
    this.forEachPlayer((player) => player.getPacketSender().sendJingle(id, 0));
  }

  areaSound(id, location, radius = 10, delay = 0) {
    this.forEachPlayer((player) => player.getPacketSender().sendAreaSound(
      id, location.getX(), location.getY(), location.getZ(), 1, delay, radius,
    ));
  }

  sound(id) {
    this.forEachPlayer((player) => player.getPacketSender().sendSound(id, 100, 0));
  }

  locAnim(object, id) {
    const { Animation } = Shared.core();
    this.forEachPlayer((player) => player.getPacketSender().sendObjectAnimation(object, new Animation(id)));
  }

  mapGraphic(id, location, height = 0, delay = 0) {
    const graphic = Shared.makeGraphic(id, height, delay);
    this.forEachPlayer((player) => player.getPacketSender().sendGraphic(graphic, location));
  }

  /** A projectile between two tiles; `cycles` is its flight in client cycles (30 a tick). */
  projectile(gfx, from, to, { cycles = 100, startHeight = 0, endHeight = 0, slope = 0 } = {}) {
    this.forEachPlayer((player) => player.getPacketSender().sendProjectile(
      from, to, 0, cycles, gfx, startHeight, endHeight, null, 0, slope, 0,
    ));
  }

  /** A loc of our own on a template tile, put over whatever the template has there. */
  placeLoc(id, [x, y], { type = 10, face = 0 } = {}) {
    const { GameObject, ObjectManager } = Shared.core();
    const object = new GameObject(id, this.tile([x, y, 0]), type, face, this.area);
    ObjectManager.register(object, true);
    return object;
  }

  removeLoc(object) {
    if (!object) return;
    const { ObjectManager } = Shared.core();
    ObjectManager.deregister(object, true);
    this.area.detach(object);
  }

  /** The template's loc of this type on a template tile. */
  templateLoc([x, y], type = 10) {
    return this.area.getTemplateObject(this.tile([x, y, 0]), type);
  }

  /** Swaps a loc for another id where it stands (a broken mast, a fuller crate). */
  replaceLoc(object, id) {
    if (!object) return null;
    const { GameObject, ObjectManager } = Shared.core();
    if (this.area.getObjects().includes(object)) {
      ObjectManager.deregister(object, true);
      this.area.detach(object);
    }
    const next = new GameObject(id, object.getLocation(), object.getType(), object.getFace(), this.area);
    ObjectManager.register(next, true);
    return next;
  }

  spawnNpc(id, [x, y], { face = null } = {}) {
    const at = this.tile([x, y, 0]);
    const npc = Shared.api().spawnNpc({ id, x: at.getX(), y: at.getY(), z: at.getZ(), wanderRadius: 0 });
    if (!npc) return null;
    npc.__skipDefaultRespawn = true;
    npc.__temporossCove = this;
    npc.getMovementQueue().setBlockMovement(true).reset();
    if (face) npc.setPositionToFace(this.tile([face[0], face[1], 0]));
    this.area.add(npc);
    this.npcs.push(npc);
    return npc;
  }

  removeNpc(npc) {
    if (!npc) return;
    this.npcs = this.npcs.filter((other) => other !== npc);
    if (!npc.isRegistered?.()) return;
    this.area.detach(npc);
    Shared.api().removeNpc(npc);
  }

  // ------------------------------------------------------------------ players

  /** Puts a player aboard the west ship. */
  arrive(player, index) {
    coves.get(player)?.leave(player);
    coves.set(player, this);
    this.players.add(player);
    this.crew += 1;
    this.area.enter(player);
    const arrivals = DATA.cove.arrival;
    player.moveTo(this.tile([...arrivals[index % arrivals.length], 0]));
    player.setAttribute(INSIDE_ATTRIBUTE, true);
    player.getPacketSender().sendVarbit(VARBIT.POINTS, 0);
    player.getPacketSender().sendVarbit(VARBIT.TETHERED, 0);
  }

  /** Takes a player off the cove and back to the Ruins of Unkah's dock. */
  leave(player) {
    if (!this.players.has(player)) return;
    player.moveTo(Shared.loc(DATA.lobby.dockTile));
    if (this.players.has(player)) this.left(player, false);
  }

  /** The player is out of the cove (moved, teleported, logged out): tidy up after them. */
  left(player, logout) {
    if (!this.players.delete(player)) return;
    coves.delete(player);
    Shared.stopAction(player);
    this.fight?.onLeave(player);
    player.setAttribute(INSIDE_ATTRIBUTE, null);
    player.getPacketSender().sendVarbit(VARBIT.TETHERED, 0);
    player.getPacketSender().sendVarbit(VARBIT.POINTS, 0);
    dropCoveItems(player);
    if (logout) player.setLocation(Shared.loc(DATA.lobby.dockTile));
    if (this.players.size === 0) this.end();
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.fight?.stop();
    for (const player of [...this.players]) this.leave(player);
    for (const npc of [...this.npcs]) this.removeNpc(npc);
    if (!this.area.isDestroyed()) this.area.destroy();
  }
}

/** Harpoonfish never leave the cove (Wiki). */
function dropCoveItems(player) {
  const inventory = player.getInventory();
  let removed = false;
  for (const id of [ITEM.RAW, ITEM.COOKED, ITEM.CRYSTALLISED]) {
    const amount = inventory.getAmount(id);
    if (amount <= 0) continue;
    inventory.delete(id, amount);
    removed = true;
  }
  if (removed) inventory.refreshItems();
}

const coveOf = (player) => coves.get(player) ?? null;
const coveOfNpc = (npc) => npc?.__temporossCove ?? null;

/** A player saved inside (the server stopped mid-fight) comes back on the Ruins of Unkah's dock. */
function recoverOnLogin({ player }) {
  if (!player.getAttribute(INSIDE_ATTRIBUTE) || coveOf(player)) return;
  player.setAttribute(INSIDE_ATTRIBUTE, null);
  player.moveTo(Shared.loc(DATA.lobby.dockTile));
  dropCoveItems(player);
}

function attachCove(api) {
  Shared.bind(api);
  api.persistAttribute(INSIDE_ATTRIBUTE);
  api.onPlayerLogin(recoverOnLogin);
}

module.exports = { Cove, coveOf, coveOfNpc, attachCove, INSIDE_ATTRIBUTE };
