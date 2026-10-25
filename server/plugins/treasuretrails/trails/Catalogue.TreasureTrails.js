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
const STEP_TABLES = ["anagram", "cipher", "coordinate", "cryptic", "emote", "fairyring", "falobard", "hotcold", "map", "music", "skillchallenge"];
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
    const targetRow = C.getDbRow(value(row, "target"));
    const kind = tableName(targetRow).replace("cluehelper_target_", "");
    const location = coordinate(value(targetRow, "coord") ?? value(targetRow, "loc_coord"));
    const base = { targetRow: targetRow.id, target: kind, location, description: value(targetRow, "description", "") };
    if (kind === "npc") return { ...base, npcIds: morphs([value(targetRow, "npc"), value(targetRow, "fallback_npc")]) };
    if (kind === "loc") return { ...base, locIds: [value(targetRow, "loc"), value(targetRow, "fallback_loc")].filter(id => id != null && id >= 0) };
    // Kill one of these NPCs for the step's key, then open the loc with it.
    if (kind === "key") return { ...base, locIds: values(targetRow, "loc"), npcIds: morphs(values(targetRow, "npcs")), keyItem: value(targetRow, "key") };
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
  // A puzzle box pairs with its clue by gameval name: "<clue gameval>_puzzlebox".
  const objIdByName = new Map([...C.getObjNames()].map(([id, objName]) => [objName, id]));
  const clueSteps = steps.filter(step => itemByRow.has(step.row)).map(step => {
    const itemId = itemByRow.get(step.row);
    const resolved = { ...step, itemId };
    if (step.challenge) resolved.challenge = { ...step.challenge, itemId: challengeByRow.get(step.row) ?? null };
    if (step.puzzle) resolved.puzzle = { ...step.puzzle, itemId: objIdByName.get(`${C.getObjNames().get(itemId)}_puzzlebox`) ?? null };
    return resolved;
  });
  const byRow = new Map(clueSteps.map(step => [step.row, step]));
  const byItem = new Map(clueSteps.map(step => [step.itemId, step]));
  for (const step of clueSteps) if (step.challenge?.itemId != null) byItem.set(step.challenge.itemId, step);
  for (const step of clueSteps) if (step.puzzle?.itemId != null) byItem.set(step.puzzle.itemId, step);
  const items = core.ItemIdentifiers;
  const name = tier.name.toUpperCase();
  return { tier, steps: clueSteps, byRow, byItem, scrollName, challengeName,
    scroll: items[`CLUE_SCROLL_${name}_`], casket: items[`REWARD_CASKET_${name}_`],
    uri: C.getNpcId(`trail_${tier.name}_uri`), textInterface: C.getInterfaceId("trail_cluetext"),
    rewardInterface: C.getInterfaceId("trail_rewardscreen"), rewardInventory: 141 };
}

module.exports = { load, coordinate, coordinateText, CLUE_ROW_PARAM, TRAIL_ITEM_GROUP_PARAM, STEP_TABLES };
