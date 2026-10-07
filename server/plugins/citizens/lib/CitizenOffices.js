"use strict";

/**
 * CitizenOffices — AI citizens HOLD the kingdom offices.
 *
 * The kingdoms plugin defines the four standard offices (quartermaster,
 * marshal, spymaster, steward) and seeds them held by AI identities from
 * day one — but until now no living citizen ever stood behind those
 * identities. The holder was data with nobody home: no ceremony, no duties,
 * no one for players to talk to. This module closes that loop and makes the
 * interchangeability real:
 *
 *   BINDING:  Every AI-held office gets bound to a living citizen of the
 *              same kingdom, picked by fit — guards lean marshal, merchants
 *              lean quartermaster/steward, courtiers steward, shady social
 *              types spymaster. A binding is one citizen per office and one
 *              office per citizen, persisted to data/saves/citizen-offices.json.
 *   VACANCY:  When an office is vacated (kingdom:office-vacated) the binding
 *              releases; when the realm calls kingdom:office-seeks-holder
 *              the director answers by seating a citizen and the plugin
 *              emits kingdom:office-assigned with holder { kind: "ai",
 *              ref: <officeId> } — the exact contract Politics.Kingdoms
 *              already expects for AI holders (challenges, trials, court
 *              decisions all work against the seated citizen's tenure).
 *   DUTIES:   Office-holders do their jobs, roughly once a day, data tier:
 *              the Marshal holds a garrison muster, the Quartermaster posts
 *              supply orders at the market, the Steward reads the ledger,
 *              the Spymaster leaks rumors. Visible via forceChat where real
 *              players are near, journaled for the LLM mouth everywhere.
 *   CONTEXT:  exports officesOfKingdom()/officeOfCitizen() so chat context
 *              knows "the Quartermaster is Aeliana" and office-holders know
 *              their own seals.
 *
 * Two-tier as always: everything runs on the director tick as pure data
 * (zero LLM). Ceremonies are announced where players can actually see them;
 * gossip carries the news where they can't.
 */

const fs = require("fs");
const path = require("path");
const { agentRng, chance } = require("./humanizer");
const { normalizeName } = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");
const { getMemory } = require("./CitizenMemory");
const { GOSSIP_OFFICE } = require("../constants");

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-offices.json");

// --- fit weighting per office ----------------------------------------------
// roleWeights: base pull of a citizen role. merchantKindBonus: the three
// merchant specializations. traitBonus: personality traits that fit the job.
const OFFICE_FIT = Object.freeze({
  quartermaster: {
    roleWeights: { merchant: 6, courtier: 2, commoner: 2 },
    merchantKindBonus: { supplier: 4, provisioner: 4, prime: 2 },
    traitBonus: { methodical: 2, dutiful: 2, greedy: 1 },
  },
  marshal: {
    roleWeights: { guard: 8, commoner: 1 },
    merchantKindBonus: {},
    traitBonus: { dutiful: 2, gruff: 2, proud: 1 },
  },
  steward: {
    roleWeights: { courtier: 5, merchant: 4, commoner: 2 },
    merchantKindBonus: { prime: 2 },
    traitBonus: { methodical: 2, dutiful: 2, devout: 1 },
  },
  spymaster: {
    roleWeights: { courtier: 3, commoner: 2, merchant: 2, guard: 1 },
    merchantKindBonus: {},
    traitBonus: { suspicious: 3, taciturn: 2, chatty: 1 },
  },
});

const BIND_SWEEP_MS = 10 * 60 * 1000; // re-scan for unbound offices every 10 min
const DUTY_MIN_MS = 20 * 3600 * 1000; // each office performs a duty ~daily
const DUTY_CHANCE = 0.12; // per tick when due (tick ~= 60s)
const DUTY_HOUR_MIN = 7; // duties happen during the working day
const DUTY_HOUR_MAX = 21;

let bindings = {}; // officeId -> { citizenName, kingdomId, office, title, boundAtMs, lastDutyMs }
let lastBindSweepMs = 0;
let loaded = false;

// --- persistence ------------------------------------------------------------

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data.bindings === "object") bindings = data.bindings;
  } catch {
    bindings = {};
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify({ bindings }, null, 2));
  } catch {
    // Non-fatal: bindings live on in memory for this run.
  }
}

