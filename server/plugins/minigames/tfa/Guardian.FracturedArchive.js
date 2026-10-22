"use strict";

/**
 * The Archive Guardian, the first room. The Inert Guardian waits in the middle of the Nexus
 * until someone touches it; then it flies, shielded, and only grounds when its shield breaks.
 *
 * Captured (four duo attempts, docs/fractured-archive.md):
 * - Touch: "Begin the challenge?" Yes./No. "Challenge started: Archive Guardian.", music 887,
 *   npc_archive_guardian_spawn01 with its graphic, the exit's ops gone; five ticks later it is
 *   tfa_guardian (16659, a 550 shield) and the four batteries are active.
 * - Flying, it acts every 5 ticks: a ranged attack (range_attack01, projectile 4201 per target,
 *   landing four ticks later with 4200), and every fifth a special that grows two mushrooms per
 *   player, one beside them and one three tiles off. A mushroom ripens three ticks later
 *   (nightmare_infection_spotanim_idle); a player beside a ripe one bursts it: poison 10 and
 *   "You have been poisoned!". A target 7+ tiles away makes it swoop (swoosh_attack01, a 40-56
 *   cycle exact move) to land a few tiles from them; a player under it is hit in melee (33 seen
 *   through Protect from Missiles). Melee can't reach it: "It's flying too high to hit using melee."
 * - The shield at 0: three ticks later idle_to_ground01, the landing blast, tfa_guardian_unshielded
 *   (16660) and the boss bar on its 1,100 hitpoints, which carry over between landings. On the
 *   ground it doesn't attack; vines rise beside each player every three ticks from five ticks
 *   in (spawn, attacks at +3/+6/+9, gone at +13). Each landing lasts six ticks longer than the
 *   last: 35, 41, 47, 53. Then ground_to_flying01 and the shield is full again.
 * - Enraged (seen below 316 of 1,100): it takes off at once and stops its ranged attacks. Every
 *   20 ticks a special, and five ticks after it enraged_phase01 with "The Archive Guardian
 *   focuses intently on you!"; ten ticks later 43 damage on that player, through prayer. A
 *   battery about four tiles from where it lands takes the blast instead: it dies
 *   (guthixian_battery_despawn, a camera shake, then the destroyed battery), the player takes
 *   20, and four ticks after that the Guardian loses 220 shield (40%).
 * Estimates (not in the captures): the enrage threshold (30%), the damage figures other than
 *   those above (Wiki: max hit 25), the swoop's trigger and landing, the vines' and mushrooms'
 *   reach, a player's own hits on a battery doing nothing, and everything about the kill.
 */

const Shared = require("./Shared.FracturedArchive");
const Raid = require("./RaidState.FracturedArchive");

const { SOUND, MUSIC } = Shared;

/** The room's layout, as captured. */
const LAYOUT = {
  guardian: { x: 4125, y: 5597, z: 0 },
  batteries: [{ x: 4139, y: 5592 }, { x: 4139, y: 5605 }, { x: 4114, y: 5605 }, { x: 4114, y: 5592 }],
  exit: { x: 4124, y: 5569, z: 0, face: 0 },
  doors: [
    { x: 4141, y: 5597, face: 1 }, { x: 4141, y: 5584, face: 1 },
    { x: 4113, y: 5597, face: 3 }, { x: 4113, y: 5584, face: 3 },
    { x: 4141, y: 5610, face: 1 }, { x: 4113, y: 5610, face: 3 },
  ],
  ocellusDoor: { x: 4124, y: 5621, face: 0 },
};

/** Timings in ticks (captured unless noted). */
const TIME = {
  IDLE_GRAPHIC: 3,
  TRANSFORM: 5,
  ATTACK: 5,
  SPECIAL_EVERY: 5,
  RANGED_LANDS: 4,
  MELEE_LANDS: 1,
  MUSHROOM_RIPENS: 3,
  /** A ripe mushroom bursts this long after a player is beside it (captured: 5 after spawning). */
  MUSHROOM_FUSE: 2,
  MUSHROOM_GONE: 2,
  LAND_AFTER_BREAK: 3,
  FIRST_WINDOW: 35,
  WINDOW_GROWTH: 6,
  VINES_FROM: 5,
  VINE_EVERY: 3,
  VINE_ATTACKS: [3, 6, 9],
  VINE_DESPAWN: 12,
  VINE_GONE: 13,
  ENRAGE_CYCLE: 20,
  FOCUS_AFTER_SPECIAL: 5,
  BEAM_AFTER_FOCUS: 10,
  BATTERY_DESTROYED: 2,
  BATTERY_DAMAGE: 4,
  DEATH: 5,
};

