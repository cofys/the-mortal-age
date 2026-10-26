"use strict";

// Content is Jagex's clue-helper catalogue in the installed cache, as for beginner clues.
// From easy upwards every step is its own "Clue scroll (<tier>)" item whose param links it
// to its clue-helper row, so the item in the player's hand is the step being solved.
const CLUE_ROW_PARAM = 623;
// An item's clue item group (ring of dueling 18, amulet of glory 6): an outfit slot listing a
// group accepts any item of that group.
const TRAIL_ITEM_GROUP_PARAM = 258;
const WORN_SLOTS = { hat: "HEAD_SLOT", back: "CAPE_SLOT", front: "AMULET_SLOT", rhand: "WEAPON_SLOT", torso: "BODY_SLOT", lhand: "SHIELD_SLOT",
  legs: "LEG_SLOT", hands: "HANDS_SLOT", feet: "FEET_SLOT", ring: "RING_SLOT", quiver: "AMMUNITION_SLOT" };
// Sherlock's rows are steps only where the clue is the task (master); elsewhere they have no clue item.
const STEP_TABLES = ["anagram", "cipher", "coordinate", "cryptic", "emote", "fairyring", "hotcold", "map", "music", "skillchallenge"];
const MAP_INTERFACES = require("./data/map-interfaces.json");

function coordinate(packed) {
  return { x: (packed >>> 14) & 16383, y: packed & 16383, z: packed >>> 28 };
}

/** "00.05S 01.13E" as the scroll reads it: "00 degrees 05 minutes south", then east/west. */
function coordinateText(text) {
  const parts = String(text).trim().split(/\s+/).map(part => /^(\d+)\.(\d+)([NSEW])$/.exec(part));
  if (parts.length !== 2 || parts.some(part => !part)) return text;
  const word = { N: "north", S: "south", E: "east", W: "west" };
  return parts.map(([, degrees, minutes, direction]) => `${degrees} degrees ${minutes} minutes ${word[direction]}`).join("<br>");
}

