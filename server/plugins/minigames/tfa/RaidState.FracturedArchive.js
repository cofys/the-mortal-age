"use strict";

/**
 * A raid in progress: the party, its private copy of the Archive, the room it has reached, the
 * HUD (tfa_hud, 974), deaths and spectating, wipes, abandoning and coming back after a logout.
 *
 * Captured (docs/fractured-archive.md):
 * - Entering: "You enter the Archive...", a fade, hpbar_hud_show_extra_bar 0, the move three
 *   ticks later, the fade back two after that and the HUD two after that: 974 on
 *   overlay_atmosphere, the names (10042), the timer (10036) and each slot's state.
 * - A death in a challenge: "You have died. Total deaths: N." (the others see the name), "You
 *   will respawn when your party completes or fails the challenge." while anyone still fights,
 *   then "Spectating the room..." at the room's corner, tfa_client_spectate_mode 1 and the side
 *   tabs back without the inventory and combat tabs. Items are kept.
 * - A wipe, two ticks after the last death: the boss bar cleared, "You failed to survive the
 *   Fractured Archive.", a fade and jingle 90; three ticks later everyone is in the lobby in
 *   front of the door, and their items went as a death would take them (a gravestone there).
 * - Abandoning by the exit: a warning, "Abandon the raid?", "You abandon the raid and leave the
 *   Fractured Archive.", a fade and the move three ticks later.
 * Estimates: who goes in first (the leader, as in the Theatre of Blood), teleports being blocked,
 * a logout in a challenge counting as a death, and what happens when a room is won.
 */

const Shared = require("./Shared.FracturedArchive");
const Parties = require("./Parties.FracturedArchive");

const { SCRIPT, SLOT, TILE, MUSIC } = Shared;

const ATTR_RAID = "fractured-archive:raid";
/** Saved: the raid a player logged out of, and whether they were in a challenge. */
const ATTR_LOGOUT = "fractured-archive:logout";
/** Saved: total deaths, for "Total deaths: N." (it counts across raids on live). */
const ATTR_DEATHS = "fractured-archive:deaths";

/** Captured timings, in ticks. */
const ENTER_MOVE_DELAY = 3;
const ENTER_FADE_IN_DELAY = 5;
const ENTER_HUD_DELAY = 7;
const WIPE_DELAY = 2;
const WIPE_MOVE_DELAY = 3;
const LEAVE_MOVE_DELAY = 3;

const STAGE = { IDLE: "idle", STARTED: "started", COMPLETED: "completed" };

const raids = new Map();
const roomTypes = new Map();
let nextRaidId = 1;
let AreaClass = null;

function registerRoom(key, RoomClass) {
  roomTypes.set(key, RoomClass);
}

function raidOf(player) {
  const raid = player?.getAttribute?.(ATTR_RAID);
  return raid && raids.get(raid.id) === raid ? raid : null;
}

function areaClass() {
  if (AreaClass) return AreaClass;
  const { PrivateArea, Boundary } = Shared.core();
  const { ARCHIVE, ARCHIVE_PLANES } = Shared;
  AreaClass = class FracturedArchiveArea extends PrivateArea {
    constructor(raid) {
      super(ARCHIVE_PLANES.map((z) => new Boundary(ARCHIVE.minX, ARCHIVE.maxX, ARCHIVE.minY, ARCHIVE.maxY, z)));
      this.raid = raid;
    }

    getName() {
      return "The Fractured Archive";
    }

    isMulti() {
      return true;
    }

    allowSummonPet() {
      return false;
    }

    postLeave(mobile, logout) {
      if (mobile.isPlayer?.()) this.raid.onAreaLeave(mobile.getAsPlayer(), logout);
      super.postLeave(mobile, logout);
    }

    process() {
      this.raid.processOnce();
    }

    canTeleport(player) {
      Shared.mesbox(player, "You can't teleport out of the Archive.");
      return false;
    }

    /** Spectators and a room's scripted NPCs take no part in the fighting; then the room decides. */
    canAttack(attacker, target, method) {
      if (attacker?.__tfaScripted) return false;
      if (attacker?.isPlayer?.() && this.raid.member(attacker)?.dead) return false;
      if (target?.isPlayer?.() && this.raid.member(target)?.dead) return false;
      return this.raid.room?.canAttack?.(attacker, target, method) ?? null;
    }
  };
  return AreaClass;
}

