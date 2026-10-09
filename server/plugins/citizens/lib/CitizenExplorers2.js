"use strict";

/**
 * CitizenExplorers2 — the frontier activity layer built on top of the
 * CitizenExplorers expedition simulation.
 *
 * WHAT IT DOES (data tier, free):
 *   Every citizen hashes into a frontier role — scout, pioneer, cartographer
 *   or naturalist. This is an ACTIVITY hobby, not a profession: anyone can
 *   take part, and nothing here joins the professional exclusion chain.
 *   Scouts run short recon trips on a per-kingdom cadence and journal route
 *   reports. Pioneers found persistent frontier settlements (camp -> hamlet
 *   -> village, growing every couple of days) at expedition discovery sites.
 *   Amateur cartographers sketch rough maps of new discoveries and sell them
 *   to players — explicitly NOT the professional CitizenCartographers, who
 *   instead get each discovery contributed to their master catalog via
 *   contributeDiscovery(). Naturalists journal field-note observations of
 *   wildlife discoveries. Players can FUND a mustering expedition: funded
 *   parties return with an extra discovery, and the sponsor is thanked by
 *   name. Everything is journaled, so the interaction-tier LLM reads truth.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Recon departure/return calls, settlement founding announcements, growth
 *   news, map hawking ("rough sketch of X, Y coins!"), sponsor thanks on
 *   funded returns, and naturalist field-note sharing — all scripted
 *   forceChat, chance-gated. Zero LLM.
 *
 * Wired into the director tick right after the CitizenExplorers block.
 * Plain-node testable: CitizenExplorers2.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { normalizeName } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");

const {
  hashName,
  isAway,
  finishedExpeditions,
  musteringExpeditions,
} = require("./CitizenExplorers");
const { contributeDiscovery } = require("./CitizenCartographers");

// === Tuning: all magic numbers here ===
const FRONTIER_ROLES = Object.freeze(["scout", "pioneer", "cartographer", "naturalist"]);
const SETTLEMENT_STAGES = Object.freeze(["camp", "hamlet", "village"]);
const RECON_CADENCE_MS = 6 * 60 * 60 * 1000; // one recon trip per kingdom this often
const RECON_BASE_MS = 60 * 60 * 1000; // abstracted scouting time
const RECON_JITTER_MS = 2 * 60 * 60 * 1000;
const SETTLE_CHANCE = 0.6; // a fresh discovery gets a settlement attempt this often
const SETTLE_STAGE_MS = 48 * 60 * 60 * 1000; // settlement grows a stage this often
const SKETCH_PRICE_MIN = 25; // coins
const SKETCH_PRICE_MAX = 75; // coins
// Fixed sketch price (documented abstraction): hash-derived per-sketch pricing
// was fabrication. A real stall/market price feed replaces this later.
const FUND_MIN = 100; // coins — minimum expedition sponsorship
const FUND_MAX = 100000; // coins — maximum expedition sponsorship
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000; // purchases + funding remembered this long
const SHOUT_RADIUS = 12; // tiles — earshot of calls and announcements
const HAWK_RADIUS = 14; // tiles — close enough to hear the map pitch
const SHOUT_COOLDOWN_MS = 30 * 60 * 1000; // per citizen per visible kind
const MAX_SETTLEMENTS = 200; // memory cap — oldest are forgotten (journals keep history)

const REGIONS = Object.freeze([
  "the northern hills",
  "the eastern marches",
  "the deep forest",
  "the western moors",
  "the southern coast",
  "the high passes",
]);

const RECON_REPORTS = Object.freeze([
  "a safe trail through {region}",
  "fresh water along {region}",
  "bandit sign near {region} — travel armed",
  "a ford across the river by {region}",
  "old ruins worth a look in {region}",
  "good hunting grounds past {region}",
]);

const FIELD_NOTES = Object.freeze([
  "nests at dawn and sings at dusk",
  "migrates with the moon's cycle",
  "fears running water but loves the rain",
  "hunts only the old and the slow",
  "remembers faces — approach with open hands",
  "sleeps through winter and wakes hungry",
]);

const RECON_DEPART_LINES = Object.freeze([
  "Scouting {region} — back by nightfall.",
  "Off to recon {region}. Keep the home fires lit.",
  "Taking a look past {region}. Won't be long.",
]);

const RECON_RETURN_LINES = Object.freeze([
  "Back from {region}. {report}.",
  "Recon done — {report}.",
]);

const SETTLE_FOUND_LINES = Object.freeze([
  "{name} is founded! A new {stage} at {site} — all are welcome.",
  "We've raised {name} at {site}. A {stage} for now, a town someday!",
  "The frontier grows: {name} stands at {site}. Come see it.",
]);

const SETTLE_GROW_LINES = Object.freeze([
  "Word from {name}: we've grown into a proper {stage}!",
  "{name} thrives — a real {stage} now. The wilds provide.",
]);

const MAP_HAWK_LINES = Object.freeze([
  "Rough sketch of {discovery} — only {price} coins! See what the wilds hide.",
  "Fresh off my desk: a sketch of {discovery}, {price} coins.",
  "Want to find {discovery}? My map shows the way — {price} coins.",
]);

const SPONSOR_LINES = Object.freeze([
  "{sponsor}, your coins carried us far — we found {discovery}!",
  "This one's for {sponsor}: {discovery}, found with your backing.",
  "Back richer thanks to {sponsor}. {discovery} is on the map now!",
]);

const FIELDNOTE_LINES = Object.freeze([
  "Field note: {creature} — {note}.",
  "Studied the {creature} up close. {note}, I swear it.",
  "For the curious: the {creature} {note}.",
]);

// === Frontier state (in-memory; the journals are the durable record) ===
const reconTrips = []; // { id, scout, kingdomId, region, returnsAt }
let nextReconId = 1;
const settlements = []; // { id, name, site, founder, kingdomId, stage, stageAt, foundedAt }
let nextSettlementId = 1;
const sketches = new Map(); // sketchKey -> { key, discovery, sketchedBy, price, at }
const purchases = new Map(); // normName -> [{ key, discovery, price, at }]
const funding = new Map(); // expeditionId -> { sponsor, amount, at, consumed, thanked }
const processedKeys = new Set(); // "expId:idx" — discovery already handled
const chartedKeys = new Set(); // discovery keys contributed to CitizenCartographers
const lastReconByKingdom = new Map(); // kingdomId -> timestamp
const lastShoutByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune stale entries hourly.
let lastPruneAt = 0;
function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastReconByKingdom) if (at < cutoff) lastReconByKingdom.delete(k);
  for (const [k, at] of lastShoutByCitizen) if (at < cutoff) lastShoutByCitizen.delete(k);
  const ledgerCutoff = nowMs - LEDGER_TTL_MS;
  for (const [k, list] of purchases) {
    const kept = list.filter((p) => p.at > ledgerCutoff);
    if (kept.length === 0) purchases.delete(k);
    else purchases.set(k, kept);
  }
  for (const [k, f] of funding) if (f.at < ledgerCutoff) funding.delete(k);
  for (let i = reconTrips.length - 1; i >= 0; i--) {
    if (reconTrips[i].returnsAt < cutoff) reconTrips.splice(i, 1);
  }
  // Cap settlements; the journals keep the full history.
  while (settlements.length > MAX_SETTLEMENTS) settlements.shift();
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** True only for real human players (not bots, not logged-out). */
function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch {
    return false;
  }
}