function load(core, tier) {
  const C = core.CacheDefinitions;
  const scrollName = `Clue scroll (${tier.name})`;
  function value(row, name, fallback = null) {
    const column = C.getDbColumn(row.tableId, name);
    return column == null ? fallback : row.column(column)[0] ?? fallback;
  }
  function values(row, name) {
    const column = C.getDbColumn(row.tableId, name);
    return column == null ? [] : row.column(column);
  }
  function tableName(row) {
    return C.getGamevals().allTables().get(row.tableId)?.name ?? "";
  }
  function morphs(ids) {
    const found = new Set();
    function include(id) {
      if (id == null || id < 0 || found.has(id)) return;
      found.add(id);
      // Targets can name a multi-NPC or multi-loc base while the interaction names its live morph.
      for (const morph of C.getNpc(id)?.transforms ?? []) include(morph);
    }
    ids.forEach(include);
    return [...found];
  }
  function target(row) {
    // "Combine the torn clue scroll parts" has no target.
    if (value(row, "target") == null) return { targetRow: null, target: "none", location: null, description: "" };
    const targetRow = C.getDbRow(value(row, "target"));
    const kind = tableName(targetRow).replace("cluehelper_target_", "");
    const location = coordinate(value(targetRow, "coord") ?? value(targetRow, "loc_coord"));
    const base = { targetRow: targetRow.id, target: kind, location, description: value(targetRow, "description", "") };
    if (kind === "npc") return { ...base, npcIds: morphs([value(targetRow, "npc"), value(targetRow, "fallback_npc")]) };
    if (kind === "loc") return { ...base, locIds: [value(targetRow, "loc"), value(targetRow, "fallback_loc")].filter(id => id != null && id >= 0) };
    // Kill one of these NPCs for the step's key, then open the loc with it.
    if (kind === "key") return { ...base, locIds: values(targetRow, "loc"), npcIds: morphs(values(targetRow, "npcs")), keyItem: value(targetRow, "key") };
    // Kill one of these NPCs and it drops the next clue (elite cryptic clues).
    if (kind === "kill") return { ...base, npcIds: morphs(values(targetRow, "npcs")) };
    return base;
  }
  function outfit(row) {
    const outfitRow = value(row, "outfit") == null ? null : C.getDbRow(value(row, "outfit"));
    if (!outfitRow) return [];
    // One requirement per worn slot: any listed item, any item of the listed clue item group, or,
    // where the slot lists the cache's blank object ("and no boots"), nothing worn there at all.
    const blank = C.getObjId("blankobject");
    return C.getDbColumns(outfitRow.tableId).filter(name => name?.startsWith("wearpos_")).flatMap(name => {
      const listed = values(outfitRow, name);
      if (!listed.length) return [];
      if (name.startsWith("wearpos_param_")) return [{ group: listed[0] }];
      if (listed.includes(blank)) return [{ emptySlot: core.Equipment[WORN_SLOTS[name.slice("wearpos_".length)]] }];
      return [{ anyOf: listed.filter(id => id >= 0) }];
    });
  }
  /** A challenge scroll's question and its answer, both in the cache's question row. */
  function challenge(row) {
    const challengeRow = value(row, "challenge") == null ? null : C.getDbRow(value(row, "challenge"));
    if (!challengeRow || tableName(challengeRow) !== "cluehelper_challenge_question") return null;
    const [question, answer] = values(challengeRow, "question");
    return { row: challengeRow.id, key: C.getDbRowName(challengeRow.id), question, answer };
  }
  /** The fight a dig or emote summons; the cache names the exact NPC per step. */
  function encounter(row) {
    const encounterRow = value(row, "combat_encounter") == null ? null : C.getDbRow(value(row, "combat_encounter"));
    return encounterRow ? { key: C.getDbRowName(encounterRow.id), npcIds: values(encounterRow, "npcs") } : null;
  }
  /** A challenge box: "puzzle", "light" or "puzzle_or_light" (cluehelper_challenge_box_<kind>). */
  function box(row) {
    const challengeRow = value(row, "challenge") == null ? null : C.getDbRow(value(row, "challenge"));
    if (!challengeRow || tableName(challengeRow) !== "cluehelper_challenge_box") return null;
    return { kind: C.getDbRowName(challengeRow.id).replace("cluehelper_challenge_box_", "") };
  }
  function music(row) {
    const track = C.getDbRow(value(row, "music"));
    return { musicRow: track?.id ?? null, midi: track ? value(track, "midi") : null, track: track ? value(track, "displayname", "") : "",
      unlock: value(row, "unlock_text", "") };
  }

  /** Falo the Bard's songs (master): the song, and the item it is about, by item list or clue item group. */
  function songs() {
    const id = C.getDbTableId("cluehelper_clue_falobard");
    return C.getDbTableRows(id).filter(row => value(row, "difficulty") === tier.difficulty).map(row => {
      const wanted = C.getDbRow(value(row, "requirements"));
      const answer = tableName(wanted) === "cluehelper_requirement_obj_param_trail_item" ? { group: value(wanted, "item_group") } : { anyOf: values(wanted, "item") };
      return { row: row.id, key: C.getDbRowName(row.id), text: value(row, "clue_text", ""), targetRow: value(row, "target"), answer,
        description: value(wanted, "description", "") };
    });
  }

  /** Sherlock's skill challenges for the tier: the task and its stat requirements. */
  function skillTasks() {
    const id = C.getDbTableId("cluehelper_clue_skillchallenge");
    return C.getDbTableRows(id).filter(row => value(row, "difficulty") === tier.difficulty).map(row => ({
      row: row.id, key: C.getDbRowName(row.id), text: value(row, "clue_text", ""),
      requirements: values(row, "requirements").map(id => C.getDbRow(id)).filter(entry => tableName(entry) === "cluehelper_requirement_stat")
        .map(entry => ({ stat: value(entry, "stat"), level: value(entry, "level") })),
    }));
  }

  const steps = [];
  for (const family of STEP_TABLES) {
    const id = C.getDbTableId(`cluehelper_clue_${family}`);
    if (id == null) throw new Error(`Missing clue table cluehelper_clue_${family}`);
    for (const row of C.getDbTableRows(id)) {
      if (value(row, "difficulty") !== tier.difficulty) continue;
      const key = C.getDbRowName(row.id);
      const step = { row: row.id, key, family, text: value(row, "clue_text", ""), requirements: values(row, "requirements"), ...target(row) };
      if (family === "emote") Object.assign(step, { emotes: values(row, "emote"), equipment: outfit(row),
        stash: value(row, "hidey_hole_loc") == null ? null : { locId: value(row, "hidey_hole_loc"), location: coordinate(value(row, "hidey_hole_coord")) } });
      // Master's cryptics also name outfits ("Wear 3 Zamorakian items.", Sir Vyvin's white plate).
      else if (value(row, "outfit") != null) step.equipment = outfit(row);
      if (family === "map") step.interfaceId = MAP_INTERFACES[key] == null ? null : C.getInterfaceId(MAP_INTERFACES[key]);
      if (family === "music") Object.assign(step, music(row));
      if (family === "coordinate") step.text = coordinateText(step.text);
      const asked = challenge(row);
      if (asked) step.challenge = asked;
      const fight = encounter(row);
      if (fight) step.encounter = fight;
      const puzzle = box(row);
      if (puzzle) step.puzzle = puzzle;
      steps.push(step);
    }
  }

  // Only rows with a "Clue scroll (<tier>)" item are clue steps; quest scrolls share the tables.
  // A step with a challenge also has a "Challenge scroll (<tier>)" item on the same row.
  const challengeName = `Challenge scroll (${tier.name})`;
  const itemByRow = new Map(), challengeByRow = new Map();
  for (const id of C.getObjNames().keys()) {
    const definition = C.getItem(id);
    const row = definition?.params instanceof Map ? definition.params.get(CLUE_ROW_PARAM) : undefined;
    if (row == null) continue;
    if (definition.name === scrollName && !itemByRow.has(row)) itemByRow.set(row, id);
    if (definition.name === challengeName && !challengeByRow.has(row)) challengeByRow.set(row, id);
  }
  // Paired items go by gameval name: a puzzle box is "<clue gameval>_puzzlebox"; where a row has
  // no challenge scroll of its own (elite), the tier shares "trail_<tier>_<family>_challenge", and
  // Sherlock's clues ("trail_<tier>_skill_exp<n>") share "trail_<tier>_skill_challenge".
  const objIdByName = new Map([...C.getObjNames()].map(([id, objName]) => [objName, id]));
  // A tier whose rows have no clue items of their own (master) carries every step on its one clue
  // scroll, the row kept in the trail meta.
  const tierScroll = core.ItemIdentifiers[`CLUE_SCROLL_${tier.name.toUpperCase()}_`];
  const oneItem = !steps.some(step => itemByRow.has(step.row));
  const clueItem = step => itemByRow.get(step.row) ?? (oneItem ? tierScroll : undefined);
  // A tier with its own puzzle images (master) has a box item per image; otherwise the clue's own box.
  const tierBoxes = tier.puzzleBoxes ? Object.values(tier.puzzleBoxes).map(objName => objIdByName.get(objName)) : null;
  const clueSteps = steps.filter(step => clueItem(step) != null).map(step => {
    const itemId = clueItem(step);
    const resolved = { ...step, itemId };
    if (step.challenge) resolved.challenge = { ...step.challenge,
      itemId: challengeByRow.get(step.row) ?? objIdByName.get(`trail_${tier.name}_${step.family}_challenge`) ?? null };
    if (step.puzzle) {
      const kind = step.puzzle.kind;
      const itemIds = tierBoxes ?? [objIdByName.get(`${C.getObjNames().get(itemId)}_puzzlebox`)].filter(id => id != null);
      // "puzzle_or_light": the NPC hands over one or the other.
      resolved.puzzle = kind === "light" ? null : { kind, itemId: itemIds[0] ?? null, itemIds };
      if (kind !== "puzzle") resolved.light = { itemId: objIdByName.get("light_puzzle_box") ?? null };
      if (!resolved.puzzle) delete resolved.puzzle;
    }
    if (C.getObjNames().get(itemId)?.startsWith(`trail_${tier.name}_skill_`)) resolved.skill = { itemId: objIdByName.get(`trail_${tier.name}_skill_challenge`) ?? null };
    return resolved;
  });
  // Falo's own clue ("Falo the bard wants to see you.") targets the NPC his songs name.
  const songList = songs();
  for (const step of clueSteps) if (songList.some(song => song.targetRow === step.targetRow)) step.falo = true;
  const byRow = new Map(clueSteps.map(step => [step.row, step]));
  // Every item a trail of this tier can be held as: its clues, challenge scrolls and boxes.
  const byItem = new Map();
  for (const step of clueSteps) for (const id of stepItems(step)) if (!byItem.has(id)) byItem.set(id, step);
  const items = core.ItemIdentifiers;
  const name = tier.name.toUpperCase();
  return { tier, steps: clueSteps, byRow, byItem, scrollName, challengeName, oneItem, tasks: new Map(skillTasks().map(task => [task.row, task])),
    songs: songList,
    scroll: items[`CLUE_SCROLL_${name}_`], casket: items[`REWARD_CASKET_${name}_`],
    uri: C.getNpcId(`trail_${tier.name}_uri`), textInterface: C.getInterfaceId("trail_cluetext"),
    rewardInterface: C.getInterfaceId("trail_rewardscreen"), rewardInventory: 141 };
}

/** The items a step's trail can be held as: the clue, then any challenge scroll, puzzle or light box, or skill challenge. */
function stepItems(step) {
  return [step.itemId, step.challenge?.itemId, ...(step.puzzle?.itemIds ?? []), step.light?.itemId, step.skill?.itemId].filter(id => id != null);
}

module.exports = { load, stepItems, coordinate, coordinateText, CLUE_ROW_PARAM, TRAIL_ITEM_GROUP_PARAM, STEP_TABLES };