/** Damage. Captured: the beam's 43 and 20, the battery's 220; the rest are estimates. */
const DAMAGE = {
  RANGED: 25,
  RANGED_PRAYED: 0.4,
  MELEE: 35,
  MELEE_PRAYED: 0.5,
  VINE: 20,
  VINE_PRAYED: 0.5,
  POISON: 10,
  BEAM: 43,
  BEAM_ABSORBED: 20,
  BATTERY_SHIELD: 220,
};

const SHIELD = 550;
const HITPOINTS = 1100;
/** Estimate: captured enraging below 316/1,100 (29%). */
const ENRAGE_BELOW = 0.3;
const SWOOP_FROM = 7;
const SWOOP_LAND = 3;
const SWOOP_CYCLES = 48;
/** Estimate: one ranged attack in four or five went to both players. */
const RANGED_SPREAD_CHANCE = 0.22;
const BATTERY_REACH = 4;
const VINE_REACH = 1;
const MUSHROOM_REACH = 1;
/** The boss bar's back, sliding and remaining colours: blue for the shield, as captured. */
const SHIELD_COLOURS = [132, 623, 853];
const HEALTH_COLOURS = [25600, 576, 800];
const FOCUS_MESSAGE = "@mes_hl_ora@The Archive Guardian focuses intently on you!";
const CAMERA_SHAKE = [[0, 5], [1, 2], [2, 2]];
const RANGED_PROJECTILE = { delay: 48, end: 116, angle: 127, progress: 0, startHeight: 0, endHeight: 0 };

const PHASE = { INERT: "inert", WAKING: "waking", FLYING: "flying", LANDING: "landing", GROUNDED: "grounded", DEAD: "dead" };

class GuardianRoom extends Raid.Room {
  onBuild() {
    const { npc, loc } = Shared.ids();
    this.phase = PHASE.INERT;
    this.health = HITPOINTS;
    this.landings = 0;
    this.enraged = false;
    this.mushrooms = [];
    this.vines = new Set();
    this.guardian = this.spawn(npc.GUARDIAN_START, LAYOUT.guardian, { scripted: true, face: Shared.core().Direction.SOUTH.getId() });
    this.batteries = LAYOUT.batteries.map((tile) => this.spawn(npc.BATTERY_INACTIVE, { ...tile, z: 0 }, { scripted: true }));
    this.exit = this.placeObject(loc.EXIT, LAYOUT.exit, 10, LAYOUT.exit.face);
    for (const door of LAYOUT.doors) this.placeObject(loc.SECTION_DOOR, { ...door, z: 0 }, 10, door.face);
    this.placeObject(loc.OCELLUS_DOOR, { ...LAYOUT.ocellusDoor, z: 0 }, 10, LAYOUT.ocellusDoor.face);
    this.repeat(TIME.IDLE_GRAPHIC, () => {
      if (this.phase !== PHASE.INERT) return false;
      this.guardian.performGraphic(Shared.gfx(Shared.id("spotanim", "GUARDIAN_IDLE")));
      return true;
    });
  }

  /** "Touch": the challenge, once everyone agrees. */
  touch(player) {
    if (this.phase !== PHASE.INERT || this.raid.member(player).roomKey !== this.key) return;
    Shared.options(player, "Begin the challenge?", "Yes.", () => {
      if (this.phase === PHASE.INERT) this.start();
    }, "No.", () => {});
  }