/** Cheap Chebyshev distance check (same plane). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch {
    return false;
  }
}

/**
 * Frontier role: a hobby lens, not a profession. Stable per username via a
 * dedicated hash domain — independent of the CitizenExplorers vocation, and
 * deliberately NOT part of the professional exclusion chain: any citizen
 * can take part.
 */
function frontierRoleFor(username) {
  return FRONTIER_ROLES[hashName(String(username ?? "") + "frontier") % FRONTIER_ROLES.length];
}

/** "a hidden grove" + "Bran" -> "Bran's Grove". Pure. */
function settlementNameFor(discoveryName, founderName) {
  const words = String(discoveryName ?? "").split(/[^A-Za-z]+/).filter(Boolean);
  const last = words.length > 0 ? words[words.length - 1] : "frontier";
  const cap = last.charAt(0).toUpperCase() + last.slice(1).toLowerCase();
  return `${founderName}'s ${cap}`;
}

/** Next settlement stage; villages stay villages. Pure. */
function nextStage(stage) {
  const i = SETTLEMENT_STAGES.indexOf(stage);
  if (i < 0) return SETTLEMENT_STAGES[0];
  return SETTLEMENT_STAGES[Math.min(i + 1, SETTLEMENT_STAGES.length - 1)];
}

/** Fixed sketch price in coins (documented abstraction — was hash-derived). Pure. */
function priceForSketch(sketchKey) {
  return 50;
}

