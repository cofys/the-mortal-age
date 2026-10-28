/**
 * Shattered Relics' skilling fragments and Clued In (data/league-shattered.json `skillingEffects`;
 * Wiki /Fragments). Each works with the number its equipped level gives in the cache
 * (Fragments.equippedValue). They hear the content's own events: `npc-drops:roll` and
 * `prayer:bury` (Praying Respects), `thieving:pickpocket-target` and `thieving:loot`,
 * `firemaking:success` and `league:log-burnt` (Slash & Burn's logs), `agility:mark`,
 * `minigame:points` and `npc-drops:tertiary-chance`.
 */
const Common = require("./Common.LeagueMode");
const Fragments = require("./Fragments.LeagueMode");
const { data } = require("./Shattered.LeagueMode");

/** Clue scroll entries in a drop table (NpcDrops' tertiary rows). */
const CLUE_SCROLL = /^clue scroll \(/i;

/** Log id -> the scroll box tier it gives, read once. */
let tiersByLog = null;

function effects() {
  return data.skillingEffects;
}

function core() {
  return Common.core;
}

function chance(percent) {
  return Math.random() * 100 < percent;
}

function value(player, effect) {
  return Fragments.equippedValue(player, effects()[effect].fragment);
}

// ---- Praying Respects ----

/**
 * Remains the player may bury: not those needing more Prayer than they have, nor the bones kept for
 * other uses (long and curved bones, which the bonecrusher leaves too).
 */
function buryable(player, itemId) {
  const row = { itemId, bone: null };
  Common.api.emitCustomEvent("prayer:bone", row);
  if (!row.bone) return true;
  return row.bone.crush !== false && (Number(row.bone.level) || 1) <= player.getSkillManager().getMaxLevel(core().Skill.PRAYER);
}

/** `npc-drops:roll`: remains the kill drops are buried or scattered at once, at the fragment's percent of their XP. */
function buryDrops({ player, drops }) {
  const percent = value(player, "prayingRespects");
  if (percent === null || !Array.isArray(drops)) return;
  for (let index = drops.length - 1; index >= 0; index--) {
    const { itemId, amount } = drops[index];
    if (!buryable(player, itemId)) continue;
    const bury = { player, itemId, scale: percent / 100, handled: false };
    for (let piece = 0; piece < amount; piece++) {
      bury.handled = false;
      Common.api.emitCustomEvent("prayer:bury", bury);
      if (!bury.handled) break;
    }
    if (bury.handled) drops.splice(index, 1);
  }
}

// ---- Smooth Criminal, Deeper Pockets ----

function pickpocketTarget(request) {
  const percent = value(request.player, "smoothCriminal");
  if (percent === null) return;
  request.chanceBonus = Math.max(request.chanceBonus ?? 0, percent);
  if (Fragments.equippedLevel(request.player, effects().smoothCriminal.fragment) >= effects().smoothCriminal.painlessFrom) request.painless = true;
}

/** Double loot, multiplied with the rogue outfit's by Thieving's own handover (a pouch's coins come directly; clues never twice). */
function doubleLoot(request) {
  const percent = value(request.player, "deeperPockets");
  if (percent === null || !chance(percent)) return;
  request.multiplier = (Number(request.multiplier) || 1) * 2;
}

// ---- Hot On The Trail ----

function tierFor(logId) {
  if (!tiersByLog) {
    tiersByLog = new Map(Object.entries(effects().hotOnTheTrail.logs)
      .map(([name, tier]) => [core().ItemIdentifiers[name], tier]).filter(([id]) => Number.isInteger(id)));
  }
  return tiersByLog.get(logId) ?? null;
}

/** A burnt log may turn up a scroll box of its tier, when the player may hold another. */
function logBurnt({ player, itemId }) {
  const percent = value(player, "hotOnTheTrail");
  const tier = tierFor(itemId);
  if (percent === null || !tier || !chance(percent)) return;
  const allowed = { player, tier, allowed: null };
  Common.api.emitCustomEvent("treasure-trails:can-receive", allowed);
  if (allowed.allowed === false) return;
  const box = core().ItemIdentifiers[`SCROLL_BOX_${tier.toUpperCase()}_`];
  player.getInventory().forceAdd(player, new (core().Item)(box, 1));
  player.sendMessage(data.messages.scrollBoxFound.replace("{tier}", tier));
}

// ---- Golden Brick Road, Grave Robber, Clued In ----

function markCoins(request) {
  const coins = value(request.player, "goldenBrickRoad");
  if (coins !== null && coins > 0) request.items.push([core().ItemIdentifiers.COINS, coins]);
}

/** `minigame:points` { player, minigame, points }: the Hallowed Sepulchre's marks, raised. */
function moreMarks(request) {
  if (request.minigame !== effects().graveRobber.minigame || !(request.points > 0)) return;
  const percent = value(request.player, "graveRobber");
  if (percent === null) return;
  // A part mark is a chance of a whole one, so 50% more of one mark is a mark half the time.
  const marks = (request.points * (100 + percent)) / 100;
  request.points = Math.floor(marks) + (Math.random() < marks - Math.floor(marks) ? 1 : 0);
}

function clueChance(request) {
  const oneIn = value(request.player, "cluedIn");
  if (oneIn !== null && oneIn > 0 && Array.isArray(request.rules)) request.rules.push({ pattern: CLUE_SCROLL, outOf: oneIn });
}

module.exports = function attach(api) {
  api.onCustomEvent("npc-drops:roll", buryDrops);
  api.onCustomEvent("thieving:pickpocket-target", pickpocketTarget);
  api.onCustomEvent("thieving:loot", doubleLoot);
  api.onCustomEvent("firemaking:success", logBurnt);
  api.onCustomEvent("league:log-burnt", logBurnt);
  api.onCustomEvent("agility:mark", markCoins);
  api.onCustomEvent("minigame:points", moreMarks);
  api.onCustomEvent("npc-drops:tertiary-chance", clueChance);
};

module.exports._test = { buryDrops, pickpocketTarget, doubleLoot, logBurnt, markCoins, moreMarks, clueChance };
