const ObstacleRunner = require("./agility/ObstacleRunner");
const { COURSES } = require("./agility/courses");
const { SHORTCUTS } = require("./agility/shortcuts");

/** Attribute holding { course, index } for the lap in progress. */
const PROGRESS_ATTRIBUTE = "agility.progress";
/** Persisted { [courseKey]: laps } map. */
const LAPS_ATTRIBUTE = "agility.laps";
/**
 * Persisted: the lap count chat message is off (Grace's Toggle Counter). Laps are still
 * counted (OSRS Wiki, Grace).
 */
const LAP_COUNTER_OFF_ATTRIBUTE = "agility.lap-counter-off";

/**
 * Marks of grace appear on rooftop courses while a lap is in progress. One roll per
 * lap, at the first obstacle; players 20+ levels over the course get a lower rate.
 */
const MARK_LAP_CHANCE = 1 / 4;
const MARK_OVERLEVELLED_MULTIPLIER = 0.75;
const MARK_OVERLEVEL_THRESHOLD = 20;

/** objectId -> obstacle entries; entries with `at` only match that object tile. */
const OBSTACLES_BY_OBJECT = new Map();
/** npcId -> the course obstacle done on that NPC (Werewolf's stick hand-in). */
const OBSTACLES_BY_NPC = new Map();

let pluginApi;
let core;
let ItemOnGroundManager;

function indexObstacle(obstacle) {
  if (obstacle.npc != null) {
    OBSTACLES_BY_NPC.set(obstacle.npc, obstacle);
    return;
  }
  const objects = Array.isArray(obstacle.object) ? obstacle.object : [obstacle.object];
  for (const objectId of objects) {
    if (!Number.isInteger(objectId)) {
      throw new Error(`Agility obstacle "${obstacle.course?.name ?? "shortcut"}" has an invalid object id`);
    }
    const entries = OBSTACLES_BY_OBJECT.get(objectId) ?? [];
    entries.push(obstacle);
    OBSTACLES_BY_OBJECT.set(objectId, entries);
  }
}

function buildIndex() {
  for (const course of COURSES) {
    const obstacleXp = new Map();
    for (const obstacle of course.obstacles) {
      obstacle.course = course;
      if (obstacle.index != null) {
        obstacleXp.set(obstacle.index, Math.max(obstacleXp.get(obstacle.index) ?? 0, obstacle.xp ?? 0));
      }
      indexObstacle(obstacle);
    }
    course.finalIndex = Math.max(...obstacleXp.keys());
    course.obstacleXp = obstacleXp;
  }
  for (const course of COURSES) {
    // The lap bonus tops a full lap up to the course's published lap experience. A course that
    // shares its first obstacles with another counts those too, once.
    const shared = course.sharesWith ? COURSES.find((other) => other.key === course.sharesWith.course) : null;
    const sharedXp = shared ? [...shared.obstacleXp].filter(([index]) => index <= course.sharesWith.through) : [];
    const lapTotal = [...course.obstacleXp.values(), ...sharedXp.map(([, xp]) => xp)].reduce((sum, xp) => sum + xp, 0);
    course.lapBonus = Math.max(0, Math.round((course.lapXp - lapTotal) * 10) / 10);
  }
  for (const shortcut of SHORTCUTS) {
    indexObstacle(shortcut);
  }
}

/**
 * The obstacle on that tile. An object in more than one course (a shared start or finish) is the
 * entry that continues the player's lap, else the first.
 */
function findObstacle(objectId, location, player = null) {
  const entries = OBSTACLES_BY_OBJECT.get(objectId);
  if (!entries || !location) return null;
  const here = entries.filter((entry) => !entry.at || (
    entry.at[0] === location.x && entry.at[1] === location.y && (entry.at[2] ?? location.z) === location.z
  ));
  if (here.length > 1 && player) {
    const progress = player.getAttribute(PROGRESS_ATTRIBUTE);
    const continuing = here.find((entry) => entry.course && continuesLap(progress, entry));
    if (continuing) return continuing;
  }
  return here[0] ?? null;
}