class Member {
  constructor() {
    /** The room the player is in, or null while still on their way in. */
    this.roomKey = null;
    /** In the challenge since it started (the dead watch until it ends). */
    this.fighting = false;
    this.dead = false;
    /** The party slot spectated (0-7), or -1 for the room. */
    this.spectating = -1;
    this.hud = new Map();
    this.hudOpen = false;
    /** The raid's attempt counted in the records (on the first arrival). */
    this.counted = false;
  }
}

// ---------------------------------------------------------------- rooms

/** Shared room behaviour: the challenge's stage, its NPCs and locs, deaths, cleanup. */
class Room {
  constructor(raid, def) {
    this.raid = raid;
    this.def = def;
    this.stage = STAGE.IDLE;
    this.npcs = new Set();
    this.objects = [];
    this.taskKey = {};
    this.startCycle = 0;
    this.destroyed = false;
  }

  get key() {
    return this.def.key;
  }

  get area() {
    return this.raid.area;
  }

  isStarted() {
    return this.stage === STAGE.STARTED;
  }

  isCompleted() {
    return this.stage === STAGE.COMPLETED;
  }

  /** Called once when the party reaches the room. */
  build() {
    this.onBuild();
  }

  onBuild() {}

  onStart() {}

  onComplete() {}

  tick() {}

  later(ticks, action) {
    return Shared.later(this.taskKey, ticks, () => {
      if (!this.destroyed) action();
    });
  }

  repeat(ticks, action) {
    return Shared.repeat(this.taskKey, ticks, () => !this.destroyed && action() !== false);
  }

  placeObject(objectId, tile, type = 10, face = 0) {
    const { GameObject, ObjectManager } = Shared.core();
    const object = new GameObject(objectId, Shared.loc(tile), type, face, this.area);
    ObjectManager.register(object, true);
    this.objects.push(object);
    return object;
  }

  removeObject(object) {
    if (!object) return;
    Shared.core().ObjectManager.deregister(object, true);
    this.objects = this.objects.filter((other) => other !== object);
  }

  /** Swaps a placed loc for another on the same tile (a mushroom growing, a door). */
  replaceObject(object, objectId) {
    const location = object.getLocation();
    const tile = { x: location.getX(), y: location.getY(), z: location.getZ() };
    this.removeObject(object);
    return this.placeObject(objectId, tile, object.getType(), object.getFace());
  }

  /** Spawns one of the room's NPCs. `scripted` NPCs move and attack only as the room drives them. */
  spawn(npcId, tile, { face, scripted = false } = {}) {
    const npc = Shared.api().spawnNpc({ id: npcId, x: tile.x, y: tile.y, z: tile.z ?? 0, wanderRadius: 0, face });
    if (!npc) return null;
    npc.__skipDefaultRespawn = true;
    npc.__tfaRoom = this;
    if (scripted) {
      npc.__tfaScripted = true;
      npc.setScriptedMovement?.(true);
      npc.setFlag?.("combat:no-retaliate");
      // Its hitpoints are the room's to keep (the Guardian's shield and health).
      npc.setFlag?.("combat:no-regen");
    }
    this.area.add(npc);
    this.npcs.add(npc);
    return npc;
  }

  despawn(npc) {
    if (!npc) return;
    this.npcs.delete(npc);
    this.area.detach(npc);
    Shared.api().removeNpc(npc);
  }

  /** Party members in this room, alive, who are taking part in the challenge. */
  fighters() {
    return this.raid.players.filter((player) => {
      const member = this.raid.member(player);
      return member.roomKey === this.key && member.fighting && !member.dead && player.getHitpoints() > 0;
    });
  }

  roomPlayers() {
    return this.raid.players.filter((player) => this.raid.member(player).roomKey === this.key);
  }

