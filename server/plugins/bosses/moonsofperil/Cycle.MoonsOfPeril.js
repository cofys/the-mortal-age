/**
 * One Moon's arena, shared by everyone in it (docs/moons-of-peril.md): the Moon itself, which
 * never moves or dies, its glyph circle, and its loop. The loop runs on the world's tick, so
 * entering joins it where it is; a special already running is joined part-way. What a player
 * sees and suffers - their own health, curses and the special's pieces - is their Fight's.
 *
 * Each tick the arena works out its segment and offset (data moons.<moon>.cycle) and:
 * - at a segment's start: the focus moves (and is sent to everyone), a special starts;
 * - at `circleAt`: the circle moves to the glyph (a special's moves to the next segment's);
 * - at `attackableAt`: the Moon can be attacked again after a special;
 * - at each of `attacks`: the standard attack, one per fighter (Attacks.MoonsOfPeril).
 */
const Common = require("./Common.MoonsOfPeril");
const Attacks = require("./Attacks.MoonsOfPeril");

/** Specials by name, each { start(fight, offset), tick(fight, offset), stop(fight), landing?(arena, offset) }. */
const specials = new Map();

function registerSpecial(name, special) {
  specials.set(name, special);
}

class MoonArena {
  constructor(moon) {
    this.moon = moon;
    this.spec = Common.data.moons[moon];
    this.fights = new Map();
    this.npc = null;
    this.circle = null;
    this.oldCircle = null;
    this.circleFocus = -1;
    this.attackable = true;
    this.hidden = false;
    this.segments = [];
    let start = 0;
    for (const segment of this.spec.cycle) {
      this.segments.push({ ...segment, start });
      start += segment.ticks;
    }
    this.length = start;
    this.lastPhase = -1;
    /** Ticks added to the world's tick, so ::moonphase can move a loop. */
    this.shift = 0;
  }

  /** Where the loop is: the segment, its index, and the offset into it. */
  position(phase = this.phase()) {
    for (let index = 0; index < this.segments.length; index++) {
      const segment = this.segments[index];
      if (phase < segment.start + segment.ticks) return { segment, index, offset: phase - segment.start };
    }
    return { segment: this.segments[0], index: 0, offset: 0 };
  }

  phase() {
    const cycle = Common.core.World.getProcessCycle() + this.shift;
    return ((cycle % this.length) + this.length) % this.length;
  }

  /** Moves the loop so `segmentIndex` starts on the next tick. */
  jumpTo(segmentIndex) {
    const segment = this.segments[segmentIndex];
    if (!segment) return false;
    const now = Common.core.World.getProcessCycle() + 1;
    this.shift = segment.start - (now % this.length);
    for (const fight of this.fights.values()) fight.stopSpecial();
    this.setHidden(false);
    return true;
  }

  next(index) {
    return this.segments[(index + 1) % this.segments.length];
  }

  /** The focus the HUD shows now: the segment's, the safe glyph while a special has chosen one. */
  focus() {
    return this.position().segment.focus;
  }

  /** Whether the Moon can be attacked at this point of the loop. */
  attackableNow({ segment, offset } = this.position()) {
    if (segment.special) return segment.attackableAt != null && offset >= segment.attackableAt;
    return segment.attackableAt == null || offset >= segment.attackableAt;
  }

  /** The focus of the circle that should be up at this point (null while none is). */
  circleNow({ segment, index, offset } = this.position()) {
    if (segment.special) return segment.circleAt != null && offset >= segment.circleAt ? this.next(index).focus : null;
    if (segment.circleAt != null && offset < segment.circleAt) {
      return segment.circleAt > 0 ? null : segment.focus;
    }
    return segment.focus;
  }

  // ------------------------------------------------------------------ the shared Moon