// --- lazy requires (avoid boot-order cycles) ---------------------------------

function getOfficesRegistry() {
  try {
    return require("../../kingdoms/Offices.Kingdoms");
  } catch {
    return null;
  }
}

function kingdomName(kingdomId) {
  try {
    const store = require("../../kingdoms/KingdomStore");
    return store.getKingdom?.(kingdomId)?.name ?? kingdomId;
  } catch {
    return kingdomId;
  }
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

function seedOfficeGossip(kingdomId, citizenName, text) {
  try {
    getMemory().seedGossip({
      kingdomId,
      kind: GOSSIP_OFFICE,
      subject: citizenName,
      text,
      holder: kingdomGossipHolder(kingdomId),
    });
  } catch {
    // Non-fatal.
  }
}

// Deterministic-ish gossip holder seed per kingdom so office news spreads.
function kingdomGossipHolder(kingdomId) {
  let h = 0;
  const s = String(kingdomId ?? "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `office-herald-${h.toString(36)}`;
}

/** Real (non-bot) players in the bot's local view. */
function realPlayersNear(bot) {
  const out = [];
  try {
    for (const p of bot?.getLocalPlayers?.() ?? []) {
      if (p !== bot && p?.isPlayerBot?.() !== true) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

function shoutIfSeen(director, citizenName, line) {
  try {
    const record = director?.roster?.get?.(normalizeName(citizenName));
    const bot = record ? director.getBot?.(record) : null;
    if (!bot) return false;
    if (realPlayersNear(bot).length === 0) return false;
    bot.forceChat?.(line);
    return true;
  } catch {
    return false;
  }
}

// --- candidate selection ------------------------------------------------------

function boundCitizenNames() {
  const out = new Set();
  for (const b of Object.values(bindings)) {
    if (b?.citizenName) out.add(normalizeName(b.citizenName));
  }
  return out;
}

function fitWeight(record, office) {
  const spec = OFFICE_FIT[office];
  if (!spec) return 0;
  let w = spec.roleWeights[record.role] ?? 0.5;
  if (record.merchantKind && spec.merchantKindBonus[record.merchantKind]) {
    w += spec.merchantKindBonus[record.merchantKind];
  }
  const traits = record.personality?.traits ?? [];
  for (const t of traits) {
    if (spec.traitBonus[t]) w += spec.traitBonus[t];
  }
  return Math.max(w, 0.1);
}

/** Pick the best-fit citizen of a kingdom for an office. Weighted random. */
function pickCandidate(director, kingdomId, office) {
  const taken = boundCitizenNames();
  const rng = agentRng(`office:${office}:${kingdomId}:${Date.now() >> 12}`);
  const candidates = [];
  for (const record of director?.roster?.values?.() ?? []) {
    if (record?.kingdomId !== kingdomId) continue;
    if (record?.role === "refugee") continue;
    if (taken.has(normalizeName(record.username))) continue;
    candidates.push({ record, weight: fitWeight(record, office) });
  }
  if (candidates.length === 0) return null;
  let total = 0;
  for (const c of candidates) total += c.weight;
  let roll = rng() * total;
  for (const c of candidates) {
    roll -= c.weight;
    if (roll <= 0) return c.record;
  }
  return candidates[candidates.length - 1].record;
}

// --- binding -------------------------------------------------------------------

function liveBinding(officeId, director) {
  const b = bindings[officeId];
  if (!b?.citizenName) return null;
  const record = director?.roster?.get?.(normalizeName(b.citizenName));
  if (!record) return null; // citizen left the realm (died, reset)
  return b;
}

/**
 * Seat a citizen in an office. Returns the binding, or null when no
 * candidate exists. Emits no events itself — the caller answers seeks-holder.
 */
function bindCitizen(director, officeId, kingdomId, office, title, { quiet = false } = {}) {
  load();
  const existing = liveBinding(officeId, director);
  if (existing) return existing;
  const record = pickCandidate(director, kingdomId, office);
  if (!record) return null;
  const binding = {
    citizenName: record.username,
    kingdomId,
    office,
    title: title ?? office.charAt(0).toUpperCase() + office.slice(1),
    boundAtMs: Date.now(),
    lastDutyMs: 0,
  };
  bindings[officeId] = binding;
  save();
  if (!quiet) announceSeating(director, binding);
  return binding;
}

/** Herald the appointment: journal, gossip, and a shout where players see. */
function announceSeating(director, binding) {
  const { citizenName, kingdomId, title } = binding;
  const kName = kingdomName(kingdomId);
  journalEvent(citizenName, `Sworn in as the ${title} of ${kName}.`, "office");
  seedOfficeGossip(kingdomId, citizenName, `took the ${title} of ${kName}!`);
  try {
    director?.api?.emitCustomEvent?.("kingdom:rumor", {
      kingdomId,
      text: `Did you hear? ${citizenName} took the ${title} of ${kName}!`,
    });
  } catch {
    // Non-fatal.
  }
  shoutIfSeen(
    director,
    citizenName,
    `Hear ye! ${citizenName} takes the seals of the ${title} of ${kName}!`
  );
}

/** Release a citizen from an office. The office record itself is untouched. */
function unbindOffice(officeId) {
  load();
  if (bindings[officeId]) {
    delete bindings[officeId];
    save();
  }
}

/**
 * Answer kingdom:office-seeks-holder. Seats a citizen in the vacant office
 * and returns the binding (or null when nobody in the kingdom can serve).
 */
function fillVacancy(director, { officeId, kingdomId, title }) {
  load();
  if (!officeId || !kingdomId) return null;
  const office = String(officeId).split(":").pop();
  // Drop stale bindings first so the seat is genuinely free.
  unbindOffice(officeId);
  return bindCitizen(director, officeId, kingdomId, office, title);
}

/**
 * Slow sweep: bind living citizens to every AI-held office that has no live
 * binding (the seeded day-one state, offices vacated while the server was
 * down, bindings whose citizens left the realm).
 */
function bindOffices(director) {
  load();
  const now = Date.now();
  if (now - lastBindSweepMs < BIND_SWEEP_MS) return;
  lastBindSweepMs = now;
  const registry = getOfficesRegistry();
  if (!registry?.getOffices) return;
  let offices = [];
  try {
    offices = registry.getOffices() ?? [];
  } catch {
    return;
  }
  for (const officeRec of offices) {
    if (officeRec?.holder?.kind !== "ai") continue; // player holds the seals
    const officeId = officeRec.officeId;
    if (liveBinding(officeId, director)) continue;
    // Stale binding with no living citizen: drop it, seat someone new.
    if (bindings[officeId]) unbindOffice(officeId);
    bindCitizen(director, officeId, officeRec.kingdomId, officeRec.office, officeRec.title, {
      quiet: true,
    });
  }
}

// --- duties ---------------------------------------------------------------------

/** Line templates per office, with a {k} (kingdom) and {n} (name) slot. */
const DUTIES = Object.freeze({
  quartermaster: [
    {
      journal: "Posted a supply order for the garrison: swords, shields, and rations — good coin paid.",
      shout: "The Quartermaster needs blades and rations for the garrison! Bring goods to the market — coin paid!",
      gossip: "is buying swords and rations for the garrison — coin paid at the market!",
    },
    {
      journal: "Took stock of the war chest and paid the garrison their wages.",
      shout: "Garrison wages are paid! The Quartermaster keeps the realm armed and fed!",
      gossip: "paid the garrison's wages and took stock of the war chest.",
    },
  ],
  marshal: [
    {
      journal: "Held a garrison muster at the square — inspected arms and drilled the watch.",
      shout: "Garrison, muster! Line up at the square — arms inspection!",
      gossip: "held a garrison muster at the square and drilled the watch.",
    },
    {
      journal: "Walked the walls with the watch captains and doubled the night patrols.",
      shout: "The Marshal doubles the night patrols — keep your blades sharp!",
      gossip: "doubled the night patrols and walked the walls.",
    },
  ],
  steward: [
    {
      journal: "Read the realm's ledger at court: taxes in, wages out, treasury balanced.",
      shout: "The Steward reads the ledger — taxes due by week's end, and the treasury stands!",
      gossip: "read the realm's ledger at court — taxes in, wages out.",
    },
    {
      journal: "Audited the market tolls and found the books short — doubled the toll watch.",
      shout: "The Steward has doubled the toll watch — pay your dues honestly!",
      gossip: "audited the market tolls and doubled the toll watch.",
    },
  ],
  spymaster: [
    {
      journal: "Passed a sealed note to a courier bound for the border — the realm's eyes stay open.",
      rumor: "Word from the shadows: the Spymaster's couriers ride for the border again.",
      gossip: "was seen passing sealed notes to border couriers.",
    },
    {
      journal: "Heard whispers of foreign agents in the taverns — the informants are paid double this week.",
      rumor: "They say the Spymaster is paying double for whispers of foreign agents in the taverns.",
      gossip: "is paying double for whispers of foreign agents.",
    },
  ],
});

function performDuty(director, officeId, binding) {
  const { citizenName, kingdomId, office, title } = binding;
  const rng = agentRng(`officeduty:${officeId}:${Date.now() >> 16}`);
  const lines = DUTIES[office];
  if (!lines || lines.length === 0) return;
  const line = lines[Math.floor(rng() * lines.length)];
  const kName = kingdomName(kingdomId);
  const fill = (s) => String(s ?? "").replaceAll("{k}", kName).replaceAll("{n}", citizenName);

  if (line.journal) journalEvent(citizenName, `${fill(line.journal)}`, "office");
  if (line.shout) {
    const seen = shoutIfSeen(director, citizenName, fill(line.shout));
    if (!seen) seedOfficeGossip(kingdomId, citizenName, `the ${title} ${fill(line.gossip ?? line.shout)}`);
    else if (line.gossip) seedOfficeGossip(kingdomId, citizenName, `the ${title} ${fill(line.gossip)}`);
  } else if (line.rumor) {
    try {
      director?.api?.emitCustomEvent?.("kingdom:rumor", { kingdomId, text: fill(line.rumor) });
    } catch {
      // Non-fatal.
    }
    if (line.gossip) seedOfficeGossip(kingdomId, citizenName, `the ${title} ${fill(line.gossip)}`);
  }
  binding.lastDutyMs = Date.now();
  save();
}

/**
 * Director tick: sweep unbound offices, then let each office-holder perform
 * a duty roughly once a day during working hours.
 */
function tickOffices(director, hour) {
  load();
  bindOffices(director);
  const now = Date.now();
  for (const [officeId, binding] of Object.entries(bindings)) {
    if (!liveBinding(officeId, director)) {
      // Citizen left the realm: clear; the sweep seats a successor.
      unbindOffice(officeId);
      continue;
    }
    if (now - (binding.lastDutyMs ?? 0) < DUTY_MIN_MS) continue;
    if (hour < DUTY_HOUR_MIN || hour > DUTY_HOUR_MAX) continue;
    const dutyRng = agentRng(`officedutyroll:${officeId}:${now >> 16}`);
    if (!chance(dutyRng, DUTY_CHANCE)) continue;
    try {
      performDuty(director, officeId, binding);
    } catch {
      // Non-fatal: one office's duty never kills the tick.
    }
  }
}

// --- chat context ---------------------------------------------------------------

/**
 * Offices held in a kingdom: [{ office, title, citizenName }]. For chat
 * context — "the Quartermaster is Aeliana".
 */
function officesOfKingdom(kingdomId) {
  load();
  const out = [];
  for (const [officeId, b] of Object.entries(bindings)) {
    if (b?.kingdomId === kingdomId && b.citizenName) {
      out.push({ officeId, office: b.office, title: b.title, citizenName: b.citizenName });
    }
  }
  return out;
}

/** The office a citizen holds, or null. */
function officeOfCitizen(citizenName) {
  load();
  const norm = normalizeName(citizenName);
  for (const [officeId, b] of Object.entries(bindings)) {
    if (b?.citizenName && normalizeName(b.citizenName) === norm) {
      return { officeId, ...b };
    }
  }
  return null;
}

module.exports = {
  bindCitizen,
  bindOffices,
  fillVacancy,
  unbindOffice,
  getBinding: (officeId) => {
    load();
    return bindings[officeId] ?? null;
  },
  officesOfKingdom,
  officeOfCitizen,
  tickOffices,
  // Test seam.
  _resetForTests: () => {
    bindings = {};
    lastBindSweepMs = 0;
    loaded = false;
    try {
      fs.unlinkSync(SAVE_FILE);
    } catch {
      // Never existed; fine.
    }
  },
  _bindings: () => bindings,
};