/**
 * Whether `obstacle` is the next one of the lap in `progress`: the same course, or a course that
 * shares its first obstacles (`sharesWith: { course, through }`) with the one the lap began on.
 */
function continuesLap(progress, obstacle) {
  if (!progress || progress.index !== obstacle.index - 1) return false;
  const course = obstacle.course;
  if (progress.course === course.key) return true;
  return course.sharesWith?.course === progress.course && progress.index <= course.sharesWith.through;
}

function objectContext(player, object) {
  const location = object.getLocation();
  const playerLocation = player.getLocation();
  return {
    player,
    object,
    core,
    obj: {
      x: location.getX(), y: location.getY(), z: location.getZ(),
      face: object.getFace?.() ?? 0, type: object.getType?.() ?? 10, id: object.getId(),
    },
    pos: { x: playerLocation.getX(), y: playerLocation.getY(), z: playerLocation.getZ() },
  };
}

function resolve(value, context) {
  return typeof value === "function" ? value(context) : value;
}

function agilityLevel(player) {
  return player.getSkillManager().getCurrentLevel(core.Skill.AGILITY);
}

/**
 * The OSRS skilling success roll the Wiki's success charts use: `low` and `high` out of 256,
 * interpolated over levels 1-99 (Wiki: Skilling success rate).
 */
function skillingChance(low, high, level) {
  const capped = Math.max(1, Math.min(99, level));
  return (1 + Math.floor((low * (99 - capped)) / 98 + (high * (capped - 1)) / 98 + 0.5)) / 256;
}

/**
 * Whether the obstacle succeeds. A `fail` block with `low`/`high` rolls the OSRS success chance;
 * the older linear one is `baseChance`% at the requirement, rising to certain success at
 * `neverFailLevel`. Obstacles without a `fail` block never fail.
 */
function rollSuccess(player, obstacle, requirement) {
  const fail = obstacle.fail;
  if (!fail) return true;
  const level = agilityLevel(player);
  if (fail.low != null && fail.high != null) {
    return Math.random() < skillingChance(fail.low, fail.high, level);
  }
  const never = fail.neverFailLevel ?? requirement + 20;
  if (level >= never) return true;
  const base = fail.baseChance ?? 75;
  const from = fail.fromLevel ?? requirement;
  const chance = base + (Math.max(0, level - from) * (100 - base)) / Math.max(1, never - from);
  return Math.random() * 100 < chance;
}

function getLaps(player) {
  const laps = player.getAttribute(LAPS_ATTRIBUTE);
  return laps && typeof laps === "object" ? laps : {};
}

function completeLap(player, course) {
  const laps = { ...getLaps(player) };
  laps[course.key] = (laps[course.key] ?? 0) + 1;
  player.setAttribute(LAPS_ATTRIBUTE, laps);
  if (course.lapBonus > 0) {
    player.getSkillManager().addExperiences(core.Skill.AGILITY, course.lapBonus);
  }
  if (!player.getAttribute(LAP_COUNTER_OFF_ATTRIBUTE)) {
    player.sendMessage(`Your ${course.name} lap count is: <col=ff0000>${laps[course.key]}</col>.`);
  }
  pluginApi.emitCustomEvent("agility:lap", { player, course: course.key, laps: laps[course.key] });
  // The giant squirrel rolls once per completed course.
  pluginApi.emitCustomEvent("agility:success", { player, skill: core.Skill.AGILITY, petBase: course.petBase });
}

/** Grace's Toggle Counter: turns the lap count message off or back on. Guessed messages. */
function toggleLapCounter({ player }) {
  const off = !player.getAttribute(LAP_COUNTER_OFF_ATTRIBUTE);
  player.setAttribute(LAP_COUNTER_OFF_ATTRIBUTE, off);
  player.sendMessage(off
    ? "Your lap count will no longer be shown when you complete a lap."
    : "Your lap count will now be shown when you complete a lap.");
}

/**
 * Tracks lap order: obstacle 1 always starts a lap; any other obstacle only
 * continues it when it directly follows the last one (alternates share an index).
 */