/** "expId:discoveryIdx" — the idempotency key for a discovery. Pure. */
function discoveryKey(expeditionId, idx) {
  return `${expeditionId}:${idx}`;
}

/** Pure chance gate for founding a settlement at a discovery. */
function shouldFoundSettlement(rng) {
  return rng() < SETTLE_CHANCE;
}

/** Scripted recon report naming the region. Pure. */
function reconReport(region, rng) {
  return pickOne(rng, RECON_REPORTS).replace("{region}", region);
}

/** Scripted naturalist field-note line. Pure. */
function fieldNoteLine(creatureName, rng) {
  const note = pickOne(rng, FIELD_NOTES);
  return pickOne(rng, FIELDNOTE_LINES)
    .replace("{creature}", creatureName)
    .replace("{note}", note);
}

/** Build a settlement object (pure shape). */
function formSettlement({ founder, kingdomId, discovery, at }) {
  const site = String(discovery?.name ?? "the wilds");
  return {
    id: nextSettlementId++,
    name: settlementNameFor(site, founder),
    site,
    founder,
    kingdomId: kingdomId ?? "unknown",
    stage: SETTLEMENT_STAGES[0],
    stageAt: at,
    foundedAt: at,
  };
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "exploration", text);
  } catch {
    // Non-fatal.
  }
}

// ============================================================================
// Player hooks — fund expeditions, buy sketch maps.
// ============================================================================

/**
 * A real player sponsors a mustering expedition. Funded parties return with
 * one extra discovery (the bonus is consumed by CitizenExplorers at resolve
 * time). One sponsorship per expedition.
 * @returns {boolean} whether the funding was recorded
 */
function fundExpedition(playerName, expeditionId, amount, nowMs) {
  const at = nowMs ?? Date.now();
  if (!playerName || !expeditionId) return false;
  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt < FUND_MIN || amt > FUND_MAX) return false;
  let mustering = [];
  try {
    mustering = musteringExpeditions();
  } catch {
    return false;
  }
  const exp = mustering.find((e) => e.id === expeditionId);
  if (!exp) return false;
  if (funding.has(expeditionId)) return false;
  funding.set(expeditionId, {
    sponsor: String(playerName),
    amount: amt,
    at,
    consumed: false,
    thanked: false,
    leader: exp.leader,
  });
  journalEvent(
    playerName,
    `Sponsored ${exp.leader}'s ${exp.type} expedition with ${amt} coins.`,
    "exploration"
  );
  journalEvent(
    exp.leader,
    `${playerName} sponsored the expedition (${amt} coins).`,
    "exploration"
  );
  return true;
}

/**
 * Funding bonus for an expedition, consumed on read. Called by
 * CitizenExplorers.resolveJourney via lazy require (keeps load order acyclic).
 * @returns {number} 1 if this expedition was funded and unclaimed, else 0
 */
function fundingBonusFor(expeditionId) {
  const f = funding.get(expeditionId);
  if (!f || f.consumed) return 0;
  f.consumed = true;
  return 1;
}

/** Sketch maps currently for sale (newest first). */
function mapsForSale() {
  return [...sketches.values()].sort((a, b) => b.at - a.at);
}

/**
 * A real player buys an amateur sketch map of a discovery.
 * @returns {{ok: boolean, reason?: string, map?: object}}
 */