  /** The challenge starts for everyone in the room. */
  start() {
    if (this.stage !== STAGE.IDLE) return;
    this.stage = STAGE.STARTED;
    this.startCycle = Shared.cycle();
    for (const player of this.roomPlayers()) {
      this.raid.member(player).fighting = true;
      player.sendMessage(`Challenge started: ${this.def.name}.`);
    }
    this.raid.challengeStarted(this);
    this.onStart();
  }

  /** The challenge is won: the dead get up and the room's own end runs (estimates). */
  complete() {
    if (this.stage !== STAGE.STARTED) return;
    this.stage = STAGE.COMPLETED;
    const raid = this.raid;
    raid.challengeEnded(this);
    for (const player of this.roomPlayers()) {
      const member = raid.member(player);
      member.fighting = false;
      player.sendMessage(`Challenge complete: ${this.def.name}.`);
      if (member.dead) raid.respawn(player, this);
    }
    this.onComplete();
    Shared.api().emitCustomEvent("fractured-archive:room-complete", { raid, room: this.key, players: [...raid.players] });
  }

  /** The challenge is lost: the room goes quiet (the raid moves everyone out). */
  fail() {
    this.stage = STAGE.COMPLETED;
    Shared.core().TaskManager.cancelTasks(this.taskKey);
    this.onFail?.();
  }

  // ---------------------------------------------------------------- combat helpers

  /**
   * A boss attack in one style: accuracy rolled (unless `accurate`), damage up to `maxHit`.
   * The matching protection prayer lets `prayerMultiplier` of it through (none by default);
   * `prayable: false` ignores prayer.
   */
  styledHit(npc, target, style, maxHit, delay, { accurate = false, prayerMultiplier = 0, prayable = true } = {}) {
    const { PendingHit, CombatFactory } = Shared.core();
    const hit = new PendingHit(npc, target, styleMethod(style), { delay, rollAccuracy: !accurate });
    CombatFactory.applyStyleDamage(hit, Math.max(0, Math.floor(maxHit)), { bypassProtectionPrayer: true });
    if (prayable && target.isPlayer?.() && Shared.isProtected(target, style)) {
      for (const part of hit.getHits()) part.setDamage(Math.floor(part.getDamage() * prayerMultiplier));
      hit.updateTotalDamage();
    }
    return hit;
  }

  /** Queues a styled hit on a player, for attacks outside the boss's own combat swing. */
  strike(npc, player, style, maxHit, delay, options) {
    const hit = this.styledHit(npc, player, style, maxHit, delay, options);
    player.getCombat().getHitQueue().addPendingHit(hit, Shared.cycle() + Math.max(0, delay));
    return hit;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    Shared.core().TaskManager.cancelTasks(this.taskKey);
    for (const npc of [...this.npcs]) this.despawn(npc);
    const { ObjectManager } = Shared.core();
    for (const object of this.objects) ObjectManager.deregister(object, true);
    this.objects = [];
  }
}

// ---------------------------------------------------------------- the raid

class Raid {
  constructor(party, leader) {
    this.id = nextRaidId++;
    this.party = party;
    party.raid = this;
    /** The client's tfa_mycontroller while inside (an opaque number on live). */
    this.controller = 0x3000000 + this.id;
    this.players = [];
    this.members = new Map();
    /** Members who logged out, by username: { fight }. */
    this.away = new Map();
    /** The party when the leader went in: the HUD keeps their slots. */
    this.roster = [...party.members];
    this.area = new (areaClass())(this);
    this.room = null;
    /** The challenge timer (10036): when the current challenge started, or -1 before one. */
    this.timerStart = -1;
    this.timerStopped = 0;
    this.lastCycle = -1;
    this.over = false;
    // Only the leader is in; the others join as they go through the door themselves.
    this.add(leader);
    raids.set(this.id, this);
  }

  member(player) {
    let member = this.members.get(player);
    if (!member) {
      member = new Member();
      this.members.set(player, member);
    }
    return member;
  }

