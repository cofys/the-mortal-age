/**
 * Shared Araxxor constants and pure combat math.
 *
 * Behaviour: https://oldschool.runescape.wiki/w/Araxxor and
 * https://oldschool.runescape.wiki/w/Araxxor/Strategies (attack pattern, egg hatching,
 * specials, enrage, corpse harvest/destroy, max hits, prayers), checked against rsprox
 * captures (below).
 *
 * Ids from the cache (rev 241): NPCs 13668 (Araxxor, 7x7) / 13669 (corpse, Harvest+Destroy)
 * / eggs 13670 (Mirrorback), 13672 (Ruptura), 13674 (Acidic) / minions 13671, 13673, 13675 /
 * 13676 (unnamed acid ball). Object 54148 is the acid pool (shape 10, rotation 0).
 * Animations as captured: 11482 spawn, 11480 melee, 11479 magic (no projectile), 11478
 * ranged (projectile 2924), 11476 acid ball throw, 11491 ball rolling, 11492 ball burst,
 * 11487 cleave (with the "Skree!" say), 11488/11489 enrage, 11481 death, 11486 corpse sink,
 * 11506 egg settle, 11503 hatch, 11508 egg crumble, 11498 Acidic attack, 11500 Mirrorback
 * attack, 11510 Ruptura burst. Graphics 2927/2928/2929 are the Acidic/Ruptura/Mirrorback
 * hatch marks, 2926 the Acidic death spray.
 *
 * Checked against rsprox captures (https://rsprox.net/database; 48 recordings of 13668,
 * 27 of the corpse, 30-34 of each araxyte): the instance spawn of boss + all nine eggs, the
 * every-6-tick attack cadence, the special that replaces every seventh attack, the hatch
 * after 3 standards then every 6 standards (Wiki), the enrage at 25%, the death
 * at +5 ticks into the corpse, and the harvest animation 2282. Still unverified: mirrorback
 * melee anim, drip flight values, cleave pool spread, pool ramp and the destroy clue roll.
 */
const SIZE = 7;
const MAX_HITPOINTS = 1020;

const BOSS_ID = 13668;
const CORPSE_ID = 13669;
const BALL_ID = 13676;
const ACID_POOL_OBJECT = 54148;

const EGG_ID = Object.freeze({ mirrorback: 13670, ruptura: 13672, acidic: 13674 });
const MINION_ID = Object.freeze({ mirrorback: 13671, ruptura: 13673, acidic: 13675 });
const HATCH_GFX = Object.freeze({ mirrorback: 2929, ruptura: 2928, acidic: 2927 });

/** Boss tile, arena centre and the nine egg tiles, as Near-Reality and the captures place them. */
const SPAWN_TILE = [3631, 9812, 0];
const CENTRE_TILE = [3633, 9816];
/**
 * The nine eggs in hatch order (Wiki): first the south-easternmost, then clockwise.
 * Index 0 is the SE egg (3643, 9806); compass bearings from the centre increase
 * through the table. The first egg's colour picks the fight's special, so
 * pattern[0] is the SE egg.
 */
const EGG_TILES = Object.freeze([
  [3643, 9806], [3637, 9803], [3631, 9803],
  [3626, 9807], [3621, 9813], [3621, 9822],
  [3631, 9826], [3637, 9826], [3644, 9823],
]);

/** The lair interior: entering it grows the per-player instance, leaving destroys it.
 * The east wall's web tile (3655) stays outside, so the tunnel decides entry. */
const LAIR = Object.freeze({ minX: 3615, maxX: 3654, minY: 9797, maxY: 9835 });

/** The three fixed egg patterns; the first egg's type picks the special for the fight. */
const PATTERNS = Object.freeze([
  ["acidic", "mirrorback", "ruptura", "acidic", "mirrorback", "ruptura", "acidic", "mirrorback", "ruptura"],
  ["mirrorback", "ruptura", "acidic", "mirrorback", "ruptura", "acidic", "mirrorback", "ruptura", "acidic"],
  ["ruptura", "acidic", "mirrorback", "ruptura", "acidic", "mirrorback", "ruptura", "acidic", "mirrorback"],
]);

