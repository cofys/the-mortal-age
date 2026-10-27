/**
 * The game's own copies of real items (br_ items, and the dragon arrows fake_dragon_arrow): their
 * own ids, but the same name, model, slot and category as the item they copy. Each is registered
 * as an alias of that item (ItemAliases), so the special attacks, ranged weapons, ammunition and
 * weapon profiles the real item has work with the copy (rsprox: claws specials, crossbow and
 * bolt shots, javelins and arrows all fire in LMS). The potions ("Saradomin brew(4)" to "(1)")
 * are registered with the Potions plugin as copies of the potion of that name, drunk down to the
 * game's own vial (captured: "You drink some of your Sanfew Serum." in a game).
 */
const Common = require("./Common.LastManStanding");

const COPY_PREFIXES = ["br_", "fake_"];

function isCopy(gameval) {
  return COPY_PREFIXES.some((prefix) => gameval.startsWith(prefix));
}

/** What makes two items the same object: the cache's name, model, slot and category. */
function signature(type) {
  return type ? `${type.name}|${type.model}|${type.wearPos ?? -1}|${type.category ?? -1}` : null;
}

/** Every copy against its real item, found by signature among the items that aren't copies. */
function registerAliases() {
  const { CacheDefinitions, ItemAliases } = Common.core;
  const copies = [];
  const originals = new Map();
  for (const [id, gameval] of CacheDefinitions.getObjNames()) {
    const type = CacheDefinitions.getItem(id);
    if (!type?.name || type.name === "null" || type.noteTemplate > 0 || type.placeholderTemplate > 0) continue;
    if (isCopy(gameval)) copies.push([id, type]);
    else {
      const key = signature(type);
      // The tradeable item first (the copies' own untradeable variants share models too).
      if (!originals.has(key) || (type.isTradable && !originals.get(key).tradable)) originals.set(key, { id, tradable: type.isTradable });
    }
  }
  for (const [id, type] of copies) {
    const original = originals.get(signature(type));
    if (original) ItemAliases.register(id, original.id);
  }
}

const DOSE = /^(.*[^ ])\((\d)\)$/;
const EMPTY_VIAL = "br_vial_empty";

/** Each potion's copies, most doses first, by the name they share ("Saradomin brew"). */
function potionChains() {
  const { CacheDefinitions } = Common.core;
  const families = new Map();
  for (const [id, gameval] of CacheDefinitions.getObjNames()) {
    const type = CacheDefinitions.getItem(id);
    if (!isCopy(gameval) || type?.noteTemplate > 0 || type?.placeholderTemplate > 0) continue;
    const match = DOSE.exec(type?.name ?? "");
    if (!match) continue;
    const doses = families.get(match[1]) ?? [];
    doses[Number(match[2])] = id;
    families.set(match[1], doses);
  }
  const chains = new Map();
  for (const [name, doses] of families) chains.set(name, doses.filter((id) => id > 0).reverse());
  return chains;
}

function registerPotions() {
  const emptyItemId = Common.objId(EMPTY_VIAL);
  for (const [name, chain] of potionChains()) Common.api.emitCustomEvent("potions:register-copy", { name, chain, emptyItemId });
}

function registerCopies() {
  registerAliases();
  registerPotions();
}

function attachItems(api) {
  api.onServerStartup(registerCopies);
}

module.exports = { attachItems, registerAliases, registerPotions, potionChains, signature };