function advanceCourse(player, obstacle) {
  const course = obstacle.course;
  const progress = player.getAttribute(PROGRESS_ATTRIBUTE);
  let next = null;
  if (obstacle.index === 1) {
    next = { course: course.key, index: 1 };
    rollMarkOfGrace(player, course);
  } else if (continuesLap(progress, obstacle)) {
    next = { course: course.key, index: obstacle.index };
  }
  if (next && obstacle.index === course.finalIndex) {
    player.setAttribute(PROGRESS_ATTRIBUTE, null);
    completeLap(player, course);
    return;
  }
  player.setAttribute(PROGRESS_ATTRIBUTE, next);
}

function rollMarkOfGrace(player, course) {
  const marks = course.marks;
  if (!marks || marks.tiles.length === 0) return;
  let chance = MARK_LAP_CHANCE;
  if (agilityLevel(player) >= marks.level + MARK_OVERLEVEL_THRESHOLD) {
    chance *= MARK_OVERLEVELLED_MULTIPLIER;
  }
  if (Math.random() >= chance) return;
  const tile = marks.tiles[Math.floor(Math.random() * marks.tiles.length)];
  const position = new core.Location(tile[0], tile[1], tile[2]);
  ItemOnGroundManager.registerNonGlobals(player, new core.Item(core.ItemIds.MARK_OF_GRACE, 1), position);
}

function finishObstacle(player, obstacle, success, completed) {
  if (!completed) {
    return;
  }
  const reward = success ? obstacle.xp : obstacle.fail?.xp;
  const xp = typeof reward === "function" ? reward(player) : reward;
  if (xp > 0) {
    player.getSkillManager().addExperiences(core.Skill.AGILITY, xp);
  }
  const endMessage = success ? obstacle.end : obstacle.fail?.end;
  if (endMessage) {
    player.sendMessage(endMessage);
  }
  if (!success) {
    return;
  }
  // OSRS rooftop obstacles restore 1–2% energy; shortcuts and other courses do not.
  // ponytail: use the documented 1% minimum until per-obstacle captures establish 2% overrides.
  if (obstacle.course?.name.includes("Rooftop")) {
    player.setRunEnergy(player.getRunEnergy() + 1);
    player.getPacketSender().sendRunEnergy();
  }
  obstacle.onSuccess?.(player);
  if (obstacle.takes != null) {
    takeAll(player, obstacle.takes);
  }
  if (obstacle.course && obstacle.index != null) {
    advanceCourse(player, obstacle);
  }
}

/** Shortcuts within a course (portals) continue the lap from a later obstacle. */
function skipAhead(player, obstacle, context) {
  const progress = player.getAttribute(PROGRESS_ATTRIBUTE);
  if (progress?.course === obstacle.course?.key) {
    player.setAttribute(PROGRESS_ATTRIBUTE, { course: progress.course, index: resolve(obstacle.skipTo, context) });
  }
}

function skillMessage(skillName, level) {
  const name = skillName[0].toUpperCase() + skillName.slice(1);
  const article = /^[AEIOU]/.test(name) ? "an" : "a";
  return `You need ${article} ${name} level of at least ${level} to attempt this.`;
}

/** Why `requirement` isn't met, or null. Quests and diaries this server doesn't know are no bar. */
function unmet(player, requirement) {
  for (const [skillName, level] of Object.entries(requirement.skills ?? {})) {
    const skill = core.Skill[skillName.toUpperCase()];
    if (player.getSkillManager().getCurrentLevel(skill) < level) return skillMessage(skillName, level);
  }
  const worn = player.getEquipment().getItems();
  for (const item of requirement.equipped ?? []) {
    const held = worn[core.Equipment[`${item.slot.toUpperCase()}_SLOT`]];
    const name = String(held?.getDefinition?.()?.getName?.() ?? "").toLowerCase();
    const matches = item.ids ? item.ids.includes(held?.getId?.()) : item.name ? name.includes(item.name) : false;
    if (!matches) return item.message;
  }
  for (const item of requirement.items ?? []) {
    if (!item.ids.some((id) => player.getInventory().contains(id))) return item.message;
  }
  for (const { key, stage = "complete", message } of [].concat(requirement.quest ?? [])) {
    const request = { player, key, complete: null, started: null };
    pluginApi.emitCustomEvent(stage === "started" ? "quest:is-started" : "quest:is-complete", request);
    if ((stage === "started" ? request.started : request.complete) === false) return message;
  }
  if (requirement.diary?.enforce) {
    const { key, tier, message } = requirement.diary;
    const request = { player, diary: key, tier, complete: null };
    pluginApi.emitCustomEvent("diary:is-complete", request);
    if (request.complete === false) return message;
  }
  return null;
}