  onStart() {
    const { Animation } = Shared.core();
    this.phase = PHASE.WAKING;
    this.setExitOps(false);
    for (const player of this.roomPlayers()) {
      Shared.api().emitCustomEvent("music:unlock-track", { player, trackId: MUSIC.ARCHIVE_GUARDIAN });
      player.getPacketSender().sendSong(MUSIC.ARCHIVE_GUARDIAN);
      Shared.api().emitCustomEvent("fractured-archive:record", { player, category: "GUARDIAN", field: "attempts" });
    }
    this.guardian.performGraphic(Shared.gfx(Shared.id("spotanim", "GUARDIAN_SPAWN")));
    this.guardian.performAnimation(new Animation(Shared.id("seq", "GUARDIAN_SPAWN")));
    this.later(TIME.TRANSFORM, () => this.wake());
  }

  wake() {
    const { npc } = Shared.ids();
    this.guardian.setNpcTransformationId(npc.GUARDIAN);
    this.guardian.performAnimation(new (Shared.core().Animation)(Shared.id("seq", "GUARDIAN_IDLE")));
    for (const battery of this.batteries) {
      battery.setNpcTransformationId(npc.BATTERY_ACTIVE);
      const hitpoints = Shared.core().NpcDefinition.forId(npc.BATTERY_ACTIVE)?.getHitpoints?.() ?? 1;
      battery.setMaxHitpoints(hitpoints);
      battery.setHitpoints(hitpoints);
    }
    this.fly(true);
    for (const player of this.fighters()) {
      Shared.api().emitCustomEvent("boss-hud:show", { player, npcId: npc.GUARDIAN, current: this.shield, maximum: SHIELD, colours: SHIELD_COLOURS });
    }
  }

  // ---------------------------------------------------------------- flying

  /** Up in the air with a full shield; the attack cycle starts over. */
  fly(first = false) {
    this.phase = PHASE.FLYING;
    this.shield = SHIELD;
    this.guardian.setMaxHitpoints(SHIELD);
    this.guardian.setHitpoints(SHIELD);
    this.attacks = 0;
    this.nextAttack = Shared.cycle() + (first ? 4 : TIME.ATTACK);
    this.nextSwoop = Shared.cycle() + 1;
    this.nextEnrageSpecial = Shared.cycle() + (first ? 4 : TIME.ATTACK);
    this.focus = null;
    this.updateHud(Shared.id("npc", "GUARDIAN"), this.shield, SHIELD, SHIELD_COLOURS);
  }

  tick() {
    if (!this.isStarted()) return;
    this.tickMushrooms();
    if (this.phase === PHASE.FLYING) this.tickFlying();
    this.syncHud();
  }

  tickFlying() {
    const now = Shared.cycle();
    if (this.enraged) {
      this.tickEnraged(now);
      return;
    }
    if (now >= this.nextSwoop && now < this.nextAttack - 1) this.maybeSwoop(now);
    if (now < this.nextAttack) return;
    this.nextAttack = now + TIME.ATTACK;
    this.attacks++;
    const under = this.fighters().filter((player) => Shared.distanceTo(this.guardian, player.getLocation()) === 0);
    if (under.length > 0) {
      this.melee(under);
      return;
    }
    if (this.attacks % TIME.SPECIAL_EVERY === 0) this.special();
    else this.ranged();
  }

  target() {
    const fighters = this.fighters();
    if (fighters.length === 0) return null;
    const current = this.guardian.getCombat().getTarget?.();
    return fighters.includes(current) ? current : Shared.randomOf(fighters);
  }

  centre() {
    const at = this.guardian.getLocation();
    return { x: at.getX() + 2, y: at.getY() + 2, z: at.getZ() };
  }

  facePlayer(player) {
    this.guardian.setPositionToFace(player.getLocation());
  }

  ranged() {
    const target = this.target();
    if (!target) return;
    const { Animation } = Shared.core();
    this.facePlayer(target);
    this.guardian.performAnimation(new Animation(Shared.id("seq", "GUARDIAN_RANGED")));
    this.guardian.performGraphic(Shared.gfx(Shared.id("spotanim", "RANGED_CAST")));
    const targets = Math.random() < RANGED_SPREAD_CHANCE ? this.fighters() : [target];
    for (const player of targets) {
      Shared.projectile(this.area, this.guardian, player, Shared.id("spotanim", "RANGED_PROJECTILE"), RANGED_PROJECTILE);
      // The prayer counts as the attack is thrown (captured: switching after it is too late).
      const hit = this.styledHit(this.guardian, player, "ranged", DAMAGE.RANGED, TIME.RANGED_LANDS, { prayerMultiplier: DAMAGE.RANGED_PRAYED });
      this.later(TIME.RANGED_LANDS, () => {
        if (!this.fighters().includes(player)) return;
        player.performGraphic(Shared.gfx(Shared.id("spotanim", "RANGED_HIT"), { height: 0 }));
        player.getCombat().getHitQueue().addPendingHit(hit, Shared.cycle());
      });
    }
  }