/** Attack cadence: standards every 6 ticks; every 7th attack cycle becomes the special. */
const ATTACK_SPEED_TICKS = 6;
const ENRAGED_SPEED_TICKS = 4;
const SPECIAL_EVERY_ATTACKS = 7;
/** Wiki: the first egg hatches after 3 standards, then every 6 standards. */
const FIRST_HATCH_STANDARDS = 3;
const HATCH_INTERVAL_STANDARDS = 6;
/** Captured: boss + eggs spawn together, first attack 6 ticks after the spawn animation. */
const ARM_TICKS = 6;
/** Fires from up to 10 tiles like Vorkath; melee only when edge-adjacent (checked in start). */
const ATTACK_DISTANCE = 10;

const MELEE_MAX = 38;
const MAGIC_MAX = 21;
const RANGED_MAX = 34;
/** Protect prayers (Wiki): melee caps at 5, missiles -45%, magic -50%, cleave -66%. */
const PROTECT_MELEE_CAP = 5;
const PROTECT_RANGED_FACTOR = 0.55;
const PROTECT_MAGIC_FACTOR = 0.5;
const CLEAVE_PROTECT_FACTOR = 0.34;
/** Wiki step-under: baiting him onto his own tiles hits him for 8-12. */
const CLEAVE_SELF_MIN = 8;
const CLEAVE_SELF_MAX = 12;
/** A living Mirrorback redirects a fifth of boss damage to itself, half of that back (Wiki). */
const MIRRORBACK_REDIRECT_FACTOR = 0.2;
const MIRRORBACK_RECOIL_FACTOR = 0.5;
/** On-hit drains (Wiki): a ranged hit drains 9% defence, a magic hit 9% prayer. */
const DRAIN_RANGED_DEFENCE = 0.09;
const DRAIN_MAGIC_PRAYER = 0.09;

const ENRAGE_THRESHOLD = 0.25;

/** Minions: 58 HP each (cache); Ruptura bursts for these (cache + captures). */
const MINION_HITPOINTS = 58;
const EGG_HITPOINTS = 65;
const MINION_MAX = 15;
/** Ruptura bursts by edge distance (Wiki): player 70/49/28/7, enemies 80/64/48/33. */
const RUPTURA_PLAYER_DAMAGE = [70, 49, 28, 7];
const RUPTURA_BOSS_DAMAGE = [80, 64, 48, 33];

/** Captured: the ball crosses about thirteen tiles before bursting. */
const BALL_ROLL_TILES = 13;
/** Captured as ~18 venom damage (Wiki). */
const BALL_DAMAGE = 18;
const SPLATTER_COUNT = 9;
const SPLATTER_SPREAD = 3;
/** Captured: the acidic death explodes into 13 blobs (both transcripts), not nine. */
const ACIDIC_DEATH_SPLATTER_COUNT = 13;
/** Estimated blob-landing damage: the Wiki says the splatter damages ("low venom damage")
 * before the pool forms; the captures show recurring small player hits on impact ticks
 * (8 at 1442 T74/T76, 1508 T410/T411/T454/T455) - well under the ~18 ball hit and above
 * the pool's starting 4. Revisit if exact values surface. */
const SPLAT_IMPACT_DAMAGE = 8;
/** Acid blob projectile (captured MapProjAnim id) and its cache-internal impact graphic. */
const ACID_PROJECTILE = 2924;
const MINION_PROJECTILE = 2925;
/** Captured landing of every blob: the 2923 splat at ground height with the 4135 splash. */
const ACID_SPLAT_GFX = 2923;
const ACID_SPLAT_SOUND = 4135;

/** Pool damage ramps while a player keeps standing in acid (Wiki; step values ours). */
const POOL_FIRST_DAMAGE = 4;
const POOL_DAMAGE_STEP = 2;
const POOL_MAX_DAMAGE = 20;
const DRIP_FOLLOW_TICKS = 6;

/** The corpse waits for the player's choice (Wiki: no respawn until Harvest or Destroy);
 * the cap is a safety net, and leaving the lair destroys it anyway. */
const CORPSE_TICKS = 6000;
const RESPAWN_TICKS = 10;
const HARVEST_ANIMATION = 2282;
const NID_ITEM_ID = 29836;
const ELITE_CLUE_ITEM_ID = 12073;
const DESTROY_PET_RATE = 1500;

const CORPSE_DESTROY_PROMPT =
  "Destroying the corpse will give no loot, but doubles your chance of receiving Nid (1/1500 instead of 1/3000). Are you sure you want to destroy it?";

