/**
 * The Blood Moon's specials (docs/moons-of-peril.md), as captured; offsets are ticks into the
 * special, data specials.jaguars / specials.rain.
 *
 * Blood Jaguar (New Moon):
 * - 0: the Moon can't be attacked; a random glyph becomes the safe one (pmoon_boss_current_focus),
 *   25 hitpoints are marked to be sapped (pmoon_boss_ad_hp); projectiles to the jaguars' tiles.
 * - 2: eight jaguars rise around the arena facing in, each on a moon-phase floor sigil, and the
 *   safe glyph glows. 3: "You suddenly feel drained..." - up to 15 damage, which heals the Moon.
 * - 7, then every 6 (seven times): blood pools on the ring next to the Moon, gone after 5 ticks;
 *   up to 6, healing the Moon twice that. 10, then every 6: the jaguars strike the two tiles in
 *   front of them; up to 9, healing the Moon three times that.
 * - Hitting the jaguar by the safe glyph gives back the sapped hitpoints (Wiki: up to 25); "This
 *   jaguar doesn't possess any of your blood!" once none is left, or on any other jaguar.
 * - 43: the sigils fade, 45 the jaguars stop, 49 they go.
 * Blood Rain (Full Moon):
 * - 3: the player is thrown to a random tile; 4: blood fire rings the arena; 8 the Moon fades and
 *   leaves at 10. 7-25: blood pools rain down every tick, lasting 5 ticks; up to 9, healing the
 *   Moon twice that. Every 4 ticks the Moon loses a hitpoint (Wiki: off the pools chips it).
 * - 26: the Moon comes back. The fire and the pools go when the special ends.
 */
const Common = require("./Common.MoonsOfPeril");
const Cycle = require("./Cycle.MoonsOfPeril");
const Pieces = require("./Pieces.MoonsOfPeril");

const spec = () => Common.data.specials.jaguars;
const rainSpec = () => Common.data.specials.rain;

// ------------------------------------------------------------------ Blood Jaguar

/** The 24 tiles around the Moon's 5x5 (the pool ring). */
function ring() {
  const tiles = [];
  for (let x = -1; x <= 5; x++) {
    for (let y = -1; y <= 5; y++) {
      if (x === -1 || x === 5 || y === -1 || y === 5) tiles.push([x, y]);
    }
  }
  return tiles;
}

const RING = ring();
const sameTile = ([ax, ay], [bx, by]) => ax === bx && ay === by;

function jaguarsStart(fight, offset) {
  const { safeGlyphs, sapped } = spec();
  fight.state.safe = Common.pick(safeGlyphs);
  fight.state.sapped = sapped;
  fight.state.jaguars = [];
  fight.state.pools = [];
  fight.state.poolWaves = 0;
  Common.varbit(fight.player, "focus", fight.state.safe);
  Common.varbit(fight.player, "sapped", sapped);
  // Joined part-way: what has already happened is set up at once.
  for (let tick = 0; tick < offset; tick++) jaguarsTick(fight, tick, { catchingUp: true });
}

function jaguarsTick(fight, offset, { catchingUp = false } = {}) {
  const s = spec();
  const { player } = fight;
  if (offset === 0 && !catchingUp) {
    const centre = Common.tileAt(fight.moon, [2, 2]);
    for (const jaguar of s.jaguars) Common.projectile(player, centre, Common.tileAt(fight.moon, jaguar.tile), s.raiseProjectile);
  }
  if (offset === 1 && !catchingUp) Common.sound(player, s.raiseSound);
  if (offset === 2) raiseJaguars(fight);
  if (offset === 3 && !catchingUp) drain(fight);
  if (offset === 3) for (const loc of fight.state.sigils ?? []) Common.locAnim(player, loc, s.sigilIdleAnim);
  if (!catchingUp && offset >= s.poolFirst && (offset - s.poolFirst) % s.every === 0 && fight.state.poolWaves < s.waves) addRingPools(fight);
  if (!catchingUp) tickPools(fight);
  if (!catchingUp && offset >= s.strikeFirst && (offset - s.strikeFirst) % s.every === 0) strike(fight);
  if (offset === s.sigilsGo) dropSigils(fight);
  if (offset === s.retreat) retreat(fight);
  if (offset === s.remove) {
    for (const jaguar of fight.state.jaguars ?? []) Pieces.removeNpc(fight, jaguar.npc);
    fight.state.jaguars = [];
  }
}

function raiseJaguars(fight) {
  const s = spec();
  if (fight.state.raised) return;
  fight.state.raised = true;
  fight.state.sigils = [];
  s.jaguars.forEach((jaguar, focus) => {
    const npc = Pieces.spawnNpc(fight, s.npc, jaguar.tile, { face: jaguar.face, anim: s.spawnAnim });
    if (npc) {
      npc.setHitpointsLocked(true);
      npc.__moonJaguar = { focus };
      fight.state.jaguars.push({ npc, focus, front: jaguar.front });
    }
    fight.state.sigils.push(Pieces.addLoc(fight, jaguar.sigil, jaguar.tile, { shape: 11, anim: s.sigilSpawnAnim }));
  });
  const glyph = Common.data.glyphs[fight.state.safe];
  fight.state.glow = Pieces.spawnNpc(fight, s.glowNpcs[fight.state.safe], glyph, { anim: Common.data.threatCircle.spawnAnim });
}

