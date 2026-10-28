/**
 * Shattered Relics' fragment drops (data/league-shattered.json `fragmentDrops`). Wiki /Fragments:
 * fragments come from the activity at hand, more often the more XP it gives, and combat ones by
 * the NPC's tier. They arrive as the cache's Unidentified fragment items, which Break opens into a
 * fragment of their own (the fragment's item, param 1462) not yet mastered: a new one is owned at
 * level 1, a known one gains 500 fragment XP (Fragments.award). A combat item carries its NPC's
 * tier and opens into a fragment of that tier (param 1454), or the nearest tier with one left. A
 * full inventory drops the item to the floor. The rates are this server's (the Wiki gives none).
 *
 * `::fragment <id|category> [tier]` (developer) hands one out.
 */
const Common = require("./Common.LeagueMode");
const Fragments = require("./Fragments.LeagueMode");
const { data, isShattered } = require("./Shattered.LeagueMode");

/** The combat tier a combat item opens into, kept on the item itself. */
const TIER_META = "league:fragment-tier";

/** NPC name (lower case) -> combat tier, read once from the data. */
let tierByName = null;

function drops() {
  return data.fragmentDrops;
}

function tierOf(name) {
  if (!tierByName) {
    tierByName = new Map();
    for (const [tier, npcs] of Object.entries(drops().combatTiers)) {
      for (const npc of npcs) tierByName.set(npc.toLowerCase(), Number(tier));
    }
  }
  return tierByName.get(String(name ?? "").toLowerCase()) ?? 1;
}

/** Into the inventory, or onto the floor when it is full (Wiki). */
function giveItem(player, category, tier = 0) {
  const { Item } = Common.core;
  player.getInventory().forceAdd(player, new Item(drops().items[category], 1, tier > 0 ? { [TIER_META]: tier } : null));
}

/** onExperienceGained: a skill's XP may turn up its category's fragment, more likely the more XP. */
function skillingDrop({ player, skill, experience }) {
  if (!isShattered(player)) return;
  const category = drops().skills[Number(skill?.getClientId?.())];
  if (!category) return;
  if (Math.random() < Number(experience) / drops().xpPerDrop[category]) giveItem(player, category);
}

/** onNpcDeath: a kill may turn up a combat fragment of the NPC's tier, more likely the tougher the NPC. */
function combatDrop({ killer, npc }) {
  if (!killer?.isPlayer?.() || !isShattered(killer)) return;
  const definition = npc?.getCurrentDefinition?.(killer) ?? npc?.getDefinition?.();
  const hitpoints = Number(definition?.getHitpoints?.()) || 0;
  if (hitpoints <= 0) return;
  if (Math.random() < Math.min(1, hitpoints / drops().hitpointsPerDrop)) giveItem(killer, "combat", tierOf(definition?.getName?.()));
}

/** The fragments an item can open into: its own, not mastered, and for a combat tier that tier's (else the nearest). */
function pool(player, itemId, tier) {
  const own = [...Fragments.allDefinitions()]
    .filter(([id, row]) => row.item === Number(itemId) && Fragments.findable(player, id));
  if (!tier) return own.map(([id]) => id);
  const tiers = [...new Set(own.map(([, row]) => row.tier))].sort((a, b) => Math.abs(a - tier) - Math.abs(b - tier) || a - b);
  return tiers.length ? own.filter(([, row]) => row.tier === tiers[0]).map(([id]) => id) : [];
}

/** Break: the item opens into a fragment of its kind that isn't mastered yet. */
function breakFragment(event) {
  const { player, itemId, item, slot } = event;
  if (!isShattered(player)) return false;
  const category = Object.keys(drops().items).find((key) => drops().items[key] === Number(itemId));
  if (!category) return false;
  const tier = category === "combat" ? Number(item?.getMetaValue?.(TIER_META)) || 1 : 0;
  const options = pool(player, itemId, tier);
  if (!options.length) {
    player.sendMessage(data.messages.fragmentsMastered);
    return true;
  }
  player.getInventory().deleteAtSlot(slot, 1);
  const id = options[Math.floor(Math.random() * options.length)];
  const { duplicate } = Fragments.award(player, id);
  player.sendMessage((duplicate ? data.messages.fragmentDuplicate : data.messages.fragmentFound)
    .replace("{name}", Fragments.definition(id).name).replace("{xp}", data.fragmentXp.duplicate));
  return true;
}

function fragmentCommand({ player, parts }) {
  const what = String(parts[1] ?? "").toLowerCase();
  if (!isShattered(player) || !what) {
    player.sendMessage(data.messages.fragmentUsage);
    return true;
  }
  if (drops().items[what] !== undefined) {
    giveItem(player, what, what === "combat" ? Number(parts[2]) || 1 : 0);
    return true;
  }
  const definition = Fragments.definition(Number(what));
  if (!definition) {
    player.sendMessage(data.messages.fragmentUsage);
    return true;
  }
  Fragments.award(player, Number(what));
  player.sendMessage(data.messages.fragmentFound.replace("{name}", definition.name));
  return true;
}

module.exports = function attach(api) {
  api.onExperienceGained(skillingDrop);
  api.onNpcDeath(combatDrop);
  api.onItemAction("Unidentified fragment (harvesting)", { Break: breakFragment });
  api.onItemAction("Unidentified fragment (production)", { Break: breakFragment });
  api.onItemAction("Unidentified fragment (skilling)", { Break: breakFragment });
  api.onItemAction("Unidentified fragment (combat)", { Break: breakFragment });
  api.onItemAction("Unidentified fragment (misc)", { Break: breakFragment });
  api.registerCommand("fragment", fragmentCommand, api.core.PlayerRights.DEVELOPER,
    "Give a Shattered Relics fragment: ::fragment <id|harvesting|production|skilling|combat|misc> [tier]");
};

module.exports._test = { tierOf, pool, giveItem, TIER_META };