  spawn() {
    const { api } = Common;
    const [x, y, z] = this.spec.tile;
    const npc = api.spawnNpc({ id: this.spec.npc, x, y, z, wanderRadius: 0 });
    if (!npc) return;
    npc.__moonArena = this;
    npc.__skipDefaultRespawn = true;
    npc.setMaxHitpoints(Common.data.hud.maxHitpoints);
    npc.setHitpoints(Common.data.hud.maxHitpoints);
    npc.setHitpointsLocked(true);
    npc.getMovementQueue().setBlockMovement(true);
    // It faces its glyph, never whoever hits it.
    npc.setFlag(require("./Pieces.MoonsOfPeril").KEEP_FACING_FLAG, true);
    this.npc = npc;
    this.faceGlyph(this.focus());
  }

  centre() {
    return Common.tileAt(this.moon, [2, 2]);
  }

  /**
   * The Moon turns to a glyph by its south-west tile, as captured (face_coord on the circle's
   * tile). The client aims a face tile as the corner of the Moon's own 5x5, so the glyph's
   * centre tile would turn it a glyph too far round. Always sent, so a Moon that has just come
   * back, or a fighter who has just arrived, sees it.
   */
  faceGlyph(focus) {
    const glyph = Common.data.glyphs[focus];
    if (!glyph || !this.npc) return;
    this.npc.forcePositionToFace(Common.tileAt(this.moon, glyph));
  }

  /** The glyph the Moon faces at this point of the loop (none while a special holds it). */
  glyphToFace({ segment, index, offset } = this.position()) {
    if (!segment.special) return segment.focus;
    return segment.attackableAt != null && offset >= segment.attackableAt ? this.next(index).focus : null;
  }

  /** The Moon leaves the arena during some specials, for everyone (captured as its NPC going). */
  setHidden(hidden) {
    this.hidden = hidden;
    this.npc?.setVisible(!hidden);
    // Back in view it is a new NPC to the client: it faces its glyph again a tick later.
    if (!hidden) {
      Common.later(1, () => {
        const focus = this.glyphToFace();
        if (focus != null) this.faceGlyph(focus);
      });
    }
  }

  // ------------------------------------------------------------------ the circle

  moveCircle(focus) {
    if (focus === this.circleFocus && this.circle?.isRegistered?.()) return;
    this.removeOldCircle();
    this.oldCircle = this.circle;
    this.circle = null;
    this.circleFocus = focus;
    // The old one goes a tick later (capture).
    Common.later(1, () => this.removeOldCircle());
    if (focus == null || this.fights.size === 0) return;
    const glyph = Common.data.glyphs[focus];
    const { npc, spawnAnim } = Common.data.threatCircle;
    const at = Common.tileAt(this.moon, glyph);
    const circle = Common.api.spawnNpc({ id: npc, x: at.getX(), y: at.getY(), z: at.getZ(), wanderRadius: 0 });
    if (!circle) return;
    circle.__skipDefaultRespawn = true;
    circle.getMovementQueue().setBlockMovement(true);
    Common.animate(circle, spawnAnim);
    this.circle = circle;
  }

  removeOldCircle() {
    if (this.oldCircle?.isRegistered?.()) Common.api.removeNpc(this.oldCircle);
    this.oldCircle = null;
  }

  clearCircle() {
    this.removeOldCircle();
    if (this.circle?.isRegistered?.()) Common.api.removeNpc(this.circle);
    this.circle = null;
    this.circleFocus = -1;
  }

  // ------------------------------------------------------------------ the loop

