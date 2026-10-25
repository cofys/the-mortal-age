/**
 * The Pharaoh's sceptre: what the units share - plugins/items/data/pharaohs-sceptre.json with its
 * gameval names resolved to cache ids, the Pyramid Plunder artefacts by material, the player's
 * charges (one pool per player, saved here) and how many the sceptre holds for their Desert Diary.
 * Varp pharaohs_sceptre packs the last teleport (bits 0-5), the Necropolis (6) and the mummy
 * met (7) as varbits; the cache has no varbit for a count, so the charges are not sent in it.
 */
const fs = require("fs");
const path = require("path");

const CHARGES_ATTRIBUTE = "pharaohs-sceptre:charges";
/** The last destination's number (1-4), as varbit pharaohs_sceptre_last_teleport holds it. */
const LAST_ATTRIBUTE = "pharaohs-sceptre:last";
const NECROPOLIS_ATTRIBUTE = "pharaohs-sceptre:necropolis";
const MUMMY_MET_ATTRIBUTE = "pharaohs-sceptre:mummy-met";
const DIARY_TIERS = ["elite", "hard", "medium", "easy"];

let api = null;
let core = null;
let data = null;
let ids = null;

function resolve(names, lookup, kind) {
  const out = {};
  for (const [key, name] of Object.entries(names)) {
    if (key.startsWith("_")) continue;
    const id = lookup(name);
    if (id === null || id === undefined) throw new Error(`[PharaohsSceptre] unknown ${kind} ${name}`);
    out[key] = id;
  }
  return out;
}

/** Set once by the plugin before any unit attaches. */
function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "pharaohs-sceptre.json"), "utf8"));
  const cache = core.CacheDefinitions;
  ids = {
    objs: resolve(data.names.objs, (name) => cache.getObjId(name), "obj"),
    varbits: resolve(data.names.varbits, (name) => cache.getVarbitId(name), "varbit"),
    locs: resolve(data.names.locs, (name) => cache.getLocId(name), "loc"),
    npcs: resolve(data.names.npcs, (name) => cache.getNpcId(name), "npc"),
    /** artefact obj id (unnoted and noted) -> material */
    artefacts: new Map(),
  };
  const plunder = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "minigames", "pyramidplunder", "data", "pyramid-plunder.json"), "utf8"));
  for (const artefact of Object.values(plunder.artefacts)) {
    for (const name of [artefact.gameval, `cert_${artefact.gameval}`]) {
      const id = cache.getObjId(name);
      if (Number.isInteger(id)) ids.artefacts.set(id, artefact.material);
    }
  }
}

const sceptreIds = () => [ids.objs.charged, ids.objs.initial, ids.objs.uncharged];
const chargedIds = () => [ids.objs.charged, ids.objs.initial];
const isSceptre = (id) => sceptreIds().includes(id);
const isCharged = (id) => chargedIds().includes(id);

/** The carried or worn sceptre: { container, slot, item, equipped }, charged ones first. */
function findSceptre(player, wanted = sceptreIds()) {
  const places = [[player.getEquipment?.(), true], [player.getInventory?.(), false]];
  for (const id of wanted) {
    for (const [container, equipped] of places) {
      const items = container?.getItems?.() ?? [];
      const slot = items.findIndex((item) => item?.getId?.() === id);
      if (slot >= 0) return { container, slot, item: items[slot], equipped };
    }
  }
  return null;
}

/** Charges held for this Desert Diary: 3, then 10/25/50/100 easy to elite (Wiki). */
function capacity(player) {
  for (const tier of DIARY_TIERS) {
    const request = { player, diary: "desert", tier, complete: false };
    api.emitCustomEvent("diary:is-complete", request);
    if (request.complete === true) return data.capacity[tier];
  }
  return data.capacity.default;
}

/**
 * The charges a player's sceptre holds. A sceptre found in Pyramid Plunder (the charged-initial
 * one) holds the default 3 until it is used: one spent to nothing has already turned uncharged,
 * so an initial sceptre beside a count of 0 is a new find.
 */
function charges(player) {
  const stored = player.getAttribute?.(CHARGES_ATTRIBUTE);
  if (Number.isInteger(stored) && stored > 0) return stored;
  return findSceptre(player, [ids.objs.initial]) ? data.capacity.default : 0;
}

function sync(player) {
  const sender = player.getPacketSender();
  sender.sendVarbit(ids.varbits.mummyMet, player.getAttribute?.(MUMMY_MET_ATTRIBUTE) === true ? 1 : 0);
  sender.sendVarbit(ids.varbits.lastTeleport, Number(player.getAttribute?.(LAST_ATTRIBUTE)) || 0);
  sender.sendVarbit(ids.varbits.necropolis, necropolisUnlocked(player) ? 1 : 0);
}

function setCharges(player, value) {
  player.setAttribute(CHARGES_ATTRIBUTE, Math.max(0, Math.floor(value)));
  sync(player);
}

function necropolisUnlocked(player) {
  return player.getAttribute?.(NECROPOLIS_ATTRIBUTE) === true;
}

/** The charges for a sceptre in hand: none for an uncharged one, else the pool. */
function chargesOf(player, itemId) {
  return isCharged(itemId) ? charges(player) : 0;
}

/** The charges of the sceptre carried or worn: none unless a charged one is with the player. */
function carriedCharges(player) {
  return findSceptre(player, chargedIds()) ? charges(player) : 0;
}

/** Turns the sceptre into another form (charged, uncharged) where it is, worn or carried. */
function swapSceptre(player, found, toId) {
  const { Item, BonusManager, Flag } = core;
  found.container.setItem(found.slot, new Item(toId, 1));
  found.container.refreshItems?.();
  if (found.equipped) {
    BonusManager?.update?.(player);
    player.getUpdateFlag?.().flag(Flag.APPEARANCE);
  }
}

function message(key, values = {}) {
  return data.messages[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
}

/** "{charges} charge{s}" filled for a count. */
function chargeWords(count) {
  return { charges: count, s: count === 1 ? "" : "s" };
}

module.exports = {
  init, sceptreIds, chargedIds, isSceptre, isCharged, findSceptre, capacity, charges, chargesOf, carriedCharges, setCharges, sync,
  necropolisUnlocked, swapSceptre, message, chargeWords,
  CHARGES_ATTRIBUTE, LAST_ATTRIBUTE, NECROPOLIS_ATTRIBUTE, MUMMY_MET_ATTRIBUTE,
  get api() { return api; },
  get core() { return core; },
  get data() { return data; },
  get ids() { return ids; },
};