/**
 * The obstacle as this player can use it: with `requires`, the first alternative they meet
 * (which may bring its own steps), else the refusal of the first alternative. Without it, the
 * Agility level.
 */
function usable(player, obstacle, level) {
  if (!obstacle.requires) {
    return agilityLevel(player) < level
      ? { refusal: `You need an Agility level of at least ${level} to attempt this.` }
      : { obstacle };
  }
  let refusal = null;
  for (const alternative of obstacle.requires) {
    const reason = unmet(player, alternative);
    if (!reason) {
      const { steps, start, end } = alternative;
      return { obstacle: { ...obstacle, ...(steps ? { steps } : {}), ...(start ? { start } : {}), ...(end ? { end } : {}) } };
    }
    refusal ??= reason;
  }
  return { refusal };
}

function attemptObstacle(player, object, entry) {
  const context = objectContext(player, object);
  const level = resolve(entry.level, context);
  const { obstacle, refusal } = usable(player, entry, level);
  if (refusal) {
    player.sendMessage(refusal);
    return;
  }
  const blocked = obstacle.precondition?.(context);
  if (blocked) {
    player.sendMessage(blocked);
    return;
  }
  const success = rollSuccess(player, obstacle, level);
  const steps = resolve(success ? obstacle.steps : obstacle.fail.steps, context);
  if (!steps) return;
  pluginApi.emitCustomEvent("agility:obstacle-start", { player, objectId: object.getId(), location: context.obj, success });
  const startMessage = success ? obstacle.start : obstacle.fail?.start ?? obstacle.start;
  if (startMessage) {
    player.sendMessage(startMessage);
  }
  ObstacleRunner.run(context, steps, {
    render: success ? obstacle.render : obstacle.fail?.render ?? obstacle.render,
    onFinish: (completed) => {
      finishObstacle(player, obstacle, success, completed);
      if (completed && success) {
        pluginApi.emitCustomEvent("agility:obstacle", { player, objectId: object.getId(), location: context.obj });
      }
      if (completed && success && obstacle.skipTo != null) {
        skipAhead(player, obstacle, context);
      }
    },
  });
}

function routeToObstacle(event) {
  const location = event.object.getLocation();
  const obstacle = findObstacle(event.objectId, { x: location.getX(), y: location.getY(), z: location.getZ() }, event.player);
  if (!obstacle?.route || event.clickType !== 1) return;
  const tile = resolve(obstacle.route, objectContext(event.player, event.object));
  if (tile) {
    event.destination = { x: tile[0], y: tile[1], z: tile[2] ?? location.getZ() };
  }
}

function operateObstacle(event) {
  const obstacle = findObstacle(event.objectId, event.location, event.player);
  if (!obstacle) return false;
  if (ObstacleRunner.isBusy(event.player)) return true;
  attemptObstacle(event.player, event.object, obstacle);
  return true;
}

/** Removes every `itemId` the player carries (Werewolf: all sticks go when one is handed in). */
function takeAll(player, itemId) {
  const amount = player.getInventory().getAmount(itemId);
  if (amount > 0) {
    player.getInventory().delete(itemId, amount);
  }
}

/**
 * A course obstacle done on an NPC (Werewolf's Agility Trainer, "Give-Stick"): its requirement
 * and precondition, then XP, end message and the lap, as for an object.
 */
function operateNpcObstacle(event) {
  const { player, npc } = event;
  const obstacle = OBSTACLES_BY_NPC.get(event.npcId ?? npc.getId());
  if (!obstacle) return false;
  if (ObstacleRunner.isBusy(player)) return true;
  const { refusal } = usable(player, obstacle, obstacle.level);
  const blocked = refusal ?? obstacle.precondition?.({ player, npc, core });
  if (blocked) {
    player.sendMessage(blocked);
    return true;
  }
  finishObstacle(player, obstacle, true, true);
  return true;
}