  process() {
    const phase = this.phase();
    if (phase === this.lastPhase) return;
    this.lastPhase = phase;
    if (this.fights.size === 0) {
      if (this.circle || this.oldCircle) this.clearCircle();
      // Nobody is left to see a special bring the Moon back (Blood Rain's backAt).
      if (this.hidden) this.setHidden(false);
      return;
    }
    const where = this.position(phase);
    const { segment, index, offset } = where;
    const special = segment.special ? specials.get(segment.special) : null;

    if (offset === 0) {
      for (const fight of this.fights.values()) fight.setFocus(segment.focus);
      if (segment.special) {
        this.attackable = false;
        for (const fight of this.fights.values()) fight.startSpecial(special, 0);
      } else {
        // A special that took the Moon away has always brought it back by now.
        if (this.hidden) this.setHidden(false);
        this.faceGlyph(segment.focus);
      }
    }
    const circle = this.circleNow(where);
    if (circle !== this.circleFocus) this.moveCircle(circle);
    const attackable = this.attackableNow(where);
    if (attackable && !this.attackable && segment.special) this.faceGlyph(this.next(index).focus);
    this.attackable = attackable;

    if (special) {
      special.shared?.(this, offset);
      for (const fight of this.fights.values()) fight.tickSpecial(special, offset);
    } else {
      for (const attackAt of segment.attacks ?? []) {
        if (offset === attackAt - 1) for (const fight of this.fights.values()) Attacks.warn(fight);
        if (offset === attackAt) Attacks.attack(this);
      }
    }
    for (const fight of [...this.fights.values()]) fight.process(where);
  }

  /** A fighter's personal special, started part-way when they join during one. */
  specialFor(where = this.position()) {
    return where.segment.special ? { special: specials.get(where.segment.special), offset: where.offset } : null;
  }
}

const arenas = new Map();

function arenaOf(moon) {
  return arenas.get(moon) ?? null;
}

function arenaOfNpc(npc) {
  return npc?.__moonArena ?? null;
}

/** The Moons appear with the world, and their loops run from then on. */
function startArenas() {
  const { Task, TaskManager } = Common.core;
  for (const moon of Common.MOONS) {
    if (arenas.has(moon)) continue;
    const arena = new MoonArena(moon);
    arenas.set(moon, arena);
    arena.spawn();
  }
  TaskManager.submit(new (class extends Task {
    constructor() {
      super(1, null, false);
    }
    execute() {
      for (const arena of arenas.values()) {
        try {
          arena.process();
        } catch (error) {
          console.error(`[MoonsOfPeril] ${arena.moon} arena tick failed`, error);
        }
      }
    }
  })());
}

/**
 * The Moons' own NPCs have no name in the cache, so the stat loader skips them: they take their
 * visible forms' stats (500 hitpoints, the Wiki infobox's levels and bonuses), and never fight
 * back through the engine - their attacks are the loop's.
 */
function copyStats() {
  const { NpcDefinition } = Common.core;
  for (const moon of Common.MOONS) {
    const spec = Common.data.moons[moon];
    const shown = NpcDefinition.forId(spec.visibleNpc);
    const own = NpcDefinition.forId(spec.npc);
    if (!shown || !own) continue;
    Object.assign(own, {
      stats: shown.getStats().slice(),
      hitpoints: shown.getHitpoints(),
      attackSpeed: shown.getAttackSpeed(),
      maxHit: shown.getMaxHit(),
      aggressive: false,
      members: true,
    });
  }
}

function combatClass() {
  const { CombatMethod, CombatType } = Common.core;
  return class MoonCombat extends CombatMethod {
    start() {}

    hits() {
      return [];
    }

    attackSpeed() {
      return 1;
    }

    attackDistance() {
      return 1;
    }

    type() {
      return CombatType.MELEE;
    }
  };
}

function attachCycle(api) {
  const Combat = combatClass();
  const { specials } = Common.data;
  // The Moons, jaguars, clones and ice blocks never fight through the engine: their specials do.
  const ids = [
    ...Common.MOONS.map((moon) => Common.data.moons[moon].npc),
    specials.jaguars.npc, specials.clones.npc, ...specials.freeze.blocks.map((block) => block.npc),
  ];
  for (const id of ids) api.registerNpcCombatMethodProvider(id, Combat);
  api.onServerStartup(() => {
    copyStats();
    startArenas();
  });
}

module.exports = { attachCycle, registerSpecial, arenaOf, arenaOfNpc, arenas, MoonArena };