  hasMember(player) {
    return this.players.includes(player);
  }

  /** Members still outside can go in until the room's challenge is started (estimate of when). */
  canJoin() {
    return !this.over && (!this.room || this.room.stage === STAGE.IDLE);
  }

  add(player) {
    if (!this.players.includes(player)) this.players.push(player);
    player.setAttribute(ATTR_RAID, this);
    this.member(player);
  }

  buildRoom(key) {
    const RoomClass = roomTypes.get(key) ?? Room;
    this.room?.destroy();
    this.room = new RoomClass(this, ROOMS[key]);
    this.room.build();
    return this.room;
  }

  /** In through the Archive Door: the fade, then the Archive (all timings captured). */
  enter(player) {
    if (!this.players.includes(player)) {
      if (!this.party.has(player) || !this.canJoin()) return false;
      this.add(player);
    }
    if (this.member(player).roomKey) return false;
    if (!this.room) this.buildRoom("GUARDIAN");
    const sender = player.getPacketSender();
    sender.sendConfig(Shared.id("varp", "SHOW_EXTRA_BAR"), 0);
    player.sendMessage("You enter the Archive...");
    Shared.api().emitCustomEvent("fractured-archive:miniquest-stage", { player, stage: 4 });
    sender.closeSubInterface(Shared.id("component", "OVERLAY_HUD"));
    Shared.fade(player, true);
    Shared.api().emitCustomEvent("boss-hud:reset", { player });
    player.getMovementQueue().reset().setBlockMovement(true);
    Shared.later(player, ENTER_MOVE_DELAY, () => this.arrive(player, this.room));
    return true;
  }

  arrive(player, room) {
    if (this.over || !this.players.includes(player)) return;
    const member = this.member(player);
    if (player.getArea?.() !== this.area) this.area.enter(player);
    player.getMovementQueue().setBlockMovement(false);
    player.moveTo(Shared.loc(room.def.arrival));
    if (!member.counted) {
      member.counted = true;
      record(player, "overall", "attempts");
    }
    member.roomKey = room.key;
    player.getPacketSender().sendConfig(Shared.id("varp", "CONTROLLER"), this.controller);
    player.getPacketSender().sendClientScript(SCRIPT.RAID_ENTER);
    Shared.later(player, ENTER_FADE_IN_DELAY - ENTER_MOVE_DELAY, () => {
      if (!this.players.includes(player)) return;
      Shared.fade(player, false);
      player.getPacketSender().sendSong(MUSIC.IN_RAID);
    });
    Shared.later(player, ENTER_HUD_DELAY - ENTER_MOVE_DELAY, () => {
      if (this.players.includes(player)) this.openHud(player);
    });
    room.onArrive?.(player);
    this.refreshPartyStatus();
  }

  // ---------------------------------------------------------------- tick

  processOnce() {
    const now = Shared.cycle();
    if (now === this.lastCycle || this.over) return;
    this.lastCycle = now;
    if (this.room && !this.room.destroyed) this.room.tick();
    this.sendTimer();
    this.refreshStatuses();
  }

  // ---------------------------------------------------------------- HUD

  slotOf(player) {
    return this.roster.findIndex((other) => other.getUsername() === player.getUsername());
  }

  /** tfa_hud (974): the eight names, the viewer's slot (1-based), the timer and the slots. */
  openHud(player) {
    const sender = player.getPacketSender();
    const member = this.member(player);
    sender.sendSubInterface(Shared.id("component", "OVERLAY_ATMOSPHERE"), Shared.id("iface", "HUD"), 1);
    sender.sendVarbit(Shared.id("varbit", "PARTY_SLOT"), this.slotOf(player) + 1);
    const names = Array.from({ length: Shared.MAX_PARTY_SIZE }, (_, i) => (this.roster[i] ? Shared.displayName(this.roster[i]) : ""));
    sender.sendClientScript(SCRIPT.HUD_NAMES, ...names);
    member.hud.clear();
    member.hudOpen = true;
    this.sendTimer(player);
    this.refreshStatuses();
  }