function drain(fight) {
  const { player } = fight;
  player.sendMessage(spec().drainMessage);
  const dealt = fight.hurt(Common.randomInt(1, spec().drainMax));
  fight.heal(dealt);
}

function addRingPools(fight) {
  const s = spec();
  fight.state.poolWaves++;
  Common.sounds(fight.player, s.poolSounds);
  const locs = RING.map((tile) => ({ tile, loc: Pieces.addLoc(fight, s.pool, tile, { anim: s.poolIdleAnim }) }));
  fight.state.pools.push({ locs, hit: false, age: 0 });
}

/** Pools age: the despawn animation after 3 ticks, gone after 5; standing in a fresh one hurts. */
function tickPools(fight) {
  const s = spec();
  const here = Pieces.playerOffset(fight);
  for (const pool of [...fight.state.pools]) {
    pool.age++;
    if (pool.age === s.poolDespawnAge) for (const { loc } of pool.locs) Common.locAnim(fight.player, loc, s.poolDespawnAnim);
    if (pool.age >= s.poolGoneAge) {
      for (const { loc } of pool.locs) Pieces.removeLoc(fight, loc);
      fight.state.pools.splice(fight.state.pools.indexOf(pool), 1);
      continue;
    }
    if (pool.hit || pool.age >= s.poolDespawnAge) continue;
    const under = pool.locs.find(({ tile }) => sameTile(tile, here));
    if (!under) continue;
    pool.hit = true;
    Common.locAnim(fight.player, under.loc, s.poolAttackAnim);
    const dealt = fight.hurt(Common.randomInt(1, s.poolMax));
    fight.heal(dealt * s.poolHeal);
  }
}

function strike(fight) {
  const s = spec();
  Common.sounds(fight.player, s.strikeSounds);
  const here = Pieces.playerOffset(fight);
  let struck = false;
  for (const jaguar of fight.state.jaguars ?? []) {
    if (jaguar.npc?.isRegistered?.()) Common.animate(jaguar.npc, s.strikeAnim);
    if (!struck && jaguar.front.some((tile) => sameTile(tile, here))) struck = true;
  }
  if (!struck) return;
  const dealt = fight.hurt(Common.randomInt(1, s.strikeMax));
  fight.heal(dealt * s.strikeHeal);
}

function dropSigils(fight) {
  const s = spec();
  for (const loc of fight.state.sigils ?? []) {
    Common.locAnim(fight.player, loc, s.sigilDespawnAnim);
    Pieces.removeLoc(fight, loc);
  }
  fight.state.sigils = [];
  Pieces.removeNpc(fight, fight.state.glow);
  fight.state.glow = null;
}

function retreat(fight) {
  const s = spec();
  for (const jaguar of fight.state.jaguars ?? []) {
    if (jaguar.npc?.isRegistered?.()) Common.animate(jaguar.npc, s.retreatAnim);
  }
  fight.state.retreated = true;
}

function jaguarsStop(fight) {
  Pieces.clear(fight);
  if (fight.player.isRegistered()) Common.varbit(fight.player, "sapped", 0);
}

/** The Moon's channel while the jaguars live: its magic animation every 6 ticks from 3. */
function jaguarsShared(arena, offset) {
  const s = spec();
  if (offset >= s.channelFirst && offset < s.sigilsGo && (offset - s.channelFirst) % s.every === 0) {
    Common.animate(arena.npc, s.channelAnim);
  }
}

/**
 * A hit on a jaguar: the safe glyph's gives back sapped hitpoints, healing the player; the jaguar
 * itself is never hurt. Returns true when the hit was a jaguar's.
 */
function hitJaguar(npc, hit) {
  const marker = npc?.__moonJaguar;
  const fight = npc?.__moonFight;
  if (!marker || !fight) return false;
  const damage = hit.getTotalDamage();
  const attacker = hit.getAttacker?.();
  if (attacker?.getAsPlayer?.() !== fight.player) return true;
  if (marker.focus !== fight.state.safe || (fight.state.sapped ?? 0) <= 0 || fight.state.retreated) {
    fight.player.sendMessage(spec().noBloodMessage);
    return true;
  }
  const back = Math.min(damage, fight.state.sapped);
  if (back <= 0) return true;
  fight.state.sapped -= back;
  Common.varbit(fight.player, "sapped", fight.state.sapped);
  const { Skill } = Common.core;
  const skills = fight.player.getSkillManager();
  const max = skills.getMaxLevel(Skill.HITPOINTS);
  skills.setCurrentLevel(Skill.HITPOINTS, Math.min(max, skills.getCurrentLevel(Skill.HITPOINTS) + back), true);
  fight.player.showHitsplat(back, { mine: HEAL_SPLAT, others: HEAL_SPLAT });
  return true;
}

