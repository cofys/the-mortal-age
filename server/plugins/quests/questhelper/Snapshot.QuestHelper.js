"use strict";
// The Quest Helper bridge snapshot, built from server state for a headless evaluation.
//
// Only scene identity, world contents and stats come from here. QuestHelperRuntime.authoritative()
// replaces every var, quest state, container and position with the server's own values afterwards,
// so this file must never try to mirror the wire.
//
// `nearby` is the agent MCP's read-only world scan: it already knows private areas, boat decks,
// owner-only NPCs and removed objects, so the helper and the agent see the same scene.

const SCENE_TILES = 104;
const MAX_WIDGETS = 2000;

/** The 8-aligned scene base the client derives from the server's REBUILD packet. */
const sceneBase = (tile) => ((tile >> 3) - 6) * 8;

/** Interface text the server has sent, so steps that read an interface are not blank. */
function widgetTexts(player) {
  const map = player.getFrameUpdater?.()?.interfaceTextMap;
  if (!map || typeof map.forEach !== "function") return [];
  const widgets = [];
  map.forEach((entry, id) => {
    const text = entry?.currentState;
    if (typeof text === "string" && text.length > 0 && widgets.length < MAX_WIDGETS) {
      widgets.push({ id: Number(id), text });
    }
  });
  return widgets;
}

/** The 4 x 13 x 13 palette the client holds as `instanceTemplateChunks` inside a template instance. */
function instanceTemplateChunks(player, x, y) {
  const area = player.getPrivateArea?.();
  if (typeof area?.buildScenePalette !== "function") return undefined;
  return area.buildScenePalette(x >> 3, y >> 3).palette;
}

function collectQuestHelperSnapshot(deps, player, { radius = 32 } = {}) {
  const { nearby, items, skills, tick } = deps;
  const location = player.getLocation();
  const x = location.getX();
  const y = location.getY();
  const plane = location.getZ();
  const baseX = sceneBase(x);
  const baseY = sceneBase(y);
  // A base the player's own tile falls outside of silently empties the scene, so refuse it here.
  if (x < baseX || x >= baseX + SCENE_TILES || y < baseY || y >= baseY + SCENE_TILES) {
    throw new Error(`Quest Helper scene base ${baseX},${baseY} does not contain ${x},${y}`);
  }
  const scene = nearby(player, radius);
  const containers = (container) => items(container).map((item) => ({ id: item.id, quantity: item.amount, slot: item.slot }));
  return {
    hintArrowNpcIndex: -1,
    varps: {},
    varbits: {},
    varbitDefinitions: {},
    questStates: {},
    inventory: containers(player.getInventory()),
    equipment: containers(player.getEquipment()),
    localPlayer: { index: player.getIndex(), name: player.getUsername(), x, y, plane },
    skills: skills(player),
    npcs: scene.npcs.map((npc) => ({
      index: npc.index,
      ecsIndex: npc.index,
      id: npc.id,
      transformedId: npc.id,
      name: npc.name ?? "",
      x: npc.x,
      y: npc.y,
      plane: npc.z,
      animation: npc.animation ?? -1,
      orientation: npc.orientation ?? 0,
      combatLevel: npc.combatLevel ?? 0,
      interactingIndex: npc.interactingIndex ?? -1,
    })),
    objects: scene.objects.map((object) => ({
      id: object.id,
      x: object.x,
      y: object.y,
      // Every field the bridge indexes is mandatory: a dropped plane is an NPE, not a diagnostic.
      plane: object.z ?? plane,
      type: object.type ?? 10,
      orientation: object.orientation ?? 0,
    })),
    groundItems: scene.groundItems.map((item) => ({
      id: item.id,
      quantity: item.amount,
      x: item.x,
      y: item.y,
      plane: item.z,
    })),
    widgets: widgetTexts(player),
    baseX,
    baseY,
    plane,
    tick: tick(),
    instanceTemplateChunks: instanceTemplateChunks(player, x, y),
  };
}

/**
 * What each step target points at, checked against the cache and the scene, so a helper step naming
 * an NPC, object or item this server does not have is caught before the first click.
 * `scene: "absent"` on a distant target is only a warning: the step may be across the map.
 */
function resolveTargets(targets, snapshot, inCache) {
  const here = snapshot.localPlayer ?? { x: 0, y: 0 };
  const carried = new Set([...(snapshot.inventory ?? []), ...(snapshot.equipment ?? [])].map((item) => item.id));
  const ground = new Set((snapshot.groundItems ?? []).map((item) => item.id));
  const at = (thing, target) => thing.x === target.x && thing.y === target.y && thing.plane === target.plane;
  const close = (thing, target) =>
    Math.max(Math.abs(thing.x - (target.x ?? here.x)), Math.abs(thing.y - (target.y ?? here.y))) <= 32;
  const sceneOf = (list, target, ids) => {
    const matching = list.filter((thing) => ids.includes(thing.id));
    if (!matching.length) return "absent";
    if (target.x !== undefined && matching.some((thing) => at(thing, target))) return "on-tile";
    return matching.some((thing) => close(thing, target)) ? "nearby" : "absent";
  };
  return (targets ?? []).map((target) => {
    const ids = [...new Set([...(target.ids ?? []), ...(target.id === undefined ? [] : [target.id])])];
    const known = ids.filter((id) => inCache(target.kind, id));
    const resolved = {
      kind: target.kind,
      ...(ids.length ? { ids } : {}),
      ...(target.x === undefined ? {} : { x: target.x, y: target.y, plane: target.plane }),
      cache: ids.length === 0 ? "n/a" : known.length === 0 ? "missing" : "known",
    };
    if (target.kind === "npc") resolved.scene = sceneOf(snapshot.npcs ?? [], target, ids);
    else if (target.kind === "object") resolved.scene = sceneOf(snapshot.objects ?? [], target, ids);
    else if (target.kind === "item") {
      resolved.scene = ids.some((id) => carried.has(id))
        ? "carried"
        : ids.some((id) => ground.has(id)) ? "on-ground" : "absent";
    } else resolved.scene = "n/a";
    return resolved;
  });
}

module.exports = { collectQuestHelperSnapshot, resolveTargets, sceneBase };
