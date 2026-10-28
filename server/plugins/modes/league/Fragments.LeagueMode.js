/**
 * Shattered Relics' fragments screen (league_3_fragments 735, data/league-shattered.json
 * `fragments`): which fragments a character owns (their fragment XP) and which sit in its seven
 * slots, saved and sent as the varbits the screen draws from. A slot opens at the points the
 * cache's enum 4127 gives (Wiki /Fragments: one to seven slots). Equip and Unequip work only in a
 * bank, near a bank chest or near the Sage (Wiki /Fragments, NearBank and Sage); the screen
 * opens anywhere. Equipped fragments gain XP and levels as the character gains XP (data `fragmentXp`);
 * FragmentDrops hands them out and FragmentEffects gives them effects, through `equippedLevel`,
 * `setTier` and `award`.
 *
 *   "league:grant-fragment" { player, id, xp? }   owns a fragment (1 XP, level 1, unless more is given)
 *   "league:open-fragments" { player }            opens the screen
 *   "league:fragment-level" { player, id } -> level   (0 unless equipped)
 *   "league:fragments-changed" { player }        after Equip, Unequip or Unequip all changes the slots
 */
const Common = require("./Common.LeagueMode");
const { FLAG_OP1, FLAG_OP2 } = require("../../interface/widgetGroup");
const { data, isShattered } = require("./Shattered.LeagueMode");
const { nearSage } = require("./Sage.LeagueMode");
const { nearBank } = require("./NearBank.LeagueMode");

/** Fragment id -> fragment XP (absent = not owned). */
const FRAGMENTS_ATTRIBUTE = "league:fragments";
/** The seven slots' fragment ids (0 = empty). */
const SLOTS_ATTRIBUTE = "league:fragment-slots";

/** The cache's fragment ids (enum 4136's structs, param 1455), read once. */
let fragmentIds = null;
/** The points each slot opens at (enum 4127), read once. */
let slotThresholds = null;
/**
 * Fragment id -> its cache row (enum 4136's struct), read once: name (param 1448), its
 * Unidentified fragment item (1462), combat tier (1454; 0 = not combat), the number each level
 * works with (1456-1458, the numbers in its level texts 1450-1452) and its sets (1459 / 1460).
 */
let definitions = null;
/** Set id -> the pieces its first and second tiers need (params 1468 / 1470; 0 = no second tier), read once. */
let setPieces = null;
/** Set id -> the item the set grants (param 1471; the Sage's items), read once. */
let setItems = null;
/** Per player: the world cycle its equipped fragments last gained XP (Wiki: at most once per 4 ticks). */
const lastGain = new WeakMap();

function uid(group, child) {
  return (group << 16) | child;
}

function config() {
  return data.fragments;
}

function ids() {
  if (fragmentIds) return fragmentIds;
  const { CacheDefinitions } = Common.core;
  fragmentIds = new Set([...CacheDefinitions.getEnumValues(config().enum).values()]
    .map((struct) => Number(CacheDefinitions.getStructParams(Number(struct))?.get(config().idParam)))
    .filter((id) => Number.isInteger(id) && id > 0));
  return fragmentIds;
}

function thresholds() {
  if (slotThresholds) return slotThresholds;
  slotThresholds = [...Common.core.CacheDefinitions.getEnumValues(config().slotsEnum).entries()]
    .sort(([a], [b]) => a - b).map(([, points]) => Number(points));
  return slotThresholds;
}