/**
 * The enrage's screech, as the animations' embedded sounds read in the cache: 11488 rings
 * 9478/9391/9409 (frames 1/3/8) and 11489 rings 9480/9391/9478 (frames 1/8/10). Delays are
 * client cycles (three per frame).
 */
const ENRAGE_SOUNDS = Object.freeze({
  first: Object.freeze([[9478, 0], [9391, 9], [9409, 24]]),
  second: Object.freeze([[9480, 0], [9391, 24], [9478, 30]]),
});

/**
 * The captured enrage body: slot 0 (54289) becomes 54288, the venom-coated front legs,
 * while slot 1 (54290) stays (sent, as captured). Sent as an npc model customisation.
 */
const ENRAGE_MODELS = Object.freeze([
  Object.freeze({ slot: 0, modelId: 54288 }),
  Object.freeze({ slot: 1, modelId: 54290 }),
]);

function playSound(player, id, delay = 0) {
  player?.getPacketSender?.()?.sendSoundEffect(id, 1, delay);
}

/** NPC attribute keys (kebab-case, namespaced). */
const ATTR_ATTACKS = "araxxor:attacks";
const ATTR_STANDARDS = "araxxor:standards";
const ATTR_NEXT_HATCH = "araxxor:next-hatch";
const ATTR_ARMED_AT = "araxxor:armed-at";
const ATTR_ENRAGED = "araxxor:enraged";
const ATTR_DYING = "araxxor:dying";
const ATTR_ENCOUNTER = "araxxor:encounter";
const ATTR_SPECIAL = "araxxor:special";
const ATTR_DESTROY_NO_PROMPT = "araxxor:destroy-no-prompt";

const Attack = { MELEE: "melee", RANGED: "ranged", MAGIC: "magic", CLEAVE: "cleave" };

/**
 * The special for the primary araxyte (the first egg in the pattern): Acidic throws the
 * rolling ball, Mirrorback splatters acid onto the player, Ruptura drips a chasing pool.
 */
const SPECIAL_FOR_PRIMARY = Object.freeze({
  acidic: "ball",
  mirrorback: "splatter",
  ruptura: "drip",
});

/** Edge-to-edge Chebyshev distance between the 7x7 body and a 1x1 target. */
function edgeDistance(bossX, bossY, x, y) {
  const maxX = bossX + SIZE - 1;
  const maxY = bossY + SIZE - 1;
  const dx = x < bossX ? bossX - x : x > maxX ? x - maxX : 0;
  const dy = y < bossY ? bossY - y : y > maxY ? y - maxY : 0;
  return Math.max(dx, dy);
}

function underBoss(bossX, bossY, x, y) {
  return x >= bossX && x < bossX + SIZE && y >= bossY && y < bossY + SIZE;
}

function tileKey(x, y) {
  return `${x},${y}`;
}

/**
 * The nine splatter tiles around a point. Without a direction: offsets -3..2 on both axes
 * (Near-Reality's getAcidSplatterLocation, the acidic spider's death splash). With a
 * direction (dx, dy): a random spray biased outward along it - the Wiki's acid spray,
 * "sprays randomly outward in the player's general direction".
 */
function splatterTiles(x, y, isWalkable, direction = null, count = SPLATTER_COUNT) {
  const tiles = [];
  const dx = direction ? Math.sign(direction.x) : 0;
  const dy = direction ? Math.sign(direction.y) : 0;
  for (let index = 0; index < count; index++) {
    let tile;
    if (dx === 0 && dy === 0) {
      const ox = -3 + Math.floor(Math.random() * 6);
      const oy = -3 + Math.floor(Math.random() * 6);
      tile = [x + ox, y + oy];
    } else {
      const along = Math.floor(Math.random() * 5) - 1;
      const lateral = -3 + Math.floor(Math.random() * 7);
      tile = [
        x + dx * along - dy * lateral,
        y + dy * along + dx * lateral,
      ];
    }
    if (tile[0] === x && tile[1] === y) {
      tile[0] += 1;
    }
    tiles.push(tile);
  }
  return isWalkable ? tiles.filter(([tx, ty]) => isWalkable(tx, ty)) : tiles;
}