function buyMap(playerName, sketchKey, nowMs) {
  const at = nowMs ?? Date.now();
  if (!playerName) return { ok: false, reason: "no-player" };
  const sketch = sketches.get(sketchKey);
  if (!sketch) return { ok: false, reason: "no-such-map" };
  const name = normalizeName(playerName);
  const list = purchases.get(name) ?? [];
  if (list.some((p) => p.key === sketchKey)) {
    return { ok: false, reason: "already-owned" };
  }
  list.push({ key: sketchKey, discovery: sketch.discovery, price: sketch.price, at });
  purchases.set(name, list);
  journalEvent(
    playerName,
    `Bought ${sketch.sketchedBy}'s sketch map of ${sketch.discovery} for ${sketch.price} coins.`,
    "exploration"
  );
  journalEvent(
    sketch.sketchedBy,
    `Sold a sketch map of ${sketch.discovery} to ${playerName} for ${sketch.price} coins.`,
    "exploration"
  );
  return { ok: true, map: { ...sketch } };
}

/** Active map purchases for a player (7-day ledger). */
function purchasesFor(playerName, nowMs = Date.now()) {
  const list = purchases.get(normalizeName(playerName)) ?? [];
  return list.filter((p) => nowMs - p.at <= LEDGER_TTL_MS);
}

/** Funded expeditions, for introspection / interaction tier. */
function fundedExpeditions() {
  return [...funding.entries()].map(([id, f]) => ({ expeditionId: id, ...f }));
}

/** Settlements founded so far (introspection). */
function listSettlements() {
  return settlements.map((s) => ({ ...s }));
}

// ============================================================================
// The tick function — called from the director tick, after tickExplorers.
// Gate order: state changes (cheap) → visible output (only near real players).
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickExplorers2(director, nowMs) {
  pruneState(nowMs);
  try {
    const roster = [...(director.roster?.values?.() ?? [])];
    if (roster.length === 0) return;
    const events = [];
    formReconTrips(roster, nowMs, events);
    advanceReconTrips(nowMs, events);
    processFinishedExpeditions(roster, nowMs, events);
    advanceSettlementGrowth(nowMs, events);
    visibleMoments(director, events, nowMs);
  } catch (e) {
    console.warn("[citizen-explorers2] tick failed:", e?.message ?? e);
  }
}