  closeHud(player) {
    const sender = player.getPacketSender();
    const member = this.members.get(player);
    if (member) member.hudOpen = false;
    sender.closeSubInterface(Shared.id("component", "OVERLAY_ATMOSPHERE"));
    sender.sendVarbit(Shared.id("varbit", "PARTY_SLOT"), 0);
    sender.sendVarbit(Shared.id("varbit", "SPECTATE_MODE"), 0);
    sender.sendVarbit(Shared.id("varbit", "SPECTATE_SLOT"), 0);
    for (const varbit of Shared.ids().varbit.SLOTS) sender.sendVarbit(varbit, 0);
  }

  /** 10036: (ticks, 1) before and between challenges (frozen), (ticks, 0) while one runs. */
  sendTimer(only) {
    const running = this.timerStart >= 0 && this.room?.isStarted();
    const ticks = running ? Shared.cycle() - this.timerStart : this.timerStopped;
    for (const player of only ? [only] : this.players) {
      if (!this.member(player).hudOpen) continue;
      player.getPacketSender().sendClientScript(SCRIPT.HUD_TIMER, ticks, running ? 0 : 1);
    }
  }

  challengeStarted() {
    this.timerStart = Shared.cycle();
    this.refreshPartyStatus();
  }

  challengeEnded() {
    this.timerStopped = Math.max(0, Shared.cycle() - this.timerStart);
    this.timerStart = -1;
  }

  /** A slot: 1-27 health, 30 dead, 31 not in the room (ToB's scale; the HUD script reads it so). */
  statusOf(player) {
    const member = this.members.get(player);
    if (!member || !this.room || member.roomKey !== this.room.key) return SLOT.AWAY;
    if (member.dead || player.getHitpoints() <= 0) return SLOT.DEAD;
    const { Skill } = Shared.core();
    const max = Math.max(1, player.getSkillManager().getMaxLevel(Skill.HITPOINTS));
    const current = Math.min(max, player.getHitpoints());
    return 1 + Math.round((SLOT.HEALTH_MAX - 1) * (current / max));
  }

  refreshStatuses() {
    const statuses = Array.from({ length: Shared.MAX_PARTY_SIZE }, (_, i) => {
      const player = this.roster[i];
      if (!player) return SLOT.EMPTY;
      const live = this.players.find((other) => other.getUsername() === player.getUsername());
      return live ? this.statusOf(live) : SLOT.AWAY;
    });
    const varbits = Shared.ids().varbit.SLOTS;
    for (const viewer of this.players) {
      const member = this.member(viewer);
      if (!member.hudOpen) continue;
      statuses.forEach((status, i) => {
        if (member.hud.get(i) === status) return;
        member.hud.set(i, status);
        viewer.getPacketSender().sendVarbit(varbits[i], status);
      });
    }
  }

  /** The lobby overlay's "Step Inside Now!" for members not in yet, while they still can. */
  refreshPartyStatus() {
    for (const player of this.party.members) {
      if (this.hasMember(player)) continue;
      player.getPacketSender().sendVarbit(Shared.id("varbit", "PARTY_STATUS"), this.canJoin() ? 2 : 1);
    }
  }

  /** A member who never came in left the party: their HUD slot goes. */
  dropFromRoster(player) {
    this.roster = this.roster.filter((other) => other.getUsername() !== player.getUsername());
    for (const other of this.players) if (this.member(other).hudOpen) this.openHud(other);
  }

  // ---------------------------------------------------------------- deaths