function owned(player) {
  const value = player.getAttribute(FRAGMENTS_ATTRIBUTE);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function slots(player) {
  const value = player.getAttribute(SLOTS_ATTRIBUTE);
  const list = Array.isArray(value) ? value.map((id) => Number(id) || 0) : [];
  return config().slotVarbits.map((_, slot) => list[slot] ?? 0);
}

function points(player) {
  const query = { player, points: 0, tasks: 0 };
  Common.api.emitCustomEvent("league:points", query);
  return Number(query.points) || 0;
}

/** Slots open at the character's points (script 5786). */
function openSlots(player) {
  const earned = points(player);
  return thresholds().filter((needed) => earned >= needed).length;
}

function sendFragments(player) {
  const sender = player.getPacketSender();
  const xp = owned(player);
  for (const id of ids()) sender.sendVarbit(config().xpVarbitBase + id - 1, Math.min(0xffff, Number(xp[id]) || 0));
  sendSlots(player);
}

function sendSlots(player) {
  const sender = player.getPacketSender();
  slots(player).forEach((id, slot) => sender.sendVarbit(config().slotVarbits[slot], id));
}

function grant(request) {
  const { player } = request ?? {};
  const id = Number(request?.id);
  if (!isShattered(player) || !ids().has(id)) return;
  const xp = owned(player);
  player.setAttribute(FRAGMENTS_ATTRIBUTE, { ...xp, [id]: Math.min(maxXp(), Math.max(Number(xp[id]) || 0, Number(request.xp) || 1)) });
  sendFragments(player);
}

// ---- Fragment XP, levels and sets ----

function maxXp() {
  return data.fragmentXp.levels.at(-1);
}

/** Script 5789: level 1, 2 or 3 by XP; 0 = not owned. */
function levelOf(xp) {
  const levels = data.fragmentXp.levels;
  let level = 0;
  levels.forEach((needed, index) => {
    if (xp >= needed) level = index + 1;
  });
  return level;
}

function xpOf(player, id) {
  return Number(owned(player)[id]) || 0;
}

/** An owned fragment's level, equipped or not (0 = not owned). */
function ownedLevel(player, id) {
  return levelOf(xpOf(player, id));
}

/** The level an equipped fragment works at; 0 when it isn't equipped (or the character isn't in Shattered Relics). */
function equippedLevel(player, id) {
  if (!isShattered(player) || !slots(player).includes(Number(id))) return 0;
  return ownedLevel(player, Number(id));
}

function readDefinitions() {
  if (definitions) return definitions;
  const { CacheDefinitions } = Common.core;
  const number = (params, param) => Number(params?.get(param)) || 0;
  definitions = new Map();
  for (const struct of CacheDefinitions.getEnumValues(config().enum).values()) {
    const params = CacheDefinitions.getStructParams(Number(struct));
    definitions.set(number(params, config().idParam), {
      name: String(params?.get(config().nameParam) ?? ""),
      item: number(params, config().itemParam),
      tier: number(params, config().tierParam),
      values: config().levelParams.map((param) => number(params, param)),
      sets: config().setParams.map((param) => number(params, param)).filter((set) => set > 0),
    });
  }
  return definitions;
}

/** A fragment's cache row (readDefinitions), or null for an unknown id. */
function definition(id) {
  return readDefinitions().get(Number(id)) ?? null;
}

/** Every fragment's cache row, by id. */
function allDefinitions() {
  return readDefinitions();
}

/** The number an equipped fragment works with at its level (params 1456-1458), or null when it isn't equipped. */
function equippedValue(player, id) {
  const level = equippedLevel(player, id);
  return level > 0 ? definition(id)?.values[level - 1] ?? null : null;
}

function readSetPieces() {
  if (setPieces) return;
  const { CacheDefinitions } = Common.core;
  setPieces = new Map();
  setItems = new Map();
  for (const struct of CacheDefinitions.getEnumValues(config().setsEnum).values()) {
    const params = CacheDefinitions.getStructParams(Number(struct));
    const set = Number(params?.get(config().setIdParam));
    setPieces.set(set, config().setPiecesParams.map((param) => Number(params?.get(param)) || 0));
    const item = Number(params?.get(config().setItemParam));
    if (item > 0) setItems.set(set, item);
  }
}

/** The item a set grants (param 1471), or null for a set that grants none. */
function setItem(set) {
  readSetPieces();
  return setItems.get(Number(set)) ?? null;
}

/** A set's tier from the equipped fragments that list it: 0, 1 or 2 (enum 4137). */
function setTier(player, set) {
  if (!isShattered(player)) return 0;
  readSetPieces();
  const pieces = slots(player).filter((id) => id > 0 && (definition(id)?.sets ?? []).includes(Number(set))).length;
  const [first, second] = setPieces.get(Number(set)) ?? [0, 0];
  if (second > 0 && pieces >= second) return 2;
  return first > 0 && pieces >= first ? 1 : 0;
}

/**
 * A fragment found: new, it is owned at the first level's XP; owned already, it gains the
 * duplicate XP (Wiki: even unequipped). Answers whether it was a duplicate.
 */
function award(player, id) {
  const xp = owned(player);
  const had = Number(xp[id]) || 0;
  const now = had > 0 ? Math.min(maxXp(), had + data.fragmentXp.duplicate) : data.fragmentXp.levels[0];
  player.setAttribute(FRAGMENTS_ATTRIBUTE, { ...xp, [id]: now });
  sendFragments(player);
  return { duplicate: had > 0 };
}

/** Whether a fragment can still be found: not owned yet, or owned below the last level. */
function findable(player, id) {
  return xpOf(player, id) < maxXp();
}

/** onExperienceGained: each equipped fragment gains XP, at most once per `everyTicks` (Wiki). */
function experienceGained({ player }) {
  if (!isShattered(player)) return;
  const equipped = slots(player).filter((id) => id > 0);
  if (!equipped.length) return;
  const cycle = Common.core.World.getProcessCycle();
  const last = lastGain.get(player);
  if (last !== undefined && cycle - last < data.fragmentXp.everyTicks) return;
  lastGain.set(player, cycle);
  const xp = { ...owned(player) };
  let changed = false;
  for (const id of equipped) {
    const before = Number(xp[id]) || 0;
    if (before <= 0 || before >= maxXp()) continue;
    xp[id] = Math.min(maxXp(), before + data.fragmentXp.perGain);
    changed = true;
  }
  if (!changed) return;
  player.setAttribute(FRAGMENTS_ATTRIBUTE, xp);
  const sender = player.getPacketSender();
  for (const id of equipped) sender.sendVarbit(config().xpVarbitBase + id - 1, Math.min(0xffff, Number(xp[id]) || 0));
}

function levelQuery(request) {
  if (request?.player) request.level = equippedLevel(request.player, Number(request.id));
}

function open({ player }) {
  if (!isShattered(player)) return;
  const { group, list, listChildren, loadout, loadoutChildren } = config();
  sendFragments(player);
  const sender = player.getPacketSender();
  sender.sendInterface(group);
  sender.sendInterfaceFlagsRange(uid(group, list), 0, Math.max(...ids()) * listChildren - 1, FLAG_OP1 | FLAG_OP2);
  sender.sendInterfaceFlagsRange(uid(group, loadout), 0, config().slotVarbits.length * loadoutChildren - 1, FLAG_OP1 | FLAG_OP2);
}

function isOpen(player) {
  return player.getInterfaceId() === config().group;
}

/** Fragments change only in a bank, near a bank chest or near the Sage (Wiki /Fragments); said otherwise. */
function canSwap(player) {
  if (nearBank(player) || nearSage(player)) return true;
  player.sendMessage(data.messages.swapAway);
  return false;
}

/** Equip (735:18 op2): an owned fragment into the first empty open slot; never twice. */
function equip(event) {
  const { player } = event;
  if (!isShattered(player) || !isOpen(player)) return false;
  const slot = Number(event.slot);
  if (Number(event.opId ?? event.action) !== config().equipOp || slot % config().listChildren !== 0) return true;
  const id = slot / config().listChildren + 1;
  const current = slots(player);
  if (!ids().has(id) || !(Number(owned(player)[id]) > 0) || current.includes(id)) return true;
  if (!canSwap(player)) return true;
  const free = current.findIndex((entry, index) => entry === 0 && index < openSlots(player));
  if (free < 0) return true;
  current[free] = id;
  player.setAttribute(SLOTS_ATTRIBUTE, current);
  sendSlots(player);
  Common.api.emitCustomEvent("league:fragments-changed", { player });
  return true;
}

/** Unequip (735:36 op2): that slot's fragment comes off. */
function unequip(event) {
  const { player } = event;
  if (!isShattered(player) || !isOpen(player)) return false;
  const child = Number(event.slot) - 1;
  if (Number(event.opId ?? event.action) !== config().unequipOp || child < 0 || child % config().loadoutChildren !== 0) return true;
  const slot = child / config().loadoutChildren;
  const current = slots(player);
  if (slot >= current.length || current[slot] === 0 || !canSwap(player)) return true;
  current[slot] = 0;
  player.setAttribute(SLOTS_ATTRIBUTE, current);
  sendSlots(player);
  Common.api.emitCustomEvent("league:fragments-changed", { player });
  return true;
}

function unequipAll({ player }) {
  if (!isShattered(player) || !isOpen(player)) return false;
  if (slots(player).every((id) => id === 0) || !canSwap(player)) return true;
  player.setAttribute(SLOTS_ATTRIBUTE, config().slotVarbits.map(() => 0));
  sendSlots(player);
  Common.api.emitCustomEvent("league:fragments-changed", { player });
  return true;
}

function close({ player }) {
  if (!isShattered(player) || !isOpen(player)) return false;
  player.getPacketSender().sendInterfaceRemoval();
  return true;
}

function login({ player }) {
  if (isShattered(player)) sendFragments(player);
}

function buttons() {
  const { group, list, loadout, unequipAll: all, close: closeButton } = config();
  return { list: uid(group, list), loadout: uid(group, loadout), all: uid(group, all), close: uid(group, closeButton) };
}

module.exports = function attach(api) {
  const buttonIds = buttons();
  api.persistAttribute(FRAGMENTS_ATTRIBUTE, {});
  api.persistAttribute(SLOTS_ATTRIBUTE, []);
  api.onCustomEvent("league:grant-fragment", grant);
  api.onCustomEvent("league:open-fragments", open);
  api.onCustomEvent("league:login", login);
  api.onCustomEvent("league:fragment-level", levelQuery);
  api.onExperienceGained(experienceGained);
  api.onInterfaceActionButton(buttonIds.list, equip);
  api.onInterfaceActionButton(buttonIds.loadout, unequip);
  api.onInterfaceActionButton(buttonIds.all, unequipAll);
  api.onInterfaceActionButton(buttonIds.close, close);
};

module.exports.equippedLevel = equippedLevel;
module.exports.equippedValue = equippedValue;
module.exports.definition = definition;
module.exports.allDefinitions = allDefinitions;
module.exports.ownedLevel = ownedLevel;
module.exports.setTier = setTier;
module.exports.setItem = setItem;
module.exports.award = award;
module.exports.findable = findable;
module.exports._test = { openSlots, slots, owned, ids, levelOf, FRAGMENTS_ATTRIBUTE, SLOTS_ATTRIBUTE };
