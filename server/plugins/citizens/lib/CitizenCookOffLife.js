"use strict";

/**
 * CitizenCookOffLife — slow-tick dynamics for the competitive cooking circuit.
 *
 * Runs on the director slow tick. Never throws.
 *
 * - Schedules weekly cook-offs per kingdom (mystery-ingredient themes from
 *   real farm produce).
 * - Auto-enters online chef-career citizens (Cooking 25+, REAL 100-coin fee
 *   from their inventory — broke chefs sit out honestly).
 * - Resolves cook-offs open 2+ days with 2+ scored chefs: picks a 3-judge
 *   panel (online non-entrants, social standing), pays REAL prize pots
 *   (70/20/10), awards the `ironchef` fame deed, announces near players.
 * - Journals everything per kingdom.
 */

const CookOffs = require("./CitizenCookOffs");

const COINS_ID = 995;
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // at most every 6h per kingdom
const MIN_COOKING_TO_ENTER = 25;

let _lastAnnounce = {}; // kingdomId -> { scheduled: ts, winner: ts }

function safeRequire(p) {
  try { return require(p); } catch { return null; }
}

function tickCookOffLife(director, nowMs) {
  try {
    nowMs = nowMs ?? Date.now();
    const kingdoms = kingdomsOf(director);
    for (const kid of kingdoms) {
      try { tickKingdom(director, kid, nowMs); } catch { /* per-kingdom safety */ }
    }
    CookOffs.save();
    return true;
  } catch {
    return false;
  }
}

function tickKingdom(director, kingdomId, nowMs) {
  // 1. Schedule if due.
  const fresh = CookOffs.scheduleCookOff(kingdomId, nowMs);
  if (fresh) {
    announce(director, kingdomId, nowMs, "scheduled",
      `A cook-off is announced! This week's mystery ingredient: ${fresh.mystery}. Chefs, enter for ${CookOffs.ENTRY_FEE} coins!`);
    journal(director, kingdomId, `Cook-off scheduled (mystery: ${fresh.mystery}).`);
  }

  // 2. Auto-enter eligible online chefs.
  const open = CookOffs.openCookOff(kingdomId);
  if (open) autoEnter(director, kingdomId, open, nowMs);

  // 3. Resolve cook-offs open 2+ days with 2+ scored chefs.
  for (const co of CookOffs.cookoffs()) {
    try {
      if (co.kingdomId !== kingdomId || co.resolvedAt) continue;
      if (nowMs - co.scheduledAt < CookOffs.COOKOFF_OPEN_MS) continue;
      const scored = co.entries.filter((e) => CookOffs.roundsTotal(e) > 0);
      if (scored.length < 2) continue;
      const judges = pickJudges(director, kingdomId, co);
      if (judges.length < 3) continue; // honest — no panel, no resolution yet
      const result = CookOffs.resolveCookOff(co.id,
        judges,
        (name, amt) => payPrize(director, name, amt),
        nowMs);
      if (result) {
        awardFame(result.winner, "ironchef");
        announce(director, kingdomId, nowMs, "winner",
          `${result.winner} wins the ${kingdomId} cook-off and takes ${result.placements[0].prize} coins!`);
        journal(director, kingdomId, `Cook-off won by ${result.winner} (pot ${result.pot}).`);
      }
    } catch { /* per-cook-off safety */ }
  }
}

function autoEnter(director, kingdomId, cookOff, nowMs) {
  const roster = director?.roster;
  if (!roster?.values) return;
  for (const record of roster.values()) {
    try {
      if (!record || record.kingdomId !== kingdomId) continue;
      if (record.career !== "chef") continue;
      const bot = director.isOnline?.(record) ? director.getBot?.(record) : null;
      if (!bot) continue;
      const player = bot.player ?? bot;
      const username = record.username;
      if (CookOffs.cookOffById(cookOff.id).entries.some((e) => e.chef === username)) continue;
      if (cookingLevel(player) < MIN_COOKING_TO_ENTER) continue;
      // Recipe-hunter deed: 3+ invented/discovered recipes, awarded once.
      try {
        if (CookOffs.recipesByChef(username).length >= 3 && CookOffs.markHunterDeeded(username)) {
          awardFame(username, "recipehunter");
        }
      } catch { /* deed is best-effort */ }
      const entered = CookOffs.enterCookOff(cookOff.id, username,
        (name, amt) => takeCoins(player, amt), nowMs);
      if (entered) journal(director, kingdomId, `${username} entered the cook-off.`);
    } catch { /* per-citizen safety */ }
  }
}

