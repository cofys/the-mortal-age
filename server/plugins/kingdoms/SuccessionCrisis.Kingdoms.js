"use strict";

/**
 * SuccessionCrisis.Kingdoms — ruler lifecycle, succession crises, and civil wars (Phase 9).
 *
 * Every crown is mortal. Rulers age, abdicate, and die; when the throne falls
 * empty with no named heir, the court fractures into claimants and the
 * kingdom holds its breath. Players with standing in the court can throw
 * their influence behind a claimant. If no claimant commands the room, the
 * swords come out: civil war.
 *
 * HARD LORE BOUNDARY: Misthalin's heirless crown belongs to the Phase 10
 * questline (see Succession.Kingdoms.js). This module NEVER generates
 * claimants for Misthalin, NEVER kills or retires its ruler, and NEVER
 * touches the `misthalin:bastard-son-hidden` flag. The great rulers locked
 * by the world bible (Roald, Lathas, Lowerniel, Amik Varze, the Consortium)
 * do not die in ambient events either — Royals.Kingdoms honors the same list.
 *
 * Lifecycle (hourly council tick):
 *   1. Each non-exempt kingdom's ruler faces a small death chance that grows
 *      with reign length, plus a smaller abdication chance for long reigns.
 *   2. Death/abdication with a named heir (deathbed naming, or the
 *      `succession:designated-heir` flag) → smooth transition via the
 *      kingdom:ruler-changed event. No crisis.
 *   3. Otherwise → a succession crisis opens: 2-4 claimants drawn from the
 *      kingdom's real office holders, each with a claim type and strength.
 *   4. During the crisis (3 days) claimants campaign, foreign courts meddle,
 *      and players back their favorite with influence.
 *   5. Resolution: a claimant with >=60% of total strength is crowned
 *      peacefully. Otherwise the top two go to civil war (2 days of treasury
 *      drain and damage), and the stronger takes the crown.
 *
 * Claim types: bloodline (kin of the late ruler), appointment (named by the
 * regency council), election (chosen by the assembly of lords), conquest
 * (holds the loyalty of the guard). Strength is seeded from real records —
 * office seniority and the designated-heir flag — never from hashes.
 *
 * Citizens "choosing sides" is expressed at the aggregate level: claimant
 * support numbers drift with campaigning and meddling, and the module emits
 * kingdom:rumor lines so the streets talk about the split. No per-citizen
 * faction records are fabricated.
 *
 * All functions take the store (KingdomStore) and use the store.load() /
 * store.save() convention, so they test with mock stores. State lives on the
 * shared state object under `succession` — no second registry.
 *
 * Out (custom events):
 *   kingdom:ruler-changed { kingdomId, newRuler, newTitle?, flag?, flagValue? }
 *   kingdom:rumor { kingdomId, text }
 *   kingdom:royal-event { kingdomId, type: "coronation"|"death", text }
 */

const Influence = require("./Influence.Kingdoms");
const Offices = require("./Offices.Kingdoms");

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** ~60 minutes at 600ms/tick — thrones turn on the realm clock. */
const SUCCESSION_TASK_TICKS = 6000;

/** Claim types a claimant can hold. */
const CLAIM_TYPES = ["bloodline", "appointment", "election", "conquest"];
const CLAIM_LABELS = {
  bloodline: "Bloodline",
  appointment: "Council Appointment",
  election: "Assembly Election",
  conquest: "Right of Conquest",
};

/** Kingdoms (by id) this module never touches. The heirless crown is Phase 10. */
const EXEMPT_KINGDOM_IDS = ["misthalin"];
/** Ruler-name fragments locked by the world bible — ambient death never takes them. */
const EXEMPT_RULER_NAMES = ["Roald", "Lathas", "Lowerniel", "Amik Varze", "Consortium"];

