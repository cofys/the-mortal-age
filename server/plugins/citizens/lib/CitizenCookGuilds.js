"use strict";

/**
 * CitizenCookGuilds — the Chefs' Guild: the culinary profession's operations
 * layer for The Mortal Age.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenCookOffs owns: weekly cook-offs, judging, recipes (invent /
 *     discover / trade), recipehunter deeds. THIS module never reimplements
 *     any of that — it READS recipes.
 *   - CitizenCuisine owns: master chefs, signature dishes, restaurants,
 *     menus, dish reviews, best-dish showcases. THIS module READS dishes and
 *     menus (never mutates them).
 *   - CitizenCookOffLife owns: cook-off scheduling, judging, prizes.
 *   - CitizenCookGuildEvents owns: the ::cookguild player command.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - One Chefs' Guild per kingdom with a hall tile near the market, a real
 *     tracked treasury, a real tracked hygiene fund, and prestige.
 *   - Membership: apprentice -> souschef -> chefdecuisine. Joining requires
 *     being a REAL chef: the `chef` career (CitizenCareers.careerOf), OR a
 *     master chef (CitizenCuisine.isMasterChef), OR a citizen who holds a
 *     REAL invented recipe (CitizenCookOffs.recipesByChef non-empty). The
 *     guild polices the trade, never mints chefs. Weekly dues in REAL coins;
 *     two missed online collections -> suspended until caught up. Offline
 *     members are never penalized.
 *   - Recipe certification: members submit recipes they REALLY invented
 *     (verified against CitizenCookOffs.recipeById — recipe exists, inventor
 *     matches the claimant, quality is finite 1-10, not already sealed). A
 *     50-coin real fee (mentored apprentices certify free). Grades from the
 *     REAL quality: >=8=A, >=5=B, else C. The guild pays a REAL bounty from
 *     its treasury (C:30 / B:60 / A:120); the hygiene fund backs bounties
 *     when the treasury runs dry; when both are broke the bounty is owed
 *     honestly, never invented.
 *   - Hygiene tribunal: the one verifiable culinary crime — recipe theft: a
 *     recipe in the cook-offs ledger whose normalized name duplicates an
 *     EARLIER recipe by a DIFFERENT inventor. Members/players report;
 *     chefdecuisine-rank members vote; 24h auto-settle. Guilty -> expulsion
 *     + `recipethief` deed.
 *   - Kitchen inspections: the guild's hygiene score per kingdom is computed
 *     from REAL data — the restaurant menu (CitizenCuisine.menuFor) and each
 *     dish's REAL quality (CitizenCuisine.dishById). Any dish at quality <=2
 *     fails inspection. Scores below 40 trigger a public kitchen-audit
 *     announcement.
 *   - Golden ladle: quarterly, the guild member with the most REAL sealed
 *     recipes in the kingdom wins a 200-coin real prize (owed honestly when
 *     broke) and a public announcement.
 *   - Culinary school: chefdecuisine masters teach apprentices (training
 *     credits). Promotion: apprentice -> souschef (30d tenure + 2 credits +
 *     a real invented recipe), souschef -> chefdecuisine (60d tenure + 4
 *     credits + 2 conducted certifications + clean record). All verifiable
 *     from real records — never invented.
 *   - Mentorship: chefdecuisine masters take apprentice members under wing.
 *     While mentored, the apprentice pays no certification fees and their
 *     certifications count double toward promotion. Mentorship ends after
 *     the first certification.
 *   - Certified archive: the guild's certified registry — metadata copies of
 *     every certified recipe (the recipe stays in the cook-offs ledger;
 *     never a double-spend). Prestige 0-100 from real counts.
 *   - Public API: isGuildMember, guildRankOf, memberOf, sealFor, gradeFor,
 *     guildTreasuryFor, hygieneFor, describe.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here — see lib/CitizenCookGuildLife.js.
 *   - No LLM. Announcements are journaled; the chat layer riffs.
 *   - No invented chefs, recipes, dishes, inspections, coins, or menus.
 */

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-cookguilds.json";
const COINS_ID = 995;

