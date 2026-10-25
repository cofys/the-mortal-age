"use strict";

/** The shared manual furnace; ore and bars still belong to the player who loaded them. */
const MIN_LEVEL = 30;
const ROOM = { minX: 1934, maxX: 1959, minY: 4955, maxY: 4976, levels: [0] };
const MAX_FUEL = 30;
// shortcut: heat/fuel/break cadence is not captured; replace these estimates with live evidence.
const FUEL_TICKS = 50;
const SMELTING_HEAT = 40;
const OVERHEAT = 100;
const BREAK_CHANCE = 1 / 500;
const MAX_OPERATING_TICKS = 10_000; // Wiki: the pump stops after 100 minutes.
const CONTRIBUTION_COOLDOWN = 10;
// shortcut: the Wiki says "recently" without a duration; verify this one-minute window with a capture.
const CONTRIBUTION_WINDOW = 100;
const TEMPERATURE = "blast_furnace_temperature_reading";
const BROKEN = "blast_furnace_broken_pipe_reading";
const FUEL_LOW = "blast_furnace_fuel_low_reading";
const PART_NAMES = [
  ["blast_furnace_conveyer_cogs", "blast_furnace_conveyer_cogs_broken"],
  ["blast_furnace_conveyer_cogs2", "blast_furnace_conveyer_cogs2_broken"],
  ["blast_furnace_pipes2", "blast_furnace_pipes2_broken"],
  ["blast_furnace_pipes6", "blast_furnace_pipes6_broken"],
];

let api, core;
let fuel = 0, heat = 0, elapsed = 0;
const parts = [];
const operators = new Map();
const participants = new Map();
const contributionAt = new WeakMap();
const pendingPedalDrain = new WeakSet();
let stove = null;
let running = null;
const machinery = [];
let stoker = null, stokerCycle = 0;

function automated() {
  return core.WorldDefinition.hasGlobalWorldTag("blast-furnace");
}

function id(kind, name) {
  return core.CacheDefinitions[kind](name);
}

function animate(player, name) {
  player.performAnimation(new core.Animation(id("getSeqId", name)));
}

function broken() {
  return parts.some((part) => part.broken);
}

function beltRunning() {
  return automated() || (!parts.slice(0, 2).some((part) => part.broken) &&
    [...operators.values()].some((operation) => operation.role === "pedal"));
}

function canSmelt() {
  return automated() || (!broken() && fuel > 0 && heat >= SMELTING_HEAT && heat < OVERHEAT);
}

function sync(player, entering = false) {
  const sender = player.getPacketSender();
  for (const [name, value] of [[TEMPERATURE, automated() ? SMELTING_HEAT : heat],
    [BROKEN, broken() ? 1 : 0], [FUEL_LOW, fuel === 0 && !automated() ? 1 : 0]]) {
    const varbit = id("getVarbitId", name);
    if (entering || sender.getVarbit(varbit) !== value) sender.sendVarbit(varbit, value);
  }
  if (entering) for (const entry of machinery) sender.sendObjectAnimation(entry.object,
    new core.Animation(id("getSeqId", beltRunning() ? entry.start : entry.end)));
}

function updateMotion() {
  const next = beltRunning();
  if (running === next) return;
  running = next;
  for (const entry of machinery) entry.object.performAnimation(new core.Animation(id("getSeqId", next ? entry.start : entry.end)));
}

function replace(object, nextId) {
  const next = new core.GameObject(nextId, object.getLocation().clone(), object.getType(), object.getFace(), null);
  core.ObjectManager.register(next, true);
  return next;
}

function setBroken(part, value) {
  if (part.broken === value) return;
  part.broken = value;
  part.object = replace(part.object, value ? part.brokenId : part.goodId);
}

function ready(player, skill) {
  const location = player.getLocation();
  if (location.getX() < ROOM.minX || location.getX() > ROOM.maxX ||
      location.getY() < ROOM.minY || location.getY() > ROOM.maxY || location.getZ() !== 0) return false;
  if (automated()) {
    // Manual-operation refusal wording is ours, pending a live capture.
    player.sendMessage("The dwarves operate the machinery on this world.");
    return false;
  }
  if (player.getSkillManager().getCurrentLevel(skill) < MIN_LEVEL) {
    player.sendMessage(`You need level ${MIN_LEVEL} ${skill.getName()} to do that.`);
    return false;
  }
  return true;
}