/** Base per-tick death chance; grows with reign length. */
const DEATH_BASE_CHANCE = 0.0001;
/** Added per reign-day to the death chance. */
const DEATH_PER_DAY = 0.00001;
/** Death chance never exceeds this per tick. */
const DEATH_MAX_CHANCE = 0.003;
/** Abdication chance per tick once a reign passes the long-reign threshold. */
const ABDICATION_CHANCE = 0.0003;
/** Reign days before abdication becomes possible. */
const LONG_REIGN_DAYS = 60;
/** Chance a dying ruler names an heir on the deathbed (smooth, no crisis). */
const DEATHBED_HEIR_CHANCE = 0.35;
/** Chance an abdicating ruler names a successor (smooth, no crisis). */
const ABDICATION_HEIR_CHANCE = 0.7;

/** Ticks a crisis stays open before resolution (72 = ~3 days). */
const CRISIS_DURATION_TICKS = 72;
/** Share of total claimant strength that crowns peacefully. */
const PEACEFUL_CORONATION_SHARE = 0.6;
/** Ticks a civil war burns (48 = ~2 days). */
const CIVIL_WAR_TICKS = 48;
/** Treasury drained per civil-war tick (fraction). */
const CIVIL_WAR_TREASURY_DRAIN = 0.01;
/** Max treasury drained per civil-war tick (coins). */
const CIVIL_WAR_MAX_DRAIN = 500_000;

/** Personal influence a player spends to back a claimant. */
const BACK_CLAIMANT_INFLUENCE_COST = 30;
/** Strength a player's backing adds to a claimant. */
const PLAYER_BACKING_STRENGTH = 12;
/** Strength foreign meddling adds to a claimant. */
const FOREIGN_MEDDLING_STRENGTH = 8;

/** Flag (on kingdom.flags) naming a designated heir. */
const DESIGNATED_HEIR_FLAG = "succession:designated-heir";
/** Flag (on kingdom.flags) marking when the current reign began. */
const REIGN_SINCE_FLAG = "succession:reign-since";

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function successionOf(state) {
  if (!state.succession || typeof state.succession !== "object") {
    state.succession = { crises: [], civilWars: [], reigns: {} };
  }
  const s = state.succession;
  if (!Array.isArray(s.crises)) s.crises = [];
  if (!Array.isArray(s.civilWars)) s.civilWars = [];
  if (!s.reigns || typeof s.reigns !== "object") s.reigns = {};
  return s;
}

function isExempt(kingdom) {
  if (!kingdom) return true;
  if (EXEMPT_KINGDOM_IDS.includes(kingdom.id)) return true;
  const ruler = String(kingdom.ruler ?? "");
  return EXEMPT_RULER_NAMES.some((n) => ruler.includes(n));
}

function reignDays(kingdom, now) {
  const since = Number(kingdom.flags?.[REIGN_SINCE_FLAG]) || Number(kingdom.foundedAt) || now;
  return Math.max(0, (now - since) / (24 * 3600 * 1000));
}

function openCrisis(kingdomId, state) {
  return successionOf(state).crises.find((c) => c && c.kingdomId === kingdomId && c.status === "open") ?? null;
}

function openCivilWar(kingdomId, state) {
  return successionOf(state).civilWars.find((w) => w && w.kingdomId === kingdomId && w.status === "active") ?? null;
}

/** Public reader: is this kingdom mid-crisis? */
function inSuccessionCrisis(kingdomId, state) {
  return openCrisis(kingdomId, state) !== null;
}

/** Public reader: is this kingdom in civil war? (Wars/Siege gates can check this.) */
function inCivilWar(kingdomId, state) {
  return openCivilWar(kingdomId, state) !== null;
}

// ---------------------------------------------------------------------------
// Claimant generation — from real office holders, never hashes
// ---------------------------------------------------------------------------

/**
 * Build the claimant list for a crisis. Drawn from the kingdom's actual
 * office holders (most senior first), plus the designated heir when the
 * flag names one. Strength comes from office seniority and the heir flag.
 */