  /**
   * A death in the Archive. In a challenge that isn't won, the player watches from the corner
   * until it ends; otherwise they get up at the room's entrance.
   */
  onPlayerDied(player) {
    const member = this.member(player);
    const room = this.room;
    const deaths = (Number(player.getAttribute(ATTR_DEATHS)) || 0) + 1;
    player.setAttribute(ATTR_DEATHS, deaths);
    record(player, "overall", "deaths");
    if (room && member.roomKey === room.key) record(player, room.key, "deaths");
    player.sendMessage(`You have died. Total deaths: <col=ff0000>${deaths}</col>.`);
    for (const other of this.players) {
      if (other !== player) other.sendMessage(`<col=ff0000>${Shared.displayName(player)}</col> has died. Total deaths: <col=ff0000>${deaths}</col>.`);
    }
    if (!room || member.roomKey !== room.key || !room.isStarted() || !member.fighting) {
      player.moveTo(Shared.loc(room?.def.arrival ?? TILE.RAID_ARRIVAL));
      return;
    }
    member.dead = true;
    if (room.fighters().length > 0) player.sendMessage("You will respawn when your party completes or fails the challenge.");
    this.spectate(player, room);
    this.checkWipe();
  }

  /** At the room's corner, out of the fight, with the inventory and combat tabs closed. */
  spectate(player, room) {
    const member = this.member(player);
    member.spectating = -1;
    player.sendMessage("Spectating the room. Click a fighting player's health display to spectate them.");
    player.moveTo(Shared.loc(room.def.spectate ?? TILE.SPECTATE));
    player.getMovementQueue().setBlockMovement(true).reset();
    player.setUntargetable(true);
    player.getCombat().reset();
    const sender = player.getPacketSender();
    sender.sendVarbit(Shared.id("varbit", "SPECTATE_MODE"), 1);
    sender.sendVarbit(Shared.id("varbit", "SPECTATE_SLOT"), 0);
    sender.closeSubInterface(Shared.id("component", "SIDE_INVENTORY"));
    sender.closeSubInterface(Shared.id("component", "SIDE_COMBAT"));
    Shared.api().emitCustomEvent("boss-hud:hide", { player, fade: false, afterTicks: 0 });
  }

  /** The HUD's "Spectate" on a slot (0-7), or the whole room (-1). */
  spectateSlot(player, slot) {
    const member = this.member(player);
    if (!member.dead) return;
    const sender = player.getPacketSender();
    const target = slot >= 0 ? this.players.find((other) => other.getUsername() === this.roster[slot]?.getUsername()) : null;
    if (!target || this.member(target).dead) {
      member.spectating = -1;
      sender.sendVarbit(Shared.id("varbit", "SPECTATE_SLOT"), 0);
      player.sendMessage("Spectating the room. Click a fighting player's health display to spectate them.");
      sender.closeSubInterface(Shared.id("component", "SIDE_INVENTORY"));
      return;
    }
    member.spectating = slot;
    sender.sendVarbit(Shared.id("varbit", "SPECTATE_SLOT"), slot + 1);
    player.sendMessage(`Spectating ${Shared.displayName(target)}. Click a fighting player's health display to spectate them.`);
    this.sendSpectatedInventory(player, target);
    const items = Shared.id("component", "SPECTATE_ITEMS");
    sender.sendSubInterface(Shared.id("component", "SIDE_INVENTORY"), Shared.id("iface", "SPECTATE_INVENTORY"), 1);
    // interface_invother_init: the spectated inventory (93, sent as another's), 4x7, "Ping".
    sender.sendClientScript(INVOTHER_INIT_SCRIPT, items, INVENTORY_INV, 4, 7, 0, -1, "Ping<col=ff9040>", "", "", "", "", 1);
    sender.sendInterfaceFlagsRange(items, 0, 27, (1 << 1) | (1 << 10));
  }

  /** The spectated player's inventory, as "another's" inventory (93 + 32768), as captured. */
  sendSpectatedInventory(viewer, target) {
    const items = target.getInventory().getItems();
    const slots = Array.from({ length: 28 }, (_, slot) => {
      const item = items[slot];
      return item && item.getId() > 0 && item.getAmount() > 0 ? { id: item.getId(), amount: item.getAmount() } : null;
    });
    viewer.getPacketSender().sendInventory(INVENTORY_INV + OTHER_INVENTORY, 28, slots);
  }