const HEAL_SPLAT = 6;

// ------------------------------------------------------------------ Blood Rain

/** Where a player who joins during the rain lands: a random tile under it. */
function rainTile() {
  const { area } = rainSpec();
  return [Common.randomInt(area[0], area[1]), Common.randomInt(area[2], area[3])];
}

function rainStart(fight, offset) {
  fight.state.rain = [];
  fight.state.chip = 0;
  if (offset > rainSpec().fireAt) addFire(fight);
}

function rainTick(fight, offset) {
  const s = rainSpec();
  if (offset === s.throwAt) Pieces.knockBack(fight, rainTile());
  if (offset === s.fireAt) addFire(fight);
  if (offset === s.soundsAt) for (const id of s.areaSounds) Common.areaSound(fight.player, Common.tileAt(fight.moon, [2, 2]), [id, 0], 20);
  if (offset >= s.poolsFrom && offset <= s.poolsTo) rainPools(fight, offset);
  ageRain(fight);
  if (offset >= s.poolsFrom && offset <= s.poolsTo && ++fight.state.chip % s.chipEvery === 0) fight.selfDamage(1);
}

function addFire(fight) {
  const s = rainSpec();
  if (fight.state.fire) return;
  fight.state.fire = true;
  const [min, max] = s.fireRing;
  const tiles = [];
  for (let i = min + 1; i < max; i++) {
    tiles.push({ tile: [i, min], rotation: 1 }, { tile: [i, max], rotation: 1 });
    tiles.push({ tile: [min, i], rotation: 0 }, { tile: [max, i], rotation: 0 });
  }
  // The fire rises from the corners: each tile's animation is delayed by its distance from one.
  for (const { tile, rotation } of tiles) {
    const along = rotation === 1 ? tile[0] : tile[1];
    const fromCorner = Math.min(along - min, max - along) - 1;
    Pieces.addLoc(fight, s.fire, tile, { rotation, anim: s.fireAnims[Math.min(fromCorner, s.fireAnims.length - 1)] });
  }
}

function rainPools(fight, offset) {
  const s = rainSpec();
  Common.sound(fight.player, offset % 2 === 0 ? s.sounds[0] : s.sounds[1]);
  const count = Common.randomInt(s.perTick[0], s.perTick[1]);
  const [x1, x2, y1, y2] = s.area;
  // A tile holds one pool at a time: a second would restart the first's animation, and the
  // first's removal would take the second with it.
  const used = new Set(fight.state.rain.map(({ tile }) => `${tile[0]},${tile[1]}`));
  for (let i = 0; i < count; i++) {
    const tile = [Common.randomInt(x1, x2), Common.randomInt(y1, y2)];
    const key = `${tile[0]},${tile[1]}`;
    if (used.has(key)) continue;
    used.add(key);
    const loc = Pieces.addLoc(fight, Common.data.specials.jaguars.pool, tile, { anim: s.idleAnim });
    fight.state.rain.push({ tile, loc, age: 0, hit: false });
  }
}

function ageRain(fight) {
  const s = rainSpec();
  const here = Pieces.playerOffset(fight);
  for (const pool of [...fight.state.rain]) {
    pool.age++;
    if (pool.age === s.despawnAge) Common.locAnim(fight.player, pool.loc, s.despawnAnim);
    if (pool.age >= s.goneAge) {
      Pieces.removeLoc(fight, pool.loc);
      fight.state.rain.splice(fight.state.rain.indexOf(pool), 1);
      continue;
    }
    if (pool.hit || !sameTile(pool.tile, here)) continue;
    pool.hit = true;
    Common.locAnim(fight.player, pool.loc, Common.data.specials.jaguars.poolAttackAnim);
    const dealt = fight.hurt(Common.randomInt(1, s.max));
    fight.heal(dealt * s.heal);
  }
}

function rainStop(fight) {
  Pieces.clear(fight);
}

function rainShared(arena, offset) {
  const s = rainSpec();
  if (offset === s.throwAt) {
    Common.animate(arena.npc, s.castAnim);
    for (const fight of arena.fights.values()) Common.areaSound(fight.player, arena.centre(), [s.castSound, 25], 20);
  }
  if (offset === s.fadeAt) Common.animate(arena.npc, s.fadeAnim);
  if (offset === s.leaveAt) arena.setHidden(true);
  if (offset === s.backAt) {
    arena.setHidden(false);
    Common.animate(arena.npc, s.appearAnim);
  }
}

function rainLanding(arena) {
  return Common.tileAt(arena.moon, rainTile());
}

// ------------------------------------------------------------------ hooks

function onHit({ npc, hit }) {
  hitJaguar(npc, hit);
}

module.exports = function attachBloodMoon(api) {
  Cycle.registerSpecial("jaguars", { name: "jaguars", start: jaguarsStart, tick: jaguarsTick, stop: jaguarsStop, shared: jaguarsShared });
  Cycle.registerSpecial("rain", { name: "rain", start: rainStart, tick: rainTick, stop: rainStop, shared: rainShared, landing: rainLanding });
  api.onNpcHitModify(onHit);
};