/** A course's own ladder (Shayzien's start) is an obstacle, not one the Ladders plugin climbs. */
function claimLadderObstacle(request) {
  const location = request.object.getLocation();
  const obstacle = findObstacle(request.objectId, { x: location.getX(), y: location.getY(), z: location.getZ() }, request.player);
  if (!obstacle) return;
  request.handled = true;
  if (ObstacleRunner.isBusy(request.player)) return;
  attemptObstacle(request.player, request.object, obstacle);
}

function blockTeleportMidObstacle(event) {
  if (ObstacleRunner.isBusy(event.player)) {
    event.allow = false;
  }
}

function finishObstacleOnLogout({ player }) {
  ObstacleRunner.completeNow(player);
}

buildIndex();

/**
 * Bot helpers for citizen agility training (mirrors the Crafting/Herblore/
 * Fletching/Runecrafting `startBot*` pattern). Citizens run courses via the
 * real object-click path — attemptObstacle -> ObstacleRunner -> finishObstacle
 * — so no session wrapper is needed; the helpers below are the course
 * selection and busy-state reads the brain action needs.
 */

/** Uniform required level of a course (all courses ship uniform levels). */
function courseLevel(course) {
  try {
    const levels = (course?.obstacles ?? [])
      .filter((o) => o && typeof o.level === "number")
      .map((o) => o.level);
    return levels.length ? Math.max(...levels) : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Courses bots must never train on (lawless zones, per the PvP design). */
const BOT_EXCLUDED_COURSES = new Set(["wilderness"]);

/**
 * Best course for an agility level: highest-level course the player qualifies
 * for, excluding lawless zones. Returns null when nothing qualifies (level 1
 * always matches Gnome Stronghold / Shayzien Basic).
 */
function findBestCourseForLevel(level) {
  let best = null;
  let bestLevel = -1;
  for (const course of COURSES) {
    if (!course || BOT_EXCLUDED_COURSES.has(course.key)) continue;
    const lvl = courseLevel(course);
    if (lvl <= level && lvl > bestLevel) {
      best = course;
      bestLevel = lvl;
    }
  }
  return best;
}

/** True while the player is mid-obstacle (ObstacleRunner busy attribute). */
function isObstacleRunning(player) {
  try {
    return ObstacleRunner.isBusy(player);
  } catch {
    return false;
  }
}

/** The player's current lap progress ({ course, index }) or null. */
function getLapProgress(player) {
  try {
    return player?.getAttribute?.(PROGRESS_ATTRIBUTE) ?? null;
  } catch {
    return null;
  }
}

module.exports = {
  name: "Agility",
  members: true,
  findBestCourseForLevel,
  isObstacleRunning,
  getLapProgress,
  courseLevel,
  AGILITY_COURSES: COURSES,
  register(api) {
    pluginApi = api;
    core = api.core;
    ItemOnGroundManager = api.getItemOnGroundManager();
    ObstacleRunner.init(api);

    api.persistAttribute(PROGRESS_ATTRIBUTE);
    api.persistAttribute(LAPS_ATTRIBUTE);
    api.persistAttribute(LAP_COUNTER_OFF_ATTRIBUTE);
    api.onNpcInteraction("Grace", { "Toggle Counter": toggleLapCounter });
    api.onObjectRoute(routeToObstacle);
    api.onObjectFirstClick([...OBSTACLES_BY_OBJECT.keys()], operateObstacle);
    api.onCustomEvent("ladders:climb", claimLadderObstacle);
    api.onNpcInteraction("Agility Trainer", { "Give-Stick": operateNpcObstacle });
    api.onCanTeleport(blockTeleportMidObstacle);
    api.onPlayerLogout(finishObstacleOnLogout);

    api.log("registered", {
      courses: COURSES.length,
      shortcuts: SHORTCUTS.length,
      objects: OBSTACLES_BY_OBJECT.size,
    });
  },
};