  melee(players) {
    const { Animation } = Shared.core();
    this.guardian.performAnimation(new Animation(Shared.id("seq", "GUARDIAN_MELEE")));
    for (const player of players) this.strike(this.guardian, player, "melee", DAMAGE.MELEE, TIME.MELEE_LANDS, { prayerMultiplier: DAMAGE.MELEE_PRAYED });
  }

  /** Two mushrooms per player: one beside them, one three tiles off. */
  special() {
    const { Animation } = Shared.core();
    this.guardian.performAnimation(new Animation(Shared.id("seq", "GUARDIAN_SPECIAL")));
    this.guardian.performGraphic(Shared.gfx(Shared.id("spotanim", "SPECIAL")));
    for (const player of this.fighters()) {
      for (const distance of [1, 3]) {
        const tile = this.freeTileAround(player.getLocation(), distance);
        if (tile) this.growMushroom(tile);
      }
    }
  }

  /** A free floor tile at exactly `distance` (Chebyshev) from a location. */
  freeTileAround(location, distance) {
    const ring = [];
    for (let dx = -distance; dx <= distance; dx++) {
      for (let dy = -distance; dy <= distance; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== distance) continue;
        ring.push({ x: location.getX() + dx, y: location.getY() + dy, z: location.getZ() });
      }
    }
    return Shared.shuffle(ring).find((tile) => Shared.inArchive(Shared.loc(tile)) && Shared.floorFree(this.area, tile)
      && Shared.distanceTo(this.guardian, tile) > 0
      && ![...this.vines].some((vine) => vine.getLocation().getX() === tile.x && vine.getLocation().getY() === tile.y)
      && !this.mushrooms.some((mushroom) => mushroom.tile.x === tile.x && mushroom.tile.y === tile.y)) ?? null;
  }

  /** Lands its centre a few tiles from a far-off target (an estimate of how live picks it). */
  maybeSwoop(now) {
    const target = this.target();
    if (!target) return;
    const centre = this.centre();
    const at = target.getLocation();
    const distance = Math.max(Math.abs(at.getX() - centre.x), Math.abs(at.getY() - centre.y));
    if (distance < SWOOP_FROM) return;
    const dx = Math.sign(centre.x - at.getX());
    const dy = Math.sign(centre.y - at.getY());
    const landing = Shared.loc({ x: at.getX() + dx * SWOOP_LAND - 2, y: at.getY() + dy * SWOOP_LAND - 2, z: at.getZ() });
    if (!Shared.inArchive(landing)) return;
    const { Animation } = Shared.core();
    this.guardian.performAnimation(new Animation(Shared.id("seq", "GUARDIAN_SWOOSH")));
    this.guardian.exactMove(landing, { endCycles: SWOOP_CYCLES });
    this.nextSwoop = now + TIME.ATTACK * 2;
  }

  // ---------------------------------------------------------------- mushrooms

  growMushroom(tile) {
    const object = this.placeObject(Shared.id("loc", "MUSHROOM_SPAWN"), tile);
    const mushroom = { tile, object, ripe: false, armedAt: 0, burstAt: 0 };
    this.mushrooms.push(mushroom);
    this.later(TIME.MUSHROOM_RIPENS, () => {
      if (!this.mushrooms.includes(mushroom)) return;
      mushroom.object = this.replaceObject(mushroom.object, Shared.id("loc", "MUSHROOM_ACTIVE"));
      mushroom.ripe = true;
      const { Animation } = Shared.core();
      const animation = new Animation(Shared.id("seq", "MUSHROOM_IDLE"));
      for (const viewer of this.area.getPlayers()) viewer.getPacketSender().sendObjectAnimation(mushroom.object, animation);
    });
  }

  tickMushrooms() {
    const now = Shared.cycle();
    const fighters = this.fighters();
    for (const mushroom of [...this.mushrooms]) {
      if (!mushroom.ripe) continue;
      const near = fighters.filter((player) => Shared.distanceTo(player, mushroom.tile) <= MUSHROOM_REACH && player.getLocation().getZ() === mushroom.tile.z);
      if (mushroom.burstAt === 0 && near.length > 0) mushroom.burstAt = now + TIME.MUSHROOM_FUSE;
      if (mushroom.burstAt > 0 && now >= mushroom.burstAt) this.burst(mushroom, near);
    }
  }

  burst(mushroom, players) {
    this.mushrooms = this.mushrooms.filter((other) => other !== mushroom);
    mushroom.object = this.replaceObject(mushroom.object, Shared.id("loc", "MUSHROOM_DESPAWN"));
    Shared.areaSound(this.area, mushroom.tile, SOUND.MUSHROOM_POP);
    const { CombatFactory } = Shared.core();
    for (const player of players) {
      CombatFactory.poisonEntity(player, DAMAGE.POISON);
      Shared.damage(player, DAMAGE.POISON, "GREEN");
    }
    const object = mushroom.object;
    this.later(TIME.MUSHROOM_GONE, () => this.removeObject(object));
  }

  // ---------------------------------------------------------------- the shield and the ground

  /** Damage on the Guardian: melee can't reach it in the air, and its shield takes the rest. */
  modifyHit(npc, hit) {
    if (npc === this.guardian && this.phase !== PHASE.FLYING && this.phase !== PHASE.GROUNDED) {
      zero(hit);
      return;
    }
    if (this.batteries.includes(npc)) zero(hit);
  }

  /** The Guardian's hitpoints running out is a landing (shield) or its end (health). */
  holdsOn(npc) {
    if (npc === this.guardian) {
      if (this.phase === PHASE.FLYING) this.breakShield();
      else if (this.phase === PHASE.GROUNDED) this.die();
      return true;
    }
    return this.batteries.includes(npc) || this.vines.has(npc);
  }

  canAttack(attacker, target, method) {
    if (target !== this.guardian || !attacker?.isPlayer?.()) return null;
    if (this.phase === PHASE.INERT || this.phase === PHASE.WAKING || this.phase === PHASE.DEAD) return false;
    if (this.phase === PHASE.FLYING && method?.type?.() === Shared.core().CombatType.MELEE) {
      attacker.sendMessage("It's flying too high to hit using melee.");
      return false;
    }
    return null;
  }

  breakShield() {
    this.phase = PHASE.LANDING;
    this.shield = 0;
    this.guardian.setHitpoints(1);
    this.syncHud();
    this.later(TIME.LAND_AFTER_BREAK, () => this.land());
  }

  land() {
    const { Animation } = Shared.core();
    const { npc } = Shared.ids();
    this.phase = PHASE.GROUNDED;
    this.landings++;
    this.guardian.setNpcTransformationId(npc.GUARDIAN_UNSHIELDED);
    this.guardian.performAnimation(new Animation(Shared.id("seq", "GUARDIAN_LAND")));
    this.guardian.performGraphic(Shared.gfx(Shared.id("spotanim", "LAND")));
    Shared.graphicAt(this.area, Shared.id("spotanim", "LANDING_BLAST"), this.centre(), { delay: 20 });
    this.guardian.setMaxHitpoints(HITPOINTS);
    this.guardian.setHitpoints(Math.max(1, this.health));
    this.updateHud(npc.GUARDIAN_UNSHIELDED, this.health, HITPOINTS, HEALTH_COLOURS);
    const window = TIME.FIRST_WINDOW + TIME.WINDOW_GROWTH * (this.landings - 1);
    this.windowEnds = Shared.cycle() + window;
    for (let at = TIME.VINES_FROM; at < window - TIME.VINE_ATTACKS[0]; at += TIME.VINE_EVERY) {
      this.later(at, () => {
        if (this.phase === PHASE.GROUNDED) this.raiseVines();
      });
    }
    this.later(window, () => {
      if (this.phase === PHASE.GROUNDED) this.takeOff();
    });
  }

  takeOff() {
    const { Animation } = Shared.core();
    this.health = Math.max(1, this.guardian.getHitpoints());
    this.guardian.setNpcTransformationId(Shared.id("npc", "GUARDIAN"));
    this.guardian.performAnimation(new Animation(Shared.id("seq", "GUARDIAN_TAKE_OFF")));
    this.guardian.performGraphic(Shared.gfx(Shared.id("spotanim", "TAKE_OFF")));
    this.fly();
  }

  /** A vine beside each player, facing them; it lashes three times and sinks (captured timing). */
  raiseVines() {
    const { Animation } = Shared.core();
    for (const player of this.fighters()) {
      const tile = this.freeTileAround(player.getLocation(), 1);
      if (!tile) continue;
      const vine = this.spawn(Shared.id("npc", "TENTACLE"), tile, { scripted: true });
      if (!vine) continue;
      this.vines.add(vine);
      vine.setPositionToFace(player.getLocation());
      vine.performAnimation(new Animation(Shared.id("seq", "TENTACLE_SPAWN")));
      vine.performGraphic(Shared.gfx(Shared.id("spotanim", "TENTACLE_INTRO")));
      Shared.areaSound(this.area, vine, SOUND.TENTACLE);
      for (const at of TIME.VINE_ATTACKS) {
        this.later(at, () => {
          if (!vine.isRegistered?.()) return;
          vine.performAnimation(new Animation(Shared.id("seq", "TENTACLE_ATTACK")));
          for (const target of this.fighters()) {
            if (Shared.distanceTo(vine, target.getLocation()) > VINE_REACH) continue;
            this.strike(vine, target, "melee", DAMAGE.VINE, 0, { prayerMultiplier: DAMAGE.VINE_PRAYED });
          }
        });
      }
      this.later(TIME.VINE_DESPAWN, () => vine.performAnimation(new Animation(Shared.id("seq", "TENTACLE_DESPAWN"))));
      this.later(TIME.VINE_GONE, () => {
        this.vines.delete(vine);
        this.despawn(vine);
      });
    }
  }

  // ---------------------------------------------------------------- enraged

  checkEnrage() {
    if (this.enraged || this.health > HITPOINTS * ENRAGE_BELOW) return;
    this.enraged = true;
    if (this.phase === PHASE.GROUNDED) this.takeOff();
    this.nextEnrageSpecial = Shared.cycle() + TIME.ATTACK;
  }

  tickEnraged(now) {
    if (now >= this.nextEnrageSpecial) {
      this.nextEnrageSpecial = now + TIME.ENRAGE_CYCLE;
      this.special();
      this.later(TIME.FOCUS_AFTER_SPECIAL, () => this.focusOn());
    }
  }

  focusOn() {
    if (this.phase !== PHASE.FLYING || !this.enraged) return;
    const target = this.target();
    if (!target) return;
    const { Animation } = Shared.core();
    this.facePlayer(target);
    this.guardian.performAnimation(new Animation(Shared.id("seq", "GUARDIAN_ENRAGED")));
    this.guardian.performGraphicInSlot(2, Shared.gfx(Shared.id("spotanim", "ENRAGED")));
    target.sendMessage(FOCUS_MESSAGE);
    this.later(TIME.BEAM_AFTER_FOCUS, () => this.beam(target));
  }

  /** The beam lands where the player stands; a live battery close by takes it instead. */
  beam(target) {
    if (!this.fighters().includes(target) || this.phase !== PHASE.FLYING) return;
    const at = target.getLocation();
    this.guardian.setPositionToFace(at);
    const activeId = Shared.id("npc", "BATTERY_ACTIVE");
    const battery = this.batteries.find((npc) => npc.getId() === activeId && !npc.__tfaDestroyed && Shared.distanceTo(npc, at) <= BATTERY_REACH);
    if (!battery) {
      Shared.damage(target, DAMAGE.BEAM);
      return;
    }
    Shared.damage(target, DAMAGE.BEAM_ABSORBED);
    this.destroyBattery(battery);
  }

  destroyBattery(battery) {
    const { Animation } = Shared.core();
    battery.performAnimation(new Animation(Shared.id("seq", "BATTERY_DESPAWN")));
    battery.__tfaDestroyed = true;
    this.later(TIME.BATTERY_DESTROYED, () => {
      battery.setNpcTransformationId(Shared.id("npc", "BATTERY_DESTROYED"));
      for (const player of this.roomPlayers()) {
        Shared.sound(player, SOUND.BATTERY_EXPLODE);
        for (const [axis, amplitude] of CAMERA_SHAKE) player.getPacketSender().sendCameraShake(axis, amplitude);
      }
    });
    this.later(TIME.BATTERY_DAMAGE, () => {
      if (this.phase !== PHASE.FLYING) return;
      const dealt = Math.min(this.guardian.getHitpoints(), DAMAGE.BATTERY_SHIELD);
      Shared.damage(this.guardian, dealt, "YELLOW");
    });
  }

  // ---------------------------------------------------------------- the end

  die() {
    if (this.phase === PHASE.DEAD) return;
    const { Animation } = Shared.core();
    this.phase = PHASE.DEAD;
    this.health = 0;
    this.guardian.setHitpoints(1);
    this.guardian.performAnimation(new Animation(Shared.id("seq", "GUARDIAN_DEATH")));
    for (const vine of [...this.vines]) this.despawn(vine);
    this.vines.clear();
    for (const player of this.roomPlayers()) Shared.api().emitCustomEvent("boss-hud:hide", { player });
    this.later(TIME.DEATH, () => {
      this.guardian.setNpcTransformationId(Shared.id("npc", "GUARDIAN_DEAD"));
      this.complete();
    });
  }

  onComplete() {
    this.clearMushrooms();
    this.setExitOps(true);
    for (const player of this.roomPlayers()) {
      Shared.api().emitCustomEvent("fractured-archive:record", { player, category: "GUARDIAN", field: "completions" });
      player.sendMessage("The way onward is not open yet: the Archive's other chambers are still to come.");
    }
  }

  onFail() {
    this.clearMushrooms();
  }

  clearMushrooms() {
    for (const mushroom of this.mushrooms) this.removeObject(mushroom.object);
    this.mushrooms = [];
  }

  // ---------------------------------------------------------------- the boss bar

  updateHud(npcId, current, maximum, colours) {
    this.hud = { npcId, current, maximum, colours };
    for (const player of this.fighters()) Shared.api().emitCustomEvent("boss-hud:update", { player, ...this.hud });
  }

  /** The bar follows the shield or the health each tick, and the enrage is checked on health. */
  syncHud() {
    if (!this.hud) return;
    const points = this.phase === PHASE.FLYING ? this.guardian.getHitpoints()
      : this.phase === PHASE.LANDING ? 0
        : this.phase === PHASE.GROUNDED ? this.guardian.getHitpoints() : this.hud.current;
    if (this.phase === PHASE.GROUNDED) {
      this.health = points;
      this.checkEnrage();
    }
    if (points === this.hud.current) return;
    this.hud.current = points;
    for (const player of this.fighters()) Shared.api().emitCustomEvent("boss-hud:update", { player, current: points });
  }

  // ---------------------------------------------------------------- the exit

  /** The exit's ops are off while the challenge runs (captured: opflags 0). */
  setExitOps(enabled) {
    const { loc } = Shared.ids();
    this.removeObject(this.exit);
    this.exit = this.placeObject(loc.EXIT, LAYOUT.exit, 10, LAYOUT.exit.face);
    if (!enabled) this.exit.getOpFlags = () => 0;
    for (const player of this.area.getPlayers()) {
      player.getPacketSender().sendObjectRemoval(this.exit);
      player.getPacketSender().sendObject(this.exit);
    }
  }
}

function zero(hit) {
  for (const part of hit.getHits?.() ?? []) part.setDamage(0);
  hit.updateTotalDamage?.();
}

function touchGuardian(event) {
  const raid = Raid.raidOf(event.player);
  const room = raid?.room;
  if (!(room instanceof GuardianRoom) || event.npc !== room.guardian) return false;
  room.touch(event.player);
  return true;
}

module.exports = function registerGuardian(api) {
  Shared.bind(api);
  Raid.registerRoom("GUARDIAN", GuardianRoom);
  api.onNpcInteraction("<col=00ffff>Inert Guardian</col>", { Touch: touchGuardian });
};

Object.assign(module.exports, { GuardianRoom, LAYOUT, TIME, DAMAGE, PHASE, SHIELD, HITPOINTS });