/** Pick 3 judges: online non-entrants in the kingdom, by social standing. */
function pickJudges(director, kingdomId, cookOff) {
  const entrants = new Set(cookOff.entries.map((e) => e.chef));
  const roster = director?.roster;
  if (!roster?.values) return [];
  const candidates = [];
  for (const record of roster.values()) {
    try {
      if (!record || record.kingdomId !== kingdomId) continue;
      if (entrants.has(record.username)) continue;
      const bot = director.isOnline?.(record) ? director.getBot?.(record) : null;
      if (!bot) continue;
      candidates.push({ name: record.username, social: socialScore(record) });
    } catch { /* skip */ }
  }
  candidates.sort((a, b) => b.social - a.social);
  return candidates.slice(0, 3).map((c) => ({
    name: c.name,
    strictness: Math.min(1, Math.max(0, (100 - c.social) / 100 * 0.8)),
  }));
}

function socialScore(record) {
  try {
    const rep = record.reputation ?? 0;
    return Math.max(0, Math.min(100, 50 + rep));
  } catch { return 0; }
}

function cookingLevel(player) {
  try {
    const Skill = safeRequire("../../../src/main/typescript/elvarg/game/model/Skill")?.Skill;
    const mgr = player?.getSkillManager?.();
    if (!mgr || typeof mgr.getCurrentLevel !== "function") return 1;
    // Prefer the real enum; fall back to a string probe for test doubles
    // whose getCurrentLevel ignores its argument.
    const lvl = Skill ? mgr.getCurrentLevel(Skill.COOKING) : mgr.getCurrentLevel("cooking");
    return Number.isInteger(lvl) && lvl > 0 ? lvl : 1;
  } catch { return 1; }
}

function amountIn(inv, id) {
  try { return typeof inv?.getAmount === "function" ? inv.getAmount(id) : 0; } catch { return 0; }
}

function takeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return false;
    const before = amountIn(inv, COINS_ID);
    if (before < amount) return false;
    // Canonical engine API: ItemContainer.deleteNumber(id, amount).
    // There is no inv.remove(id, amount) — the old call was a silent no-op
    // that still returned true, inflating the prize pot with uncollected fees.
    if (typeof inv.deleteNumber === "function") inv.deleteNumber(COINS_ID, amount);
    else if (typeof inv.delete === "function") inv.delete(COINS_ID, amount);
    else return false;
    // Honest: the balance must actually have moved, or the fee wasn't taken.
    return amountIn(inv, COINS_ID) === before - amount;
  } catch { return false; }
}

function payPrize(director, username, amount) {
  try {
    const bot = director?.getBot?.({ username });
    if (!bot) return false; // offline — honestly skip, never invent
    const player = bot.player ?? bot;
    const inv = player?.inventory ?? player?.getInventory?.();
    if (!inv) return false;
    const before = amountIn(inv, COINS_ID);
    // Canonical engine API: ItemContainer.adds(id, amount). The old
    // inv.add(COINS_ID, amount) hit the wrong overload (add(item, refresh)
    // expects an Item object) and threw, so prizes silently never landed.
    if (typeof inv.adds !== "function") return false;
    inv.adds(COINS_ID, amount);
    // Honest: the prize must actually be in the inventory.
    return amountIn(inv, COINS_ID) === before + amount;
  } catch { return false; }
}

function awardFame(username, deedKind) {
  try {
    const Rep = safeRequire("./CitizenReputation");
    Rep?.awardDeed?.(username, deedKind, Date.now());
  } catch { /* reputation unavailable — skip honestly */ }
}

function announce(director, kingdomId, nowMs, kind, message) {
  try {
    const last = _lastAnnounce[kingdomId]?.[kind] ?? 0;
    if (nowMs - last < ANNOUNCE_COOLDOWN_MS) return;
    const { sayPublic } = safeRequire("../chat/CitizenSayPublic") || {};
    if (!sayPublic) return;
    const roster = director?.roster;
    if (!roster?.values) return;
    for (const record of roster.values()) {
      try {
        if (!record || record.kingdomId !== kingdomId) continue;
        const citizen = director.isOnline?.(record) ? director.getBot?.(record) : null;
        if (!citizen) continue;
        sayPublic(citizen, message);
        _lastAnnounce[kingdomId] = _lastAnnounce[kingdomId] ?? {};
        _lastAnnounce[kingdomId][kind] = nowMs;
        return; // one announcer is enough
      } catch { /* try next */ }
    }
  } catch { /* never throw */ }
}

function journal(director, kingdomId, text) {
  try { director?.getJournal?.()?.log?.(`[cookoff:${kingdomId}] ${text}`); } catch { /* skip */ }
}

function kingdomsOf(director) {
  try {
    const ks = director?.kingdoms ?? director?.getKingdoms?.();
    if (Array.isArray(ks)) return ks.map((k) => k.id ?? k.kingdomId ?? k).filter(Boolean);
    if (ks && typeof ks === "object") return Object.keys(ks);
  } catch { /* fall through */ }
  return [];
}

function resetForTests() {
  _lastAnnounce = {};
}

module.exports = { tickCookOffLife, resetForTests };