function byKingdom(roster) {
  const map = new Map();
  for (const r of roster) {
    const k = r?.kingdomId ?? "unknown";
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

/** Citizens of a kingdom with a frontier role, not away on expedition. */
function roleHolders(members, role, nowMs) {
  return (members ?? [])
    .filter((r) => r?.username && frontierRoleFor(r.username) === role && !isAway(r.username, nowMs))
    .map((r) => r.username);
}

// --- Scout recon trips (data tier) ---

function formReconTrips(roster, nowMs, events) {
  for (const [kingdomId, members] of byKingdom(roster)) {
    const last = lastReconByKingdom.get(kingdomId) ?? 0;
    if (nowMs - last < RECON_CADENCE_MS) continue;
    if (reconTrips.some((t) => t.kingdomId === kingdomId)) continue;
    const scouts = roleHolders(members, "scout", nowMs);
    if (scouts.length === 0) continue;
    const rng = agentRng(`explorers2:recon:${kingdomId}:${nowMs >> 16}`);
    const scout = pickOne(rng, scouts);
    const region = pickOne(rng, REGIONS);
    const trip = {
      id: nextReconId++,
      scout,
      kingdomId,
      region,
      returnsAt: nowMs + RECON_BASE_MS + Math.floor(rng() * RECON_JITTER_MS),
    };
    reconTrips.push(trip);
    lastReconByKingdom.set(kingdomId, nowMs);
    journalEvent(scout, `Left on a recon trip to scout ${region}.`, "exploration");
    events.push({ kind: "recon_depart", actor: scout, trip });
  }
}

function advanceReconTrips(nowMs, events) {
  for (let i = reconTrips.length - 1; i >= 0; i--) {
    const trip = reconTrips[i];
    if (nowMs < trip.returnsAt) continue;
    reconTrips.splice(i, 1);
    const rng = agentRng(`explorers2:recon:${trip.id}:return`);
    const report = reconReport(trip.region, rng);
    journalEvent(trip.scout, `Returned from recon: ${report}.`, "exploration");
    events.push({ kind: "recon_return", actor: trip.scout, trip, report });
  }
}

// --- Settlements, sketches, field notes from finished expeditions ---

function processFinishedExpeditions(roster, nowMs, events) {
  let finished = [];
  try {
    finished = finishedExpeditions(nowMs);
  } catch {
    return;
  }
  if (finished.length === 0) return;
  const kingdoms = byKingdom(roster);

  for (const exp of finished) {
    // Sponsor thanks: funded expeditions get a named thank-you once.
    const fund = funding.get(exp.id);
    if (fund && !fund.thanked) {
      fund.thanked = true;
      const first = exp.discoveries[0]?.name ?? "new lands";
      journalEvent(
        fund.leader,
        `Returned from the expedition ${fund.sponsor} funded: discovered ${first}.`,
        "exploration"
      );
      events.push({ kind: "sponsor", actor: fund.leader, sponsor: fund.sponsor, discovery: first });
    }

    const members = kingdoms.get(exp.kingdomId) ?? [];
    const rng = agentRng(`explorers2:frontier:${exp.id}`);
    let settledThisExpedition = false;

    exp.discoveries.forEach((d, idx) => {
      const key = discoveryKey(exp.id, idx);
      if (processedKeys.has(key)) return;
      processedKeys.add(key);

      // Pioneer: found a settlement at the site (one per expedition).
      if (!settledThisExpedition && shouldFoundSettlement(rng)) {
        const pioneers = roleHolders(members, "pioneer", nowMs);
        if (pioneers.length > 0) {
          const founder = pickOne(rng, pioneers);
          const settlement = formSettlement({ founder, kingdomId: exp.kingdomId, discovery: d, at: nowMs });
          settlements.push(settlement);
          settledThisExpedition = true;
          journalEvent(
            founder,
            `Founded the settlement of ${settlement.name} at ${settlement.site}.`,
            "exploration"
          );
          events.push({ kind: "settlement_found", actor: founder, settlement });
        }
      }

      // Amateur cartographer: sketch a rough map for sale, and hand the
      // discovery to the professional CitizenCartographers' catalog.
      const sketchers = roleHolders(members, "cartographer", nowMs);
      const sketcher =
        sketchers.length > 0
          ? pickOne(rng, sketchers)
          : pickAnyCartographer(roster, rng, nowMs);
      if (sketcher && !sketches.has(key)) {
        const sketch = {
          key,
          discovery: d.name,
          sketchedBy: sketcher,
          price: priceForSketch(key),
          at: nowMs,
        };
        sketches.set(key, sketch);
        journalEvent(sketcher, `Sketched a rough map of ${d.name} (${sketch.price} coins).`, "exploration");
        events.push({ kind: "map_sketched", actor: sketcher, sketch });
      }
      if (!chartedKeys.has(key)) {
        chartedKeys.add(key);
        try {
          contributeDiscovery(sketcher ?? exp.leader, d.name, nowMs);
        } catch {
          // Cartographers are optional company.
        }
      }

      // Naturalist: journal a field-note observation of wildlife.
      if (d.type === "naturalist") {
        const naturalists = roleHolders(members, "naturalist", nowMs);
        if (naturalists.length > 0) {
          const observer = pickOne(rng, naturalists);
          const line = fieldNoteLine(d.name, rng);
          journalEvent(observer, line, "exploration");
          events.push({ kind: "field_note", actor: observer, line, discovery: d.name });
        }
      }
    });
  }
}

function pickAnyCartographer(roster, rng, nowMs) {
  const all = roleHolders(roster, "cartographer", nowMs);
  return all.length > 0 ? pickOne(rng, all) : null;
}

// --- Settlement growth (data tier) ---

function advanceSettlementGrowth(nowMs, events) {
  for (const s of settlements) {
    const next = nextStage(s.stage);
    if (next === s.stage) continue;
    if (nowMs - s.stageAt < SETTLE_STAGE_MS) continue;
    s.stage = next;
    s.stageAt = nowMs;
    journalEvent(s.founder, `${s.name} has grown into a ${next}.`, "exploration");
    events.push({ kind: "settlement_grow", actor: s.founder, settlement: { ...s } });
  }
}

// --- Visible moments: only when a real player is near the actor ---

function visibleMoments(director, events, nowMs) {
  for (const ev of events) {
    const last = lastShoutByCitizen.get(normalizeName(ev.actor)) ?? 0;
    if (nowMs - last < SHOUT_COOLDOWN_MS) continue;
    const rng = agentRng(`explorers2:shout:${ev.kind}:${ev.actor}:${nowMs >> 16}`);
    if (!chance(rng, 0.55)) continue;
    const bot = botFor(director, ev.actor);
    if (!bot) continue;
    let locals = [];
    try {
      locals = [...(bot.getLocalPlayers?.() ?? [])];
    } catch {
      continue;
    }
    const radius = ev.kind === "map_sketched" ? HAWK_RADIUS : SHOUT_RADIUS;
    if (!locals.some((p) => p !== bot && isRealPlayer(p) && withinTiles(bot, p, radius))) continue;
    const line = renderEventLine(ev, rng);
    if (!line) continue;
    try {
      { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [String(line).slice(0, 120)] })); }
    } catch {
      continue;
    }
    lastShoutByCitizen.set(normalizeName(ev.actor), nowMs);
  }
}