const RANK_APPRENTICE = "apprentice";
const RANK_SOUSCHEF = "souschef";
const RANK_CHEFDECUISINE = "chefdecuisine";
const RANKS = Object.freeze([RANK_APPRENTICE, RANK_SOUSCHEF, RANK_CHEFDECUISINE]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_HYGIENE_SHARE = 5; // of each dues payment feeds the hygiene fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2;

const CERT_FEE = 50; // real coins to certify a recipe
const CERT_BOUNTY = Object.freeze({ C: 30, B: 60, A: 120 });
const GRADE_A_QUALITY = 8;
const GRADE_B_QUALITY = 5;

const LADLE_PERIOD_MS = 90 * 24 * 60 * 60 * 1000; // quarterly golden ladle
const LADLE_PRIZE = 200; // real coins from the treasury

const CASE_TTL_MS = 24 * 60 * 60 * 1000; // tribunal cases auto-settle after 24h
const VOTES_FOR_QUORUM = 2;

const HALL_TILE_DX = -6; // guild hall sits a few tiles from the market
const HALL_TILE_DY = 4;

const HYGIENE_AUDIT_THRESHOLD = 40; // below this the guild announces an audit
const DISH_FAIL_QUALITY = 2; // a dish at or below this fails inspection

const PROMOTE_SOUSCHEF = Object.freeze({ tenureMs: 30 * 24 * 3600 * 1000, credits: 2 });
const PROMOTE_CHEFDECUISINE = Object.freeze({ tenureMs: 60 * 24 * 3600 * 1000, credits: 4, certifications: 2 });

const CULINARY_CODE = Object.freeze([
  "The recipe is the recipe — never claim a dish you did not invent.",
  "A clean kitchen is a guild kitchen: nothing below grade leaves the pass.",
  "Honor every ingredient; waste is theft from the land.",
  "Charge honest prices; the hungry can smell a cheat.",
  "Teach one apprentice for every season you cook.",
]);

// --- state ---------------------------------------------------------------

let cache = null;
let dirty = false;

function blankState() {
  return {
    guilds: Object.create(null), // kingdomId -> { kingdomId, hallTile, foundedAt, treasury, hygieneFund, prestige, hygiene, lastInspectionAt, lastLadleAt }
    members: Object.create(null), // norm -> { username, kingdomId, rank, joinedAt, duesPaidUntilMs, missedDues, suspended, trainingCredits, certCount, clean, mentor }
    seals: Object.create(null), // "kingdomId:recipeId" -> { kingdomId, recipeId, holder, grade, sealedAt }
    queue: [], // [ { kingdomId, recipeId, owner, submittedAt } ]
    bountiesOwed: Object.create(null), // "owner:kingdomId:recipeId" -> coins owed
    cases: Object.create(null), // caseId -> { id, kingdomId, accused, kind, reporter, at, votes: {voter: bool}, settled, verdict }
    ladleOwed: Object.create(null), // kingdomId -> coins owed
    nextCaseId: 1,
  };
}

function ensure() {
  if (!cache) cache = blankState();
  return cache;
}

function markDirty() { dirty = true; }

function norm(name) {
  return String(name || "").toLowerCase().trim();
}

// --- kingdom helpers (defensive) ------------------------------------------

function kingdomIds() {
  try {
    const S = require("../brain/CitizenSites");
    if (S && Array.isArray(S.KINGDOM_IDS) && S.KINGDOM_IDS.length) return S.KINGDOM_IDS.slice();
  } catch { /* fall through */ }
  return [];
}

function hallTileFor(kingdomId) {
  const kid = String(kingdomId || "");
  let tile = null;
  try {
    const S = require("../brain/CitizenSites");
    // siteTileByKingdom: the plain-object form. siteTile({ kingdomId }, "market")
    // would read kingdomIdOf() off getAttribute (missing on a plain object) and
    // silently resolve to the FIRST kingdom's market for every kingdom.
    tile = S && typeof S.siteTileByKingdom === "function"
      ? S.siteTileByKingdom(kid, "market")
      : null;
  } catch { tile = null; }
  if (!tile) return { x: 3200, y: 3200, z: 0 };
  return { x: (tile.x ?? 3200) + HALL_TILE_DX, y: (tile.y ?? 3200) + HALL_TILE_DY, z: tile.z ?? 0 };
}

// --- guilds ---------------------------------------------------------------

function ensureGuild(kingdomId) {
  const s = ensure();
  if (!s.guilds[kingdomId]) {
    s.guilds[kingdomId] = {
      kingdomId,
      hallTile: hallTileFor(kingdomId),
      foundedAt: Date.now(),
      treasury: 0,
      hygieneFund: 0,
      prestige: 0,
      hygiene: 100,
      lastInspectionAt: 0,
      lastLadleAt: 0,
    };
    markDirty();
  }
  return s.guilds[kingdomId];
}

function guildOf(kingdomId) {
  ensureGuild(kingdomId);
  return ensure().guilds[kingdomId];
}

function guildTreasuryFor(kingdomId) {
  return guildOf(kingdomId).treasury;
}

function hygieneFor(kingdomId) {
  return guildOf(kingdomId).hygiene;
}

// --- membership -----------------------------------------------------------

function isGuildMember(username) {
  return !!ensure().members[norm(username)];
}

function memberOf(username) {
  return ensure().members[norm(username)] || null;
}

function memberNames(kingdomId) {
  const s = ensure();
  return Object.keys(s.members).filter((n) => s.members[n].kingdomId === kingdomId);
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

/** A REAL chef: the chef career, a master chef, or holds a real recipe. */
function isRealChef(username) {
  const n = norm(username);
  if (!n) return false;
  try {
    const C = require("./CitizenCareers");
    const rec = C && typeof C.careerOf === "function" ? C.careerOf(username) : null;
    if (rec && String(rec.career || rec.name || "").toLowerCase() === "chef") return true;
  } catch { /* no careers */ }
  try {
    const K = require("./CitizenCuisine");
    if (K && typeof K.isMasterChef === "function" && K.isMasterChef(username)) return true;
  } catch { /* no cuisine */ }
  try {
    const O = require("./CitizenCookOffs");
    if (O && typeof O.recipesByChef === "function") {
      const recipes = O.recipesByChef(username) || [];
      if (recipes.length > 0) return true;
    }
  } catch { /* no cookoffs */ }
  return false;
}

function joinGuild(username, kingdomId) {
  const s = ensure();
  const n = norm(username);
  if (!username) return { ok: false, reason: "no-username" };
  if (s.members[n]) return { ok: false, reason: "already-member" };
  if (!isRealChef(username)) return { ok: false, reason: "not-a-chef" };
  ensureGuild(kingdomId);
  const now = Date.now();
  s.members[n] = {
    username,
    kingdomId,
    rank: RANK_APPRENTICE,
    joinedAt: now,
    duesPaidUntilMs: now + DUES_PERIOD_MS, // first week free
    missedDues: 0,
    suspended: false,
    trainingCredits: 0,
    certCount: 0,
    clean: true,
    mentor: null,
  };
  markDirty();
  return { ok: true, rank: RANK_APPRENTICE };
}

function leaveGuild(username) {
  const s = ensure();
  const n = norm(username);
  if (!s.members[n]) return { ok: false, reason: "not-a-member" };
  delete s.members[n];
  markDirty();
  return { ok: true };
}

function recordDuesPayment(username, nowMs) {
  const s = ensure();
  const m = s.members[norm(username)];
  if (!m) return { ok: false };
  const g = ensureGuild(m.kingdomId);
  g.treasury += (DUES_WEEKLY - DUES_HYGIENE_SHARE);
  g.hygieneFund += DUES_HYGIENE_SHARE;
  m.duesPaidUntilMs = Math.max(m.duesPaidUntilMs || 0, nowMs) + DUES_PERIOD_MS;
  // Paying up restores good standing: suspended members rejoin by catching up.
  m.missedDues = 0;
  m.suspended = false;
  markDirty();
  return { ok: true };
}

function recordMissedDues(username, nowMs) {
  const s = ensure();
  const m = s.members[norm(username)];
  if (!m) return { ok: false };
  m.missedDues = (m.missedDues || 0) + 1;
  if (m.missedDues >= SUSPEND_AFTER_MISSED) m.suspended = true;
  markDirty();
  return { ok: true, suspended: m.suspended };
}

// --- recipe certification --------------------------------------------------

function gradeForQuality(quality) {
  if (quality >= GRADE_A_QUALITY) return "A";
  if (quality >= GRADE_B_QUALITY) return "B";
  return "C";
}

/** The REAL recipe record, or null. */
function realRecipeFor(recipeId) {
  try {
    const O = require("./CitizenCookOffs");
    if (O && typeof O.recipeById === "function") return O.recipeById(recipeId) || null;
  } catch { /* no cookoffs */ }
  return null;
}

function sealFor(kingdomId, recipeId) {
  return ensure().seals[`${kingdomId}:${recipeId}`] || null;
}

function gradeFor(kingdomId, recipeId) {
  const seal = sealFor(kingdomId, recipeId);
  return seal ? seal.grade : null;
}

function submitRecipe(username, kingdomId, recipeId, nowMs) {
  const s = ensure();
  const n = norm(username);
  const m = s.members[n];
  if (!m || m.suspended) return { ok: false, reason: "not-member-in-good-standing" };
  if (m.kingdomId !== kingdomId) return { ok: false, reason: "wrong-kingdom" };
  // Verify against the REAL cook-offs ledger.
  const rec = realRecipeFor(recipeId);
  if (!rec) return { ok: false, reason: "no-such-recipe" };
  if (norm(rec.inventor) !== n) return { ok: false, reason: "not-your-recipe" };
  if (!Number.isFinite(rec.quality) || rec.quality < 1 || rec.quality > 10) {
    return { ok: false, reason: "impossible-quality" };
  }
  const key = `${kingdomId}:${recipeId}`;
  if (s.seals[key]) return { ok: false, reason: "already-sealed" };
  // Fee: mentored apprentices certify free.
  const fee = m.mentor ? 0 : CERT_FEE;
  s.queue.push({ kingdomId, recipeId, owner: username, submittedAt: nowMs || Date.now() });
  markDirty();
  return { ok: true, fee, quality: rec.quality };
}

function settleCertification(kingdomId, recipeId, nowMs) {
  const s = ensure();
  const key = `${kingdomId}:${recipeId}`;
  const qi = s.queue.findIndex((q) => q.kingdomId === kingdomId && q.recipeId === recipeId);
  if (qi < 0) return { ok: false, reason: "not-queued" };
  const q = s.queue[qi];
  // Re-verify at settle time (the recipe may have changed since).
  const rec = realRecipeFor(recipeId);
  if (!rec || norm(rec.inventor) !== norm(q.owner) ||
      !Number.isFinite(rec.quality) || rec.quality < 1 || rec.quality > 10) {
    s.queue.splice(qi, 1);
    markDirty();
    return { ok: false, reason: "recipe-changed" };
  }
  const grade = gradeForQuality(rec.quality);
  const m = s.members[norm(q.owner)];
  let bounty = CERT_BOUNTY[grade] || 0;
  const g = ensureGuild(kingdomId);
  let owed = 0;
  // Pay from treasury, then hygiene fund, then owe honestly.
  let remaining = bounty;
  const fromTreasury = Math.min(g.treasury, remaining);
  g.treasury -= fromTreasury; remaining -= fromTreasury;
  const fromHygiene = Math.min(g.hygieneFund, remaining);
  g.hygieneFund -= fromHygiene; remaining -= fromHygiene;
  if (remaining > 0) {
    const okey = `${q.owner}:${key}`;
    s.bountiesOwed[okey] = (s.bountiesOwed[okey] || 0) + remaining;
    owed = remaining;
  }
  s.seals[key] = {
    kingdomId, recipeId, holder: q.owner, grade,
    sealedAt: nowMs || Date.now(),
  };
  s.queue.splice(qi, 1);
  if (m) {
    const credit = m.mentor ? 2 : 1; // mentored apprentices earn double credit
    m.certCount = (m.certCount || 0) + credit;
    if (m.mentor) m.mentor = null; // mentorship ends after first certification
  }
  g.prestige = Math.min(100, g.prestige + 2);
  markDirty();
  return { ok: true, grade, bounty, paid: bounty - owed, owed };
}

function retryOwedBounties(kingdomId) {
  const s = ensure();
  const g = ensureGuild(kingdomId);
  let paid = 0;
  for (const okey of Object.keys(s.bountiesOwed)) {
    // Keys are "owner:kingdomId:recipeId"; the last two segments are the
    // ledger address (recipe ids carry no colons). Never spend one kingdom's
    // treasury on another kingdom's debts.
    const ledgerKid = okey.split(":").slice(-2)[0];
    if (ledgerKid !== kingdomId) continue;
    const amt = s.bountiesOwed[okey];
    if (!amt) continue;
    const fromTreasury = Math.min(g.treasury, amt);
    g.treasury -= fromTreasury;
    let remaining = amt - fromTreasury;
    const fromHygiene = Math.min(g.hygieneFund, remaining);
    g.hygieneFund -= fromHygiene;
    remaining -= fromHygiene;
    if (remaining <= 0) { delete s.bountiesOwed[okey]; paid += amt; }
    else { s.bountiesOwed[okey] = remaining; paid += (amt - remaining); }
  }
  if (paid) markDirty();
  return { paid };
}

/** Retry a kingdom's owed golden-ladle prize from its own treasury. */
function retryOwedLadle(kingdomId) {
  const s = ensure();
  const g = ensureGuild(kingdomId);
  const owed = s.ladleOwed[kingdomId] || 0;
  if (!owed) return { paid: 0 };
  const fromTreasury = Math.min(g.treasury, owed);
  g.treasury -= fromTreasury;
  const remaining = owed - fromTreasury;
  if (remaining <= 0) delete s.ladleOwed[kingdomId];
  else s.ladleOwed[kingdomId] = remaining;
  if (fromTreasury) markDirty();
  return { paid: fromTreasury };
}

// --- kitchen inspections ----------------------------------------------------

function inspectKitchens(kingdomId, nowMs) {
  // Computes a hygiene score 0-100 from REAL data: the kingdom's restaurant
  // menu and each dish's REAL quality. Any dish at or below DISH_FAIL_QUALITY
  // fails inspection. Never invents dishes, menus, or qualities.
  const fails = [];
  let total = 0;
  let count = 0;
  try {
    const K = require("./CitizenCuisine");
    if (K && typeof K.menuFor === "function" && typeof K.dishById === "function") {
      const menu = K.menuFor(kingdomId) || [];
      for (const dishId of menu) {
        const dish = K.dishById(dishId);
        if (!dish || !Number.isFinite(dish.quality)) continue;
        total += dish.quality;
        count++;
        if (dish.quality <= DISH_FAIL_QUALITY) {
          fails.push({ dishId, chef: dish.chefName || dish.chef || null, quality: dish.quality });
        }
      }
    }
  } catch { /* cuisine missing */ }
  const score = count > 0 ? Math.round((total / count / 10) * 100) : 100;
  const g = ensureGuild(kingdomId);
  g.hygiene = score;
  g.lastInspectionAt = nowMs || Date.now();
  markDirty();
  return { ok: true, hygiene: score, inspected: count, fails };
}

// --- recipe-theft tribunal --------------------------------------------------

function normalizedName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function scanRecipeTheft() {
  // The one verifiable culinary crime: a recipe in the cook-offs ledger
  // whose normalized name duplicates an EARLIER recipe by a DIFFERENT
  // inventor. Returns [{ recipeId, inventor, originalId, originalInventor }].
  const out = [];
  try {
    const O = require("./CitizenCookOffs");
    // allRecipes() is the read-only ledger enumerator; without it the scan
    // has nothing to scan and silently returns [].
    if (O && typeof O.allRecipes === "function") {
      const seen = new Map(); // normalized name -> { id, inventor, createdAt }
      for (const r of O.allRecipes() || []) {
        const key = normalizedName(r.name);
        if (!key) continue;
        const prior = seen.get(key);
        if (prior && norm(prior.inventor) !== norm(r.inventor) &&
            (r.createdAt || 0) > (prior.createdAt || 0)) {
          out.push({ recipeId: r.id, inventor: r.inventor, originalId: prior.id, originalInventor: prior.inventor });
        } else if (!prior) {
          seen.set(key, { id: r.id, inventor: r.inventor, createdAt: r.createdAt || 0 });
        }
      }
    }
  } catch { /* cookoffs missing */ }
  return out;
}

function reportTheft(kingdomId, accused, reporter) {
  const s = ensure();
  const n = norm(accused);
  // No double jeopardy: one open case per accused.
  for (const id of Object.keys(s.cases)) {
    const c = s.cases[id];
    if (!c.settled && norm(c.accused) === n) return { ok: false, reason: "case-open" };
  }
  const id = `case-${s.nextCaseId++}`;
  s.cases[id] = {
    id, kingdomId, accused, kind: "recipe-theft",
    reporter: reporter || "guild",
    at: Date.now(), votes: {}, settled: false, verdict: null,
  };
  markDirty();
  return { ok: true, id };
}

function voteCase(caseId, voter, guilty) {
  const s = ensure();
  const c = s.cases[caseId];
  if (!c || c.settled) return { ok: false, reason: "no-such-case" };
  if (guildRankOf(voter) !== RANK_CHEFDECUISINE) return { ok: false, reason: "not-chefdecuisine" };
  c.votes[norm(voter)] = !!guilty;
  markDirty();
  return { ok: true };
}

function settleRipeCases(kingdomId, nowMs) {
  const s = ensure();
  const settled = [];
  for (const id of Object.keys(s.cases)) {
    const c = s.cases[id];
    if (c.settled || c.kingdomId !== kingdomId) continue;
    if ((nowMs || Date.now()) - c.at < CASE_TTL_MS) continue;
    const votes = Object.values(c.votes);
    const guilty = votes.filter(Boolean).length;
    const total = votes.length;
    c.settled = true;
    if (total >= VOTES_FOR_QUORUM && guilty * 2 > total) {
      c.verdict = "guilty";
      // Expel the thief.
      const m = s.members[norm(c.accused)];
      if (m) { m.suspended = true; m.clean = false; }
    } else {
      c.verdict = "acquitted";
    }
    settled.push({ id, verdict: c.verdict, accused: c.accused });
    markDirty();
  }
  return settled;
}

// --- golden ladle -------------------------------------------------------------

function grantLadle(kingdomId, nowMs) {
  const s = ensure();
  const g = ensureGuild(kingdomId);
  if ((nowMs || Date.now()) - (g.lastLadleAt || 0) < LADLE_PERIOD_MS) {
    return { ok: false, reason: "too-soon" };
  }
  // The member with the most sealed recipes in this kingdom wins.
  let best = null; let bestCount = 0;
  for (const key of Object.keys(s.seals)) {
    const seal = s.seals[key];
    if (seal.kingdomId !== kingdomId) continue;
    const m = s.members[norm(seal.holder)];
    if (!m || m.suspended) continue;
    const count = Object.values(s.seals).filter((x) =>
      x.kingdomId === kingdomId && norm(x.holder) === norm(seal.holder)).length;
    if (count > bestCount) { bestCount = count; best = seal.holder; }
  }
  if (!best) return { ok: false, reason: "no-candidates" };
  g.lastLadleAt = nowMs || Date.now();
  let owed = 0;
  const fromTreasury = Math.min(g.treasury, LADLE_PRIZE);
  g.treasury -= fromTreasury;
  const remaining = LADLE_PRIZE - fromTreasury;
  if (remaining > 0) {
    s.ladleOwed[kingdomId] = (s.ladleOwed[kingdomId] || 0) + remaining;
    owed = remaining;
  }
  markDirty();
  return { ok: true, winner: best, recipes: bestCount, paid: LADLE_PRIZE - owed, owed };
}

// --- culinary school & mentorship ----------------------------------------------

function holdClass(kingdomId, master) {
  const s = ensure();
  if (guildRankOf(master) !== RANK_CHEFDECUISINE) return { ok: false, reason: "not-chefdecuisine" };
  const g = ensureGuild(kingdomId);
  let taught = 0;
  for (const n of Object.keys(s.members)) {
    const m = s.members[n];
    if (m.kingdomId !== kingdomId || m.suspended) continue;
    if (m.rank === RANK_APPRENTICE) { m.trainingCredits = (m.trainingCredits || 0) + 1; taught++; }
  }
  if (taught) markDirty();
  return { ok: true, taught };
}

function hasRealRecipe(username) {
  try {
    const O = require("./CitizenCookOffs");
    if (O && typeof O.recipesByChef === "function") {
      return (O.recipesByChef(username) || []).length > 0;
    }
  } catch { /* no cookoffs */ }
  return false;
}

function tryPromote(username, nowMs) {
  const s = ensure();
  const m = s.members[norm(username)];
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  const now = nowMs || Date.now();
  if (m.rank === RANK_APPRENTICE) {
    const tenureOk = now - m.joinedAt >= PROMOTE_SOUSCHEF.tenureMs;
    const creditsOk = (m.trainingCredits || 0) >= PROMOTE_SOUSCHEF.credits;
    const recipeOk = hasRealRecipe(username);
    if (tenureOk && creditsOk && recipeOk && m.clean) {
      m.rank = RANK_SOUSCHEF;
      markDirty();
      return { ok: true, rank: RANK_SOUSCHEF };
    }
    return { ok: false, reason: "requirements-unmet" };
  }
  if (m.rank === RANK_SOUSCHEF) {
    const tenureOk = now - m.joinedAt >= PROMOTE_CHEFDECUISINE.tenureMs;
    const creditsOk = (m.trainingCredits || 0) >= PROMOTE_CHEFDECUISINE.credits;
    const certsOk = (m.certCount || 0) >= PROMOTE_CHEFDECUISINE.certifications;
    if (tenureOk && creditsOk && certsOk && m.clean) {
      m.rank = RANK_CHEFDECUISINE;
      markDirty();
      return { ok: true, rank: RANK_CHEFDECUISINE };
    }
    return { ok: false, reason: "requirements-unmet" };
  }
  return { ok: false, reason: "max-rank" };
}

function takeApprentice(master, apprentice) {
  const s = ensure();
  if (guildRankOf(master) !== RANK_CHEFDECUISINE) return { ok: false, reason: "not-chefdecuisine" };
  const m = s.members[norm(apprentice)];
  if (!m || m.rank !== RANK_APPRENTICE || m.suspended) return { ok: false, reason: "not-eligible" };
  m.mentor = master;
  markDirty();
  return { ok: true };
}

// --- describe / persistence -----------------------------------------------------

/**
 * Fame deeds earned by a guild chef. Public API for the reputation system.
 * guildchef: won the golden ladle. recipethief: expelled for recipe theft.
 */
function deedsForChefdecuisine(username) {
  const s = ensure();
  const m = s.members[norm(username)];
  if (!m) return [];
  const out = [];
  // guildchef is awarded by the life tick when the ladle is granted; the
  // seal-holder records here let the reputation system verify independently.
  const seals = Object.values(s.seals).filter((x) => norm(x.holder) === norm(username));
  if (seals.length >= 5) out.push("guildchef");
  if (m.clean === false) out.push("recipethief");
  return out;
}

function describe(kingdomId) {  const s = ensure();
  const g = s.guilds[kingdomId];
  if (!g) return { exists: false };
  const members = Object.values(s.members).filter((m) => m.kingdomId === kingdomId && !m.suspended);
  return {
    exists: true,
    memberCount: members.length,
    chefdecuisines: members.filter((m) => m.rank === RANK_CHEFDECUISINE).length,
    sealed: Object.values(s.seals).filter((x) => x.kingdomId === kingdomId).length,
    treasury: g.treasury,
    hygieneFund: g.hygieneFund,
    hygiene: g.hygiene,
    prestige: g.prestige,
  };
}

const fs = require("fs");
const path = require("path");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", SAVE_KEY);

function setSaveFile(p) { SAVE_FILE = p; }

function save() {
  if (!dirty) return false;
  try {
    ensure();
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache, null, 2));
    dirty = false;
    return true;
  } catch { return false; }
}