  /** Back on their feet at the room's entrance once the challenge is won. */
  respawn(player, room) {
    const member = this.member(player);
    member.dead = false;
    member.spectating = -1;
    restoreTabs(player);
    player.getMovementQueue().setBlockMovement(false);
    player.setUntargetable(false);
    player.getPacketSender().sendVarbit(Shared.id("varbit", "SPECTATE_MODE"), 0).sendVarbit(Shared.id("varbit", "SPECTATE_SLOT"), 0);
    player.moveTo(Shared.loc(room.def.arrival));
  }

  /** The raid fails once nobody in the challenge is standing. */
  checkWipe() {
    const room = this.room;
    if (this.over || !room?.isStarted()) return;
    if (room.fighters().length > 0) return;
    Shared.later(this, WIPE_DELAY, () => {
      if (!this.over && this.room === room && room.isStarted() && room.fighters().length === 0) this.fail();
    });
  }

  /** Everyone back in the lobby, their items lost as a death would take them (captured). */
  fail() {
    if (this.over) return;
    this.room?.fail();
    const players = [...this.players];
    for (const player of players) {
      Shared.api().emitCustomEvent("boss-hud:hide", { player, fade: false, afterTicks: 0 });
      player.sendMessage("You failed to survive the Fractured Archive.");
      Shared.fade(player, true);
      player.getPacketSender().sendSong(MUSIC.IN_RAID).sendJingle(MUSIC.FAILED_JINGLE, 0);
    }
    Shared.later(this, WIPE_MOVE_DELAY, () => {
      for (const player of players) {
        if (!this.players.includes(player)) continue;
        const fought = this.member(player).fighting;
        record(player, "overall", "wipes");
        record(player, "overall", "failures");
        this.remove(player);
        if (player.getArea?.() === this.area) this.area.leave(player, false);
        player.moveTo(Shared.loc(TILE.WIPE_RETURN));
        if (fought) Shared.core().PlayerDeathTask.loseItemsAsDeath(player, Shared.loc(TILE.WIPE_RETURN));
        Shared.fade(player, false);
      }
      this.dispose();
    });
  }

  // ---------------------------------------------------------------- leaving

  /** "Yes, abandon the raid.": out to the lobby; there's no coming back to this run. */
  abandon(player) {
    if (!this.players.includes(player)) return;
    player.sendMessage("You abandon the raid and leave the Fractured Archive.");
    record(player, "overall", "failures");
    Shared.fade(player, true);
    player.getMovementQueue().reset().setBlockMovement(true);
    Shared.later(player, LEAVE_MOVE_DELAY, () => {
      player.getMovementQueue().setBlockMovement(false);
      if (!this.players.includes(player)) return;
      this.remove(player);
      if (player.getArea?.() === this.area) this.area.leave(player, false);
      player.moveTo(Shared.loc(TILE.LEAVE));
      Shared.fade(player, false);
      player.getPacketSender().sendSong(MUSIC.INTO_THE_ARCHIVE);
    });
  }

  /** Takes a player out of the raid and their party. */
  remove(player) {
    const member = this.members.get(player);
    if (member?.dead) {
      player.getMovementQueue().setBlockMovement(false);
      player.setUntargetable(false);
      restoreTabs(player);
    }
    this.players = this.players.filter((other) => other !== player);
    this.members.delete(player);
    player.setAttribute(ATTR_RAID, null);
    player.setAttribute(ATTR_LOGOUT, null);
    this.closeHud(player);
    player.getPacketSender().sendConfig(Shared.id("varp", "CONTROLLER"), -1);
    Shared.api().emitCustomEvent("boss-hud:hide", { player, fade: false, afterTicks: 0 });
    this.party.remove(player);
    // Nobody left inside: the raid ends; anyone logged out finds no party when they return.
    if (this.players.length === 0) this.dispose();
    else this.checkWipe();
  }

  onAreaLeave(player, logout) {
    if (!this.players.includes(player)) return;
    if (logout) this.onLogout(player);
  }