function renderEventLine(ev, rng) {
  const fill = (t) =>
    t
      .replace("{region}", ev.trip?.region ?? "")
      .replace("{report}", ev.report ?? "")
      .replace("{name}", ev.settlement?.name ?? "")
      .replace("{stage}", ev.settlement?.stage ?? "")
      .replace("{site}", ev.settlement?.site ?? "")
      .replace("{discovery}", ev.sketch?.discovery ?? ev.discovery ?? "")
      .replace("{price}", String(ev.sketch?.price ?? ""))
      .replace("{sponsor}", ev.sponsor ?? "");
  switch (ev.kind) {
    case "recon_depart":
      return fill(pickOne(rng, RECON_DEPART_LINES));
    case "recon_return":
      return fill(pickOne(rng, RECON_RETURN_LINES));
    case "settlement_found":
      return fill(pickOne(rng, SETTLE_FOUND_LINES));
    case "settlement_grow":
      return fill(pickOne(rng, SETTLE_GROW_LINES));
    case "map_sketched":
      return fill(pickOne(rng, MAP_HAWK_LINES));
    case "sponsor":
      return fill(pickOne(rng, SPONSOR_LINES));
    case "field_note":
      return ev.line;
    default:
      return null;
  }
}

function findRecord(director, username) {
  try {
    for (const record of director.roster?.values?.() ?? []) {
      if (record?.username === username) return record;
    }
  } catch {
    // ignore
  }
  return null;
}

function botFor(director, username) {
  const record = findRecord(director, username);
  return record ? director.getBot?.(record) : null;
}

/** Test seam: reset all module state. */
function resetForTests() {
  reconTrips.length = 0;
  settlements.length = 0;
  sketches.clear();
  purchases.clear();
  funding.clear();
  processedKeys.clear();
  chartedKeys.clear();
  lastReconByKingdom.clear();
  lastShoutByCitizen.clear();
  nextReconId = 1;
  nextSettlementId = 1;
}

module.exports = {
  tickExplorers2,
  // Pure helpers (tested):
  pickOne,
  isRealPlayer,
  withinTiles,
  frontierRoleFor,
  settlementNameFor,
  nextStage,
  priceForSketch,
  discoveryKey,
  shouldFoundSettlement,
  reconReport,
  fieldNoteLine,
  formSettlement,
  // Player hooks:
  fundExpedition,
  fundingBonusFor,
  mapsForSale,
  buyMap,
  purchasesFor,
  // Introspection:
  fundedExpeditions,
  listSettlements,
  resetForTests,
  FRONTIER_ROLES,
  SETTLEMENT_STAGES,
};