function operate(player, object, role, skill, animation) {
  if (!ready(player, skill)) return;
  if (player.getNpcTransformationId() !== -1) {
    // Unverified wording; the transformation restriction is documented by the Wiki.
    player.sendMessage("You can't operate the machinery while transformed.");
    return;
  }
  operators.get(player)?.task.stop();
  const at = player.getLocation().clone();
  const operation = { role, ticks: 0, task: null };
  class OperatorTask extends core.Task {
    constructor() { super(1, player.getIndex()); }
    execute() {
      if (!player.isRegistered() || player.getHitpoints() <= 0 || !player.getLocation().equals(at) ||
          player.getMovementQueue().size() > 0 || player.getForceMovement() ||
          player.getNpcTransformationId() !== -1 || ++operation.ticks > MAX_OPERATING_TICKS) {
        this.stop();
        return;
      }
      if (role === "pedal" && player.getRunEnergy() < 0.5) {
        player.sendMessage("You're too tired to keep pedalling.");
        this.stop();
        return;
      }
      if (operation.ticks % 4 === 1) animate(player, animation);
      if (role === "pedal") {
        // Energy is integer-valued; retain the half-point across action restarts.
        if (pendingPedalDrain.has(player)) {
          pendingPedalDrain.delete(player);
          player.setRunEnergy(player.getRunEnergy() - 1);
          player.getPacketSender().sendRunEnergy();
        } else pendingPedalDrain.add(player);
        player.getSkillManager().addExperiences(skill, 1);
      } else if (fuel > 0) {
        player.getSkillManager().addExperiences(skill, 2);
      }
      contribute(player);
    }
    stop() {
      super.stop();
      if (operators.get(player) === operation) operators.delete(player);
      player.performAnimation(core.Animation.DEFAULT_RESET_ANIMATION);
    }
  }
  operation.task = new OperatorTask();
  operators.set(player, operation);
  player.setPositionToFace(object.getLocation());
  animate(player, animation);
  api.getTaskManager().submit(operation.task);
}

function pedal({ player, object }) {
  operate(player, object, "pedal", core.Skill.AGILITY, "blast_furnace_human_conveyer_cycle");
}

function pump({ player, object }) {
  operate(player, object, "pump", core.Skill.STRENGTH, "blast_furnace_human_air_pump");
}

function collectCoke({ player }) {
  if (!ready(player, core.Skill.FIREMAKING)) return;
  const inventory = player.getInventory();
  if (!inventory.contains(core.ItemIdentifiers.SPADE)) {
    player.sendMessage("You need a spade to collect coke.");
    return;
  }
  inventory.deleteNumber(core.ItemIdentifiers.SPADE, 1);
  inventory.addItem(new core.Item(core.ItemIdentifiers.SPADEFUL_OF_COKE, 1));
  animate(player, "human_shovel_coke_up");
}

function refuel({ player }) {
  if (!ready(player, core.Skill.FIREMAKING)) return;
  const inventory = player.getInventory();
  if (!inventory.contains(core.ItemIdentifiers.SPADEFUL_OF_COKE)) {
    player.sendMessage("You need a spadeful of coke to refuel the stove.");
    return;
  }
  if (fuel >= MAX_FUEL) {
    player.sendMessage("The stove is full of coke.");
    return;
  }
  inventory.deleteNumber(core.ItemIdentifiers.SPADEFUL_OF_COKE, 1);
  inventory.addItem(new core.Item(core.ItemIdentifiers.SPADE, 1));
  fuel++;
  player.getSkillManager().addExperiences(core.Skill.FIREMAKING, 5);
  animate(player, "human_shovel_coke_down");
  contribute(player);
  updateStove();
}

function repair({ player, object }) {
  if (!ready(player, core.Skill.CRAFTING)) return;
  const part = parts.find((entry) => entry.broken && entry.object.getLocation().equals(object.getLocation()));
  if (!part) return;
  if (!player.getInventory().contains(core.ItemIdentifiers.HAMMER)) {
    player.sendMessage("You need a hammer to repair the machinery.");
    return;
  }
  setBroken(part, false);
  animate(player, "human_hammer_hit");
  player.getSkillManager().addExperiences(core.Skill.CRAFTING, 50);
  contribute(player);
}

function updateStove() {
  if (!stove) return;
  const name = fuel >= 12 ? "full" : fuel >= 3 ? "medium" : "low";
  const next = id("getLocId", `blast_furnace_stove_${name}`);
  if (stove.getId() !== next) stove = replace(stove, next);
}

function tick() {
  updateMotion();
  if (automated()) { tickStoker(); return; }
  elapsed++;
  if (fuel > 0 && elapsed % FUEL_TICKS === 0) { fuel--; updateStove(); }
  const pumping = [...operators.values()].some((operation) => operation.role === "pump");
  heat = pumping && fuel > 0 && !broken() ? heat + 1 : Math.max(0, heat - 1);
  if (heat >= OVERHEAT) {
    for (const part of parts) setBroken(part, true);
    for (const player of [...operators.keys()]) {
      // The safe overheat effect is documented; this message is not captured.
      player.sendMessage("The blast furnace has overheated and the machinery has broken!");
      leave(player);
    }
    heat = 0;
  } else if (operators.size > 0 && parts.length && Math.random() < BREAK_CHANCE) {
    setBroken(parts[Math.floor(Math.random() * parts.length)], true);
  }
}