  /** A logout in a challenge counts as a death (estimate, as the Theatre of Blood); else it's safe. */
  onLogout(player) {
    const member = this.member(player);
    const fight = !!this.room?.isStarted() && member.fighting && !member.dead;
    this.away.set(player.getUsername(), { fight: fight || member.dead });
    player.setAttribute(ATTR_LOGOUT, { raid: this.id, fight: fight || member.dead });
    this.players = this.players.filter((other) => other !== player);
    this.members.delete(player);
    player.setAttribute(ATTR_RAID, null);
    if (this.players.length === 0) {
      this.dispose();
      return;
    }
    this.checkWipe();
  }

  /** Back from a logout: into the party's room, watching if they fell. */
  rejoin(player) {
    const away = this.away.get(player.getUsername());
    if (!away || this.over) return false;
    this.away.delete(player.getUsername());
    player.setAttribute(ATTR_LOGOUT, null);
    this.add(player);
    this.party.members = this.party.members.map((other) => (other.getUsername() === player.getUsername() ? player : other));
    this.roster = this.roster.map((other) => (other.getUsername() === player.getUsername() ? player : other));
    this.area.enter(player);
    const room = this.room;
    const member = this.member(player);
    member.roomKey = room.key;
    if (away.fight && room?.isStarted()) {
      member.fighting = true;
      member.dead = true;
      this.spectate(player, room);
    } else {
      player.moveTo(Shared.loc(room.def.arrival));
    }
    this.openHud(player);
    return true;
  }

  dispose() {
    if (this.over) return;
    this.over = true;
    Shared.cancel(this);
    this.room?.destroy();
    this.room = null;
    if (!this.area.isDestroyed()) this.area.destroy();
    raids.delete(this.id);
    this.party.raid = null;
    this.party.dispose();
  }
}

/** Counts something in the player's Alliance records (Records.*). */
function record(player, category, field) {
  Shared.api().emitCustomEvent("fractured-archive:record", { player, category, field });
}

/** The inventory (93) and the flag the client reads an inventory as someone else's with. */
const INVENTORY_INV = 93;
const OTHER_INVENTORY = 32768;
/** interface_invother_init. */
const INVOTHER_INIT_SCRIPT = 158;

/** The inventory and combat tabs back after spectating. */
function restoreTabs(player) {
  const sender = player.getPacketSender();
  sender.sendSubInterface(Shared.id("component", "SIDE_INVENTORY"), Shared.id("iface", "INVENTORY"), 1);
  sender.sendTabInterface(0, Shared.id("iface", "COMBAT"));
  Shared.core().WeaponInterfaceManager.assign(player);
  player.getInventory().refreshItems();
}

/**
 * The rooms. Arrival and the spectator corner are captured for the Archive Guardian; the next
 * rooms come with their captures.
 */
const ROOMS = {
  GUARDIAN: {
    key: "GUARDIAN",
    name: "Archive Guardian",
    music: MUSIC.ARCHIVE_GUARDIAN,
    arrival: TILE.RAID_ARRIVAL,
    spectate: TILE.SPECTATE,
  },
};

/** The leader opens the Archive for the party. */
function begin(leader) {
  const party = Parties.partyOf(leader);
  if (!party) return null;
  if (party.raid) return party.raid;
  const raid = new Raid(party, leader);
  raid.refreshPartyStatus();
  return raid;
}

function byId(raidId) {
  return raids.get(raidId) ?? null;
}

const styleMethods = new Map();

/**
 * A bare combat method of one style, for scripted attacks that build their own hits: it only
 * tells the hit its style (protection prayers, hitsplats).
 */
function styleMethod(style) {
  let method = styleMethods.get(style);
  if (!method) {
    const { CombatMethod, CombatType } = Shared.core();
    const type = { melee: CombatType.MELEE, ranged: CombatType.RANGED, magic: CombatType.MAGIC }[style];
    method = new (class extends CombatMethod {
      type() {
        return type;
      }

      hits() {
        return [];
      }
    })();
    styleMethods.set(style, method);
  }
  return method;
}

module.exports = {
  STAGE, ATTR_RAID, ATTR_LOGOUT, ATTR_DEATHS, ROOMS, Room, Raid, registerRoom, raidOf, begin, byId, raids, styleMethod,
};
