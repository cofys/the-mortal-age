"use strict";

// Content is Jagex's clue-helper catalogue in the installed cache, as for beginner clues.
// From easy upwards every step is its own "Clue scroll (<tier>)" item whose param links it
// to its clue-helper row, so the item in the player's hand is the step being solved.
const CLUE_ROW_PARAM = 623;
const STEP_TABLES = ["anagram", "cipher", "coordinate", "cryptic", "emote", "fairyring", "falobard", "hotcold", "map", "music", "skillchallenge"];
const MAP_INTERFACES = require("./data/map-interfaces.json");

function coordinate(packed) {
  return { x: (packed >>> 14) & 16383, y: packed & 16383, z: packed >>> 28 };
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
    return base;
  }
  function outfit(row) {
    const outfitRow = value(row, "outfit") == null ? null : C.getDbRow(value(row, "outfit"));
    if (!outfitRow) return [];
    // One requirement per worn slot: any listed item, or any item carrying the listed param.
    return C.getDbColumns(outfitRow.tableId).filter(name => name?.startsWith("wearpos_")).flatMap(name => {
      const listed = values(outfitRow, name);
      if (!listed.length) return [];
      return name.startsWith("wearpos_param_") ? [{ param: listed[0] }] : [{ anyOf: listed.filter(id => id >= 0) }];
    });
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
      steps.push(step);
    }
  }

  // Only rows with a "Clue scroll (<tier>)" item are clue steps; quest scrolls share the tables.
  const itemByRow = new Map();
  for (const id of C.getObjNames().keys()) {
    const definition = C.getItem(id);
    const row = definition?.params instanceof Map ? definition.params.get(CLUE_ROW_PARAM) : undefined;
    if (row != null && definition.name === scrollName && !itemByRow.has(row)) itemByRow.set(row, id);
  }
  const clueSteps = steps.filter(step => itemByRow.has(step.row)).map(step => ({ ...step, itemId: itemByRow.get(step.row) }));
  const byRow = new Map(clueSteps.map(step => [step.row, step]));
  const byItem = new Map(clueSteps.map(step => [step.itemId, step]));
  const items = core.ItemIdentifiers;
  const name = tier.name.toUpperCase();
  return { tier, steps: clueSteps, byRow, byItem, scrollName,
    scroll: items[`CLUE_SCROLL_${name}_`], casket: items[`REWARD_CASKET_${name}_`],
    uri: C.getNpcId(`trail_${tier.name}_uri`), textInterface: C.getInterfaceId("trail_cluetext"),
    rewardInterface: C.getInterfaceId("trail_rewardscreen"), rewardInventory: 141 };
}

module.exports = { load, coordinate, CLUE_ROW_PARAM, STEP_TABLES };