function generateClaimants(kingdom, store) {
  const claimants = [];
  const seen = new Set();
  let seq = 0;
  const mkId = () => `claimant-${Date.now().toString(36)}-${seq++}`;

  const designatedHeir = kingdom.flags?.[DESIGNATED_HEIR_FLAG];
  if (designatedHeir && typeof designatedHeir === "string" && designatedHeir.trim()) {
    const name = designatedHeir.trim();
    claimants.push({
      id: mkId(),
      name,
      title: "Designated Heir",
      claim: "bloodline",
      strength: 55,
      backers: [],
      aiSupport: 0,
    });
    seen.add(name.toLowerCase());
  }

  let offices = [];
  try {
    offices = Offices.getOffices(kingdom.id) ?? [];
  } catch {
    offices = [];
  }
  // Most senior offices first — the holders closest to power press claims.
  // holder.ref is the honest identity (username for players, office identity
  // for AI); holderName() adds an "AI " display prefix we don't want here.
  const holders = offices
    .map((o) => ({ office: o, holder: Offices.holderOf(o.id ?? o.officeId) }))
    .filter((h) => h.holder && typeof h.holder.ref === "string" && h.holder.ref.length > 0)
    .slice(0, 4);

  const claimByIndex = ["appointment", "election", "conquest", "appointment"];
  holders.forEach((h, i) => {
    const name = String(h.holder.ref);
    if (seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    if (claimants.length >= 4) return;
    claimants.push({
      id: mkId(),
      name: String(name),
      title: h.office?.title ?? h.office?.office ?? "Courtier",
      claim: claimByIndex[i % claimByIndex.length],
      // Seniority matters: earlier offices are closer to the throne.
      strength: Math.max(15, 40 - i * 7),
      backers: [],
      aiSupport: 0,
    });
  });

  return claimants;
}

// ---------------------------------------------------------------------------
// Crisis lifecycle (pure)
// ---------------------------------------------------------------------------

function openSuccessionCrisis(kingdom, store, rng = Math.random) {
  const state = store.load();
  const s = successionOf(state);
  if (openCrisis(kingdom.id, state) || openCivilWar(kingdom.id, state)) return null;

  const claimants = generateClaimants(kingdom, store);
  if (claimants.length < 2) return null;

  const now = Date.now();
  const crisis = {
    id: `crisis-${kingdom.id}-${now.toString(36)}`,
    kingdomId: kingdom.id,
    lateRuler: kingdom.ruler ?? "the late ruler",
    claimants,
    startedAt: now,
    ticksLeft: CRISIS_DURATION_TICKS,
    status: "open",
  };
  s.crises.push(crisis);
  store.save();
  return crisis;
}

function totalStrength(crisis) {
  return crisis.claimants.reduce((sum, c) => sum + (c.strength + (c.aiSupport ?? 0)), 0);
}

function crisisLeader(crisis) {
  const sorted = [...crisis.claimants].sort(
    (a, b) => b.strength + (b.aiSupport ?? 0) - (a.strength + (a.aiSupport ?? 0))
  );
  return sorted[0] ?? null;
}

/**
 * One hourly tick of an open crisis: claimants campaign (strength drifts),
 * foreign courts meddle, and the clock runs down. Returns events.
 */
function tickCrisis(crisis, store, rng = Math.random) {
  const events = [];
  const state = store.load();
  const kingdom = state.kingdoms?.[crisis.kingdomId];
  const kingdomName = kingdom?.name ?? crisis.kingdomId;

  // Campaigning: strength drifts as claimants feast, bribe, and speechify.
  for (const c of crisis.claimants) {
    c.strength = Math.max(5, Math.min(100, c.strength + (rng() * 6 - 3)));
  }

  // Foreign meddling: hostile neighbors back the weakest (chaos is cheap),
  // allies back the strongest (stability is profitable).
  try {
    const Relations = require("./Relations.Kingdoms");
    const others = Object.values(state.kingdoms ?? {}).filter((k) => k && k.id !== crisis.kingdomId);
    for (const other of others.slice(0, 3)) {
      if (rng() > 0.3) continue;
      const rel = Relations.relationOf(other.id, crisis.kingdomId, state);
      const sorted = [...crisis.claimants].sort((a, b) => a.strength - b.strength);
      const target = rel === "hostile" || rel === "at-war" ? sorted[0] : sorted[sorted.length - 1];
      if (!target) continue;
      target.aiSupport = (target.aiSupport ?? 0) + FOREIGN_MEDDLING_STRENGTH;
      events.push({
        type: "foreign-meddling",
        kingdomId: crisis.kingdomId,
        byId: other.id,
        claimantId: target.id,
        claimantName: target.name,
        text:
          `Whispers say ${other.name ?? other.id} gold is flowing to ` +
          `${target.name}'s cause in ${kingdomName}.`,
      });
    }
  } catch {
    // Relations unavailable in a bare test store: skip meddling.
  }

  crisis.ticksLeft -= 1;
  if (crisis.ticksLeft <= 0) {
    events.push(...resolveCrisis(crisis, store, rng));
  } else {
    store.save();
  }
  return events;
}

function resolveCrisis(crisis, store, rng = Math.random) {
  const events = [];
  const state = store.load();
  const kingdom = state.kingdoms?.[crisis.kingdomId];
  const kingdomName = kingdom?.name ?? crisis.kingdomId;

  const total = totalStrength(crisis);
  const leader = crisisLeader(crisis);
  const share = total > 0 && leader ? (leader.strength + (leader.aiSupport ?? 0)) / total : 0;

  if (leader && share >= PEACEFUL_CORONATION_SHARE) {
    // The court ratifies the clear favorite. No blood.
    crisis.status = "resolved";
    crisis.resolution = { type: "coronation", winnerId: leader.id, winnerName: leader.name };
    setReignStart(crisis.kingdomId, state);
    store.save();
    events.push({
      type: "ruler-changed",
      kingdomId: crisis.kingdomId,
      newRuler: leader.name,
      newTitle: leader.title && leader.title !== "Designated Heir" ? leader.title : kingdom?.rulerTitle ?? null,
      text:
        `[Realm] The court of ${kingdomName} has spoken: ${leader.name} ` +
        `takes the throne by ${CLAIM_LABELS[leader.claim] ?? leader.claim}. The succession is settled — for now.`,
    });
  } else {
    // No consensus. The top two settle it with swords.
    const sorted = [...crisis.claimants].sort(
      (a, b) => b.strength + (b.aiSupport ?? 0) - (a.strength + (a.aiSupport ?? 0))
    );
    const [a, b] = sorted;
    crisis.status = "civil-war";
    const s = successionOf(state);
    s.civilWars.push({
      id: `civilwar-${crisis.kingdomId}-${Date.now().toString(36)}`,
      kingdomId: crisis.kingdomId,
      sides: [
        { claimantId: a.id, name: a.name, title: a.title, strength: a.strength },
        { claimantId: b.id, name: b.name, title: b.title, strength: b.strength },
      ],
      startedAt: Date.now(),
      ticksLeft: CIVIL_WAR_TICKS,
      status: "active",
      drained: 0,
    });
    store.save();
    events.push({
      type: "civil-war-started",
      kingdomId: crisis.kingdomId,
      text:
        `[Realm] CIVIL WAR in ${kingdomName}! No claimant commands the court — ` +
        `${a.name} and ${b.name} have raised their banners. The realm holds its breath.`,
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Civil war ticks (pure)
// ---------------------------------------------------------------------------

function tickCivilWar(war, store, rng = Math.random) {
  const events = [];
  const state = store.load();
  const kingdom = state.kingdoms?.[war.kingdomId];
  const kingdomName = kingdom?.name ?? war.kingdomId;

  // The war burns coin: levies, bribes, burned granaries.
  const treasury = Number(kingdom?.treasury ?? 0);
  const drain = Math.min(Math.floor(treasury * CIVIL_WAR_TREASURY_DRAIN), CIVIL_WAR_MAX_DRAIN);
  if (drain > 0 && kingdom) {
    kingdom.treasury = treasury - drain;
    war.drained = (war.drained ?? 0) + drain;
  }

  // Fortunes of war: strength swings as battles are won and lost.
  for (const side of war.sides) {
    side.strength = Math.max(5, Math.min(100, side.strength + (rng() * 10 - 5)));
  }

  war.ticksLeft -= 1;
  if (war.ticksLeft <= 0) {
    const [a, b] = [...war.sides].sort((x, y) => y.strength - x.strength);
    const winner = a.strength === b.strength ? (rng() < 0.5 ? a : b) : a;
    const loser = winner === a ? b : a;
    war.status = "resolved";
    war.winnerId = winner.claimantId;
    war.winnerName = winner.name;
    setReignStart(war.kingdomId, state);
    store.save();
    events.push({
      type: "ruler-changed",
      kingdomId: war.kingdomId,
      newRuler: winner.name,
      newTitle: winner.title ?? null,
      text:
        `[Realm] The civil war in ${kingdomName} is over. ${winner.name} stands victorious ` +
        `over ${loser.name}'s broken banners and takes the throne. The realm counts its dead.`,
    });
    events.push({
      type: "civil-war-ended",
      kingdomId: war.kingdomId,
      winnerName: winner.name,
      drained: war.drained ?? 0,
    });
  } else {
    store.save();
  }
  return events;
}

// ---------------------------------------------------------------------------
// Ruler lifecycle (pure)
// ---------------------------------------------------------------------------

function setReignStart(kingdomId, state) {
  const kingdom = state.kingdoms?.[kingdomId];
  if (!kingdom) return;
  if (!kingdom.flags || typeof kingdom.flags !== "object") kingdom.flags = {};
  kingdom.flags[REIGN_SINCE_FLAG] = Date.now();
}

/**
 * Roll one ruler's fate for this tick. Returns events (possibly empty).
 * Exempt kingdoms and crisis/war kingdoms are skipped.
 */
function tickRuler(kingdom, store, rng = Math.random) {
  const events = [];
  const state = store.load();
  if (isExempt(kingdom)) return events;
  if (!kingdom.ruler) return events;
  if (openCrisis(kingdom.id, state) || openCivilWar(kingdom.id, state)) return events;

  const now = Date.now();
  const days = reignDays(kingdom, now);
  const deathChance = Math.min(DEATH_MAX_CHANCE, DEATH_BASE_CHANCE + days * DEATH_PER_DAY);

  if (rng() < deathChance) {
    const lateRuler = kingdom.ruler;
    // Deathbed naming: the old ruler settles it cleanly.
    if (rng() < DEATHBED_HEIR_CHANCE) {
      const heir = pickHeirName(kingdom, store, rng);
      setReignStart(kingdom.id, state);
      store.save();
      events.push({
        type: "ruler-changed",
        kingdomId: kingdom.id,
        newRuler: heir,
        newTitle: kingdom.rulerTitle ?? null,
        text:
          `[Realm] ${lateRuler} of ${kingdom.name ?? kingdom.id} has died. ` +
          `With their last breath they named ${heir} heir — the court mourns, and the crown passes in peace.`,
      });
    } else {
      events.push({
        type: "ruler-died",
        kingdomId: kingdom.id,
        lateRuler,
        text:
          `[Realm] ${lateRuler} of ${kingdom.name ?? kingdom.id} has died with no named heir. ` +
          `The court fractures — claimants are already gathering their supporters.`,
      });
      const crisis = openSuccessionCrisis(kingdom, store, rng);
      if (!crisis) {
        // Fewer than two claimants: the regency council holds the throne quietly.
        events.push({
          type: "regency",
          kingdomId: kingdom.id,
          text:
            `The regency council of ${kingdom.name ?? kingdom.id} holds the throne ` +
            `until a suitable heir can be found.`,
        });
      }
    }
    return events;
  }

  if (days > LONG_REIGN_DAYS && rng() < ABDICATION_CHANCE) {
    const oldRuler = kingdom.ruler;
    if (rng() < ABDICATION_HEIR_CHANCE) {
      const heir = pickHeirName(kingdom, store, rng);
      setReignStart(kingdom.id, state);
      store.save();
      events.push({
        type: "ruler-changed",
        kingdomId: kingdom.id,
        newRuler: heir,
        newTitle: kingdom.rulerTitle ?? null,
        text:
          `[Realm] ${oldRuler} of ${kingdom.name ?? kingdom.id} has abdicated after a long reign, ` +
          `naming ${heir} successor. The court celebrates the peaceful passing of the crown.`,
      });
    } else {
      const crisis = openSuccessionCrisis(kingdom, store, rng);
      events.push({
        type: "ruler-abdicated",
        kingdomId: kingdom.id,
        oldRuler,
        text:
          `[Realm] ${oldRuler} of ${kingdom.name ?? kingdom.id} has abdicated with no named successor. ` +
          `The throne stands empty — and the claimants are circling.`,
      });
      if (!crisis) {
        events.push({
          type: "regency",
          kingdomId: kingdom.id,
          text: `The regency council of ${kingdom.name ?? kingdom.id} holds the throne for now.`,
        });
      }
    }
  }
  return events;
}

/** A plausible heir name from the designated-heir flag or the senior office holder. */
function pickHeirName(kingdom, store, rng = Math.random) {
  const designated = kingdom.flags?.[DESIGNATED_HEIR_FLAG];
  if (designated && typeof designated === "string" && designated.trim()) return designated.trim();
  try {
    const offices = Offices.getOffices(kingdom.id) ?? [];
    for (const o of offices) {
      const holder = Offices.holderOf(o.id ?? o.officeId);
      if (holder && typeof holder.ref === "string" && holder.ref.length > 0) return holder.ref;
    }
  } catch {
    // Offices unavailable: fall through.
  }
  return `the Regent of ${kingdom.name ?? kingdom.id}`;
}

/**
 * The hourly council tick: ruler fates, open crises, active civil wars.
 * Pure — returns events; the attach wrapper persists/announces.
 */
function councilSuccessionTick(store, { rng = Math.random } = {}) {
  const events = [];
  const state = store.load();
  const kingdoms = Object.values(state.kingdoms ?? {});
  for (const kingdom of kingdoms) {
    if (!kingdom || !kingdom.id) continue;
    events.push(...tickRuler(kingdom, store, rng));
  }
  for (const crisis of successionOf(store.load()).crises) {
    if (crisis && crisis.status === "open") events.push(...tickCrisis(crisis, store, rng));
  }
  for (const war of successionOf(store.load()).civilWars) {
    if (war && war.status === "active") events.push(...tickCivilWar(war, store, rng));
  }
  return events;
}

// ---------------------------------------------------------------------------
// Player actions
// ---------------------------------------------------------------------------

/**
 * Back a claimant with personal influence. One claimant per player per crisis.
 * @returns {{ok: boolean, reason?: string, remaining?: number}}
 */
function backClaimant(player, kingdomId, claimantId, store) {
  if (!player?.setAttribute || !kingdomId || !claimantId) return { ok: false, reason: "bad-args" };
  const state = store.load();
  const crisis = openCrisis(kingdomId, state);
  if (!crisis) return { ok: false, reason: "no-crisis" };
  const claimant = crisis.claimants.find((c) => c.id === claimantId);
  if (!claimant) return { ok: false, reason: "no-claimant" };

  const playerName = player.username ?? player.name ?? "unknown";
  const already = crisis.claimants.find((c) =>
    (c.backers ?? []).some((b) => b.toLowerCase() === String(playerName).toLowerCase())
  );
  if (already) return { ok: false, reason: "already-backed" };

  const spent = Influence.spendInfluence(player, kingdomId, BACK_CLAIMANT_INFLUENCE_COST);
  if (!spent.ok) return { ok: false, reason: spent.reason ?? "insufficient" };

  claimant.backers = [...(claimant.backers ?? []), String(playerName)];
  claimant.strength = Math.min(100, claimant.strength + PLAYER_BACKING_STRENGTH);
  store.save();
  return { ok: true, remaining: spent.remaining };
}

/** A player-facing summary of the open crisis (or null). */
function crisisSummary(kingdomId, store) {
  const crisis = openCrisis(kingdomId, store.load());
  if (!crisis) return null;
  const total = totalStrength(crisis);
  return {
    id: crisis.id,
    kingdomId: crisis.kingdomId,
    lateRuler: crisis.lateRuler,
    ticksLeft: crisis.ticksLeft,
    claimants: crisis.claimants.map((c) => ({
      id: c.id,
      name: c.name,
      title: c.title,
      claim: c.claim,
      claimLabel: CLAIM_LABELS[c.claim] ?? c.claim,
      strength: Math.round(c.strength + (c.aiSupport ?? 0)),
      share: total > 0 ? Math.round(((c.strength + (c.aiSupport ?? 0)) / total) * 100) : 0,
      backers: (c.backers ?? []).length,
    })),
  };
}

/** A player-facing summary of the active civil war (or null). */
function civilWarSummary(kingdomId, store) {
  const war = openCivilWar(kingdomId, store.load());
  if (!war) return null;
  return {
    id: war.id,
    kingdomId: war.kingdomId,
    sides: war.sides.map((s) => ({ name: s.name, title: s.title, strength: Math.round(s.strength) })),
    ticksLeft: war.ticksLeft,
    drained: war.drained ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Task wiring
// ---------------------------------------------------------------------------

function attachSuccessionCrisis(api) {
  // Lazy: the Task class is TypeScript, only resolvable at server runtime.
  const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");

  const announceToRealm = (message) => {
    try {
      api.core.World.getPlayers().stream().filter(Boolean).forEach((p) => {
        try {
          p.sendMessage(message);
        } catch {
          // One deaf player doesn't silence the realm.
        }
      });
    } catch {
      // World not ready: nothing to announce to.
    }
  };

  const announceEvent = (e) => {
    try {
      if (e.type === "ruler-changed") {
        // Persist through the shared event so every listener fires exactly once.
        api.emitCustomEvent("kingdom:ruler-changed", {
          kingdomId: e.kingdomId,
          newRuler: e.newRuler,
          newTitle: e.newTitle ?? null,
        });
        announceToRealm(e.text);
        console.info("[succession-crisis] ruler changed", e.kingdomId, e.newRuler);
      } else if (e.type === "ruler-died" || e.type === "ruler-abdicated") {
        api.emitCustomEvent("kingdom:royal-event", {
          kingdomId: e.kingdomId,
          type: "death",
          text: e.text,
        });
        announceToRealm(e.text);
        console.info("[succession-crisis]", e.type, e.kingdomId);
      } else if (e.type === "civil-war-started" || e.type === "civil-war-ended") {
        announceToRealm(e.text);
        console.info("[succession-crisis]", e.type, e.kingdomId);
      } else if (e.type === "foreign-meddling" || e.type === "regency") {
        api.emitCustomEvent("kingdom:rumor", { kingdomId: e.kingdomId, text: e.text });
        console.info("[succession-crisis]", e.type, e.kingdomId);
      } else {
        console.info("[succession-crisis] event", e.type, e.kingdomId);
      }
    } catch (error) {
      console.warn("[succession-crisis] announce failed", error?.message ?? error);
    }
  };

  class SuccessionCrisisTask extends Task {
    execute() {
      try {
        const Store = require("./KingdomStore");
        const events = councilSuccessionTick(Store);
        for (const e of events) announceEvent(e);
      } catch (error) {
        console.warn("[succession-crisis] council tick failed", error?.message ?? error);
      }
    }
  }
  api.getTaskManager()?.submit(new SuccessionCrisisTask(SUCCESSION_TASK_TICKS));
  console.info("[succession-crisis] succession council armed", { tickTicks: SUCCESSION_TASK_TICKS });
}

module.exports = attachSuccessionCrisis;
module.exports.attachSuccessionCrisis = attachSuccessionCrisis;
module.exports.councilSuccessionTick = councilSuccessionTick;
module.exports.openSuccessionCrisis = openSuccessionCrisis;
module.exports.backClaimant = backClaimant;
module.exports.crisisSummary = crisisSummary;
module.exports.civilWarSummary = civilWarSummary;
module.exports.inSuccessionCrisis = inSuccessionCrisis;
module.exports.inCivilWar = inCivilWar;
module.exports.CLAIM_TYPES = CLAIM_TYPES;
module.exports.CLAIM_LABELS = CLAIM_LABELS;
module.exports.BACK_CLAIMANT_INFLUENCE_COST = BACK_CLAIMANT_INFLUENCE_COST;
module.exports.CRISIS_DURATION_TICKS = CRISIS_DURATION_TICKS;
module.exports.CIVIL_WAR_TICKS = CIVIL_WAR_TICKS;