/** RSProx 3278/1757: repeat every nine ticks, with the carried-coke form between 1 and 4. */
function tickStoker() {
  if (!stoker?.isRegistered()) return;
  const phase = stokerCycle++ % 9;
  if (phase === 0) {
    stoker.setNpcTransformationId(core.NpcIdentifiers.DUMPY);
    stoker.performAnimation(new core.Animation(id("getSeqId", "human_shovel_coke_up"), 15));
  } else if (phase === 1) stoker.setNpcTransformationId(core.NpcIdentifiers.DUMPY_2);
  else if (phase === 2) stoker.performAnimation(new core.Animation(id("getSeqId", "human_shovel_coke_down"), 15));
  else if (phase === 4) {
    stoker.setNpcTransformationId(core.NpcIdentifiers.DUMPY);
    stoker.performAnimation(new core.Animation(id("getSeqId", "human_shovel_coke_fin")));
  }
}

function contribute(player) {
  if (!automated()) participants.set(player, elapsed);
}

function contribution() {
  if (automated()) return;
  for (const [player, at] of participants) {
    if (elapsed - at > CONTRIBUTION_WINDOW || !player.isRegistered()) { participants.delete(player); continue; }
    if (elapsed - (contributionAt.get(player) ?? -CONTRIBUTION_COOLDOWN) < CONTRIBUTION_COOLDOWN) continue;
    player.getSkillManager().addExperiences(core.Skill.SMITHING, 1.5);
    contributionAt.set(player, elapsed);
  }
}

function leave(player) {
  operators.get(player)?.task.stop();
  participants.delete(player);
}

function shutdown() {
  for (const player of [...operators.keys()]) leave(player);
  participants.clear();
}

function startup() {
  stoker = null;
  stokerCycle = 0;
  const center = new core.Location(1945, 4965, 0);
  core.RegionManager.loadMapFiles(center.getX(), center.getY());
  const locs = [...core.MapObjects.mapObjects.values()].flat().filter((object) => object.getLocation().isWithinDistance(center, 20));
  machinery.length = 0;
  for (const object of locs) {
    const definition = core.CacheDefinitions.getObject(object.getId());
    const type = definition.name === "Conveyor belt" ? "belt" : ["Drive belt", "Cogs"].includes(definition.name) ? "cogs" : null;
    if (type) machinery.push({ object, start: `blast_furnace_conveyer_${type}`, end: `blast_furnace_conveyer_${type}_end` });
  }
  parts.length = 0;
  for (const [good, bad] of PART_NAMES) {
    const goodId = id("getLocId", good), brokenId = id("getLocId", bad);
    const object = locs.find((loc) => loc.getId() === goodId || loc.getId() === brokenId);
    if (object) parts.push({ object, goodId, brokenId, broken: object.getId() === brokenId });
  }
  stove = locs.find((object) => object.getId() === id("getLocId", "blast_furnace_stove_low"));
  const helpers = new Set([core.NpcIdentifiers.STUMPY, core.NpcIdentifiers.PUMPY, core.NpcIdentifiers.DUMPY,
    core.NpcIdentifiers.DUMPY_2, core.NpcIdentifiers.NUMPTY, core.NpcIdentifiers.THUMPY]);
  for (const npc of core.World.getNpcs()) {
    if (!npc || !helpers.has(npc.getId()) || !npc.getLocation().isWithinDistance(center, 20)) continue;
    if (!automated()) api.removeNpc(npc);
    else if ([core.NpcIdentifiers.DUMPY, core.NpcIdentifiers.DUMPY_2].includes(npc.getId())) stoker = npc;
    else if (npc.getId() === core.NpcIdentifiers.PUMPY) npc.setBaseAnimations({ idle: id("getSeqId", "blast_furnace_npc_air_pump") });
    else if (npc.getId() === core.NpcIdentifiers.STUMPY) npc.setBaseAnimations({ idle: id("getSeqId", "blast_furnace_npc_conveyer_cycle") });
  }
}

function init(pluginApi) {
  api = pluginApi;
  core = api.core;
}

function attach(pluginApi) {
  init(pluginApi);
  api.onServerStartup(startup);
  api.onServerShutdown(shutdown);
  api.onObjectInteraction("Pedals", { Pedal: pedal });
  api.onObjectInteraction("Pump", { Operate: pump });
  api.onObjectInteraction("Coke", { Collect: collectCoke });
  api.onObjectInteraction("Stove", { Refuel: refuel });
  api.onObjectInteraction("Drive belt", { Repair: repair });
  api.onObjectInteraction("Cogs", { Repair: repair });
  api.onObjectInteraction("Pipes", { Repair: repair });
  api.onItemOnObject("Spadeful of coke", "Stove", refuel, { noted: false });
  api.onItemOnObject("Hammer", "Drive belt", repair, { noted: false });
  api.onItemOnObject("Hammer", "Cogs", repair, { noted: false });
  api.onItemOnObject("Hammer", "Pipes", repair, { noted: false });
}

module.exports = { ROOM, init, attach, automated, beltRunning, canSmelt, sync, tick, contribute, contribution, leave,
  _test: { startup, collectCoke, refuel, pedal, pump, repair, shutdown,
    snapshot: () => ({ fuel, heat, parts, operators }), reset: () => { shutdown(); fuel = heat = elapsed = 0; parts.length = 0; machinery.length = 0; stove = null; running = null; stoker = null; stokerCycle = 0; } } };