function load() {
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      cache = Object.assign(blankState(), raw);
      dirty = false;
      return true;
    }
  } catch { /* corrupt save -> start fresh */ }
  return false;
}

function serialize() { ensure(); return JSON.parse(JSON.stringify(cache)); }
function deserialize(data) { cache = Object.assign(blankState(), data || {}); dirty = true; }
function resetForTests() { cache = blankState(); dirty = false; }

module.exports = {
  SAVE_KEY,
  COINS_ID,
  RANK_APPRENTICE,
  RANK_SOUSCHEF,
  RANK_CHEFDECUISINE,
  RANKS,
  DUES_WEEKLY,
  CERT_FEE,
  CERT_BOUNTY,
  LADLE_PRIZE,
  HYGIENE_AUDIT_THRESHOLD,
  CULINARY_CODE,
  ensureGuild,
  guildOf,
  guildTreasuryFor,
  hygieneFor,
  hallTileFor,
  isGuildMember,
  memberOf,
  memberNames,
  guildRankOf,
  isRealChef,
  joinGuild,
  leaveGuild,
  recordDuesPayment,
  recordMissedDues,
  gradeForQuality,
  realRecipeFor,
  sealFor,
  gradeFor,
  submitRecipe,
  settleCertification,
  retryOwedBounties,
  retryOwedLadle,
  inspectKitchens,
  scanRecipeTheft,
  reportTheft,
  voteCase,
  settleRipeCases,
  grantLadle,
  holdClass,
  tryPromote,
  takeApprentice,
  deedsForChefdecuisine,
  describe,
  save,
  load,
  setSaveFile,
  serialize,
  deserialize,
  resetForTests,
};