/** The three cleave pool tiles: the struck tile and one either side, perpendicular to the blow. */
function cleavePoolTiles(x, y, dx, dy) {
  if (dx === 0 && dy === 0) {
    return [[x, y], [x - 1, y], [x + 1, y]];
  }
  if (Math.abs(dx) >= Math.abs(dy)) {
    return [[x, y], [x, y - 1], [x, y + 1]];
  }
  return [[x, y], [x - 1, y], [x + 1, y]];
}

/** Pool damage for a player who has now stood in acid for `ticks` ticks. */
function poolDamage(ticks) {
  return Math.min(POOL_MAX_DAMAGE, POOL_FIRST_DAMAGE + Math.max(0, ticks - 1) * POOL_DAMAGE_STEP);
}

/** Straight-line walkability from (x0, y0) to (x1, y1), stepping like the engine (diagonal-first). */
function hasClearPath(x0, y0, x1, y1, isWalkable) {
  let x = x0;
  let y = y0;
  for (let guard = 0; guard < 64; guard++) {
    if (x === x1 && y === y1) return true;
    x += Math.sign(x1 - x);
    y += Math.sign(y1 - y);
    if (!isWalkable(x, y)) return false;
  }
  return false;
}

module.exports = {
  SIZE,
  MAX_HITPOINTS,
  BOSS_ID,
  CORPSE_ID,
  BALL_ID,
  ACID_POOL_OBJECT,
  EGG_ID,
  MINION_ID,
  HATCH_GFX,
  SPAWN_TILE,
  CENTRE_TILE,
  EGG_TILES,
  LAIR,
  PATTERNS,
  ATTACK_SPEED_TICKS,
  ENRAGED_SPEED_TICKS,
  SPECIAL_EVERY_ATTACKS,
  FIRST_HATCH_STANDARDS,
  HATCH_INTERVAL_STANDARDS,
  ARM_TICKS,
  ATTACK_DISTANCE,
  MELEE_MAX,
  MAGIC_MAX,
  RANGED_MAX,
  PROTECT_MELEE_CAP,
  PROTECT_RANGED_FACTOR,
  PROTECT_MAGIC_FACTOR,
  CLEAVE_PROTECT_FACTOR,
  CLEAVE_SELF_MIN,
  CLEAVE_SELF_MAX,
  MIRRORBACK_REDIRECT_FACTOR,
  MIRRORBACK_RECOIL_FACTOR,
  DRAIN_RANGED_DEFENCE,
  DRAIN_MAGIC_PRAYER,
  ENRAGE_THRESHOLD,
  MINION_HITPOINTS,
  EGG_HITPOINTS,
  MINION_MAX,
  RUPTURA_PLAYER_DAMAGE,
  RUPTURA_BOSS_DAMAGE,
  BALL_ROLL_TILES,
  BALL_DAMAGE,
  SPLATTER_COUNT,
  SPLATTER_SPREAD,
  ACIDIC_DEATH_SPLATTER_COUNT,
  SPLAT_IMPACT_DAMAGE,
  ACID_PROJECTILE,
  MINION_PROJECTILE,
  ACID_SPLAT_GFX,
  ACID_SPLAT_SOUND,
  POOL_FIRST_DAMAGE,
  POOL_DAMAGE_STEP,
  POOL_MAX_DAMAGE,
  DRIP_FOLLOW_TICKS,
  CORPSE_TICKS,
  RESPAWN_TICKS,
  HARVEST_ANIMATION,
  NID_ITEM_ID,
  ELITE_CLUE_ITEM_ID,
  DESTROY_PET_RATE,
  CORPSE_DESTROY_PROMPT,
  ATTR_ATTACKS,
  ATTR_STANDARDS,
  ATTR_NEXT_HATCH,
  ATTR_ARMED_AT,
  ATTR_ENRAGED,
  ATTR_DYING,
  ATTR_ENCOUNTER,
  ATTR_SPECIAL,
  ATTR_DESTROY_NO_PROMPT,
  ENRAGE_SOUNDS,
  ENRAGE_MODELS,
  playSound,
  Attack,
  SPECIAL_FOR_PRIMARY,
  edgeDistance,
  underBoss,
  tileKey,
  splatterTiles,
  cleavePoolTiles,
  poolDamage,
  hasClearPath,
  _test: {
    edgeDistance,
    underBoss,
    splatterTiles,
    cleavePoolTiles,
    poolDamage,
    hasClearPath,
  },
};
