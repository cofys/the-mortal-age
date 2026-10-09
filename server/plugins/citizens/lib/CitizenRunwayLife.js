"use strict";

/**
 * CitizenRunwayLife — the slow tick for the runway fashion-show layer.
 *
 * What it does (all defensive, never throws):
 *   - Registers designers from the online roster: citizens in the designer
 *     career, or expressive/creative citizens who wander near a runway with
 *     papyrus to spare. Models register from confident/sociable citizens.
 *   - Ambient collection drafting: registered designers sketch collections
 *     in slow rounds (1 real papyrus + real cloth per draft), throttled per
 *     kingdom.
 *   - House formation: designers band into named houses when a kingdom has
 *     enough unattached designers.
 *   - Ateliers: successful designers (2+ collections) open ateliers and
 *     stock their latest collection's pieces.
 *   - Fashion weeks: restless houses (wanderlust trait) book tours to other
 *     kingdoms; travel takes real time via CitizenRunways.tourTo/arriveHouse.
 *   - Show settlement: finished shows settle revenue splits and reviews;
 *     great premieres are announced near real players via throttled
 *     sayPublic. Model-purse coins go to the cast models' REAL inventories.
 *   - Upkeep: crown-owned runway venues decay honestly when upkeep lapses.
 *
 * Complements CitizenFashion (trends, clothing shops, style competitions)
 * and CitizenTheater (playhouses, plays, touring troupes) — this only runs
 * the runway production economics.
 */

const Runways = require("./CitizenRunways");
const { agentRng } = require("./humanizer");
const { sayPublic } = require("../chat/CitizenSayPublic");

const DRAFT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // ambient drafts at most every 4h/kingdom
const HOUSE_FORM_COOLDOWN_MS = 12 * 60 * 60 * 1000; // new houses at most every 12h/kingdom
const TOUR_COOLDOWN_MS = 24 * 60 * 60 * 1000; // tours at most daily per house
const ANNOUNCE_COOLDOWN_MS = 2 * 60 * 60 * 1000; // premieres announced at most every 2h/kingdom
const MIN_HOUSE_SIZE = 2;
const ATELIER_MIN_COLLECTIONS = 2;

const lastDraft = new Map(); // kingdomId -> timestamp
const lastHouseForm = new Map(); // kingdomId -> timestamp
const lastTour = new Map(); // houseNameLower -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp

function cooled(map, key, ms, now) {
  const last = map.get(key) || 0;
  if (last > 0 && now - last < ms) return true;
  map.set(key, now);
  return false;
}

/** Test seam — clear cooldown memory. */
function resetForTests() {
  lastDraft.clear();
  lastHouseForm.clear();
  lastTour.clear();
  lastAnnounce.clear();
}

function usernameOf(record) {
  try {
    return record?.getUsername?.() ?? record?.username ?? "";
  } catch {
    return "";
  }
}

function kingdomIdOf(record) {
  try {
    const { kingdomIdOf } = require("../brain/CitizenSites");
    return kingdomIdOf(record) || record.kingdomId || null;
  } catch {
    return record?.kingdomId || null;
  }
}

function personalityOf(record) {
  try {
    return record?.getAttribute?.("citizens:personality") ?? record?.personality ?? {};
  } catch {
    return {};
  }
}

function careerOf(record) {
  try {
    return record?.getAttribute?.("citizens:career") ?? record?.career ?? null;
  } catch {
    return null;
  }
}

function hasMaterials(record) {
  try {
    const inv = record?.getInventory?.();
    if (!inv) return false;
    const papyrus = inv.getAmount?.(Runways.PAPYRUS_ID) ?? inv.count?.(Runways.PAPYRUS_ID) ?? 0;
    return papyrus >= 1;
  } catch {
    return false;
  }
}

function nearRealPlayers(record) {
  try {
    const players = record?.getLocalPlayers?.() ?? [];
    return players.some((p) => {
      try {
        return p?.isRealPlayer?.() ?? !p?.isBot;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function tickRunwayLife(director, nowMs) {
  const now = nowMs || Date.now();
  let citizens = [];
  try {
    citizens = director?.citizensOnline?.() ?? [];
  } catch {
    citizens = [];
  }
  if (!Array.isArray(citizens) || !citizens.length) return;

  // land arrived tours first
  try {
    for (const h of Object.values(Runways.load().houses ?? {})) {
      try { Runways.arriveHouse(h); } catch { /* per-house safety */ }
    }
  } catch { /* no houses yet */ }

  const byKingdom = new Map();
  for (const c of citizens) {
    try {
      const kid = kingdomIdOf(c.record) || "unknown";
      if (!byKingdom.has(kid)) byKingdom.set(kid, []);
      byKingdom.get(kid).push(c);
    } catch { /* skip */ }
  }

  for (const [kingdomId, list] of byKingdom) {
    try {
      // ensure the venue exists
      Runways.ensureVenue(kingdomId);

      // register designers + models from the online roster
      for (const c of list) {
        try {
          const username = usernameOf(c.record);
          if (!username) continue;
          const career = String(careerOf(c.record) || "").toLowerCase();
          const pers = personalityOf(c.record);
          const expressive = Number(pers.expressiveness ?? pers.creativity ?? pers.sociability ?? 0);
          if (career === "designer" || (expressive >= 0.6 && hasMaterials(c.record))) {
            Runways.registerDesigner(username, kingdomId);
          }
          const confident = Number(pers.confidence ?? pers.sociability ?? 0);
          if (confident >= 0.6) {
            Runways.registerModel(username, kingdomId);
          }
        } catch { /* per-citizen safety */ }
      }

      // ambient collection drafting
      if (!cooled(lastDraft, kingdomId, DRAFT_COOLDOWN_MS, now)) {
        const designers = list
          .map((c) => usernameOf(c.record))
          .filter((u) => u && Runways.isDesigner(u) && hasMaterials(list.find((c) => usernameOf(c.record) === u)?.record));
        if (designers.length) {
          const rng = agentRng(`runway-draft:${kingdomId}:${Math.floor(now / DRAFT_COOLDOWN_MS)}`);
          const designer = designers[Math.floor(rng() * designers.length)];
          const rec = list.find((c) => usernameOf(c.record) === designer)?.record;
          if (rec) {
            const theme = Runways.THEMES[Math.floor(rng() * Runways.THEMES.length)];
            const res = Runways.createCollection(designer, theme, { payer: rec });
            if (res.ok && nearRealPlayers(rec)) {
              try {
                sayPublic(rec, `Just sketched a new line — "${res.collection.name}"!`);
              } catch { /* speech best-effort */ }
            }
          }
        }
      }

      // house formation
      if (!cooled(lastHouseForm, kingdomId, HOUSE_FORM_COOLDOWN_MS, now)) {
        const unattached = list
          .map((c) => usernameOf(c.record))
          .filter((u) => u && Runways.isDesigner(u) && !Runways.houseForDesigner(u));
        if (unattached.length >= MIN_HOUSE_SIZE) {
          const founder = unattached[0];
          const rng = agentRng(`runway-house:${kingdomId}:${Math.floor(now / HOUSE_FORM_COOLDOWN_MS)}`);
          const SUFFIXES = ["Atelier", "House", "Couture", "Modes"];
          const suffix = SUFFIXES[Math.floor(rng() * SUFFIXES.length)];
          const houseName = `${capName(founder)} ${suffix}`;
          const res = Runways.formHouse(founder, houseName);
          if (res.ok) {
            for (const u of unattached.slice(1, 4)) {
              try { Runways.joinHouse(u, houseName); } catch { /* skip */ }
            }
            const witness = list.find((c) => nearRealPlayers(c.record));
            if (witness) {
              try {
                sayPublic(witness.record, `Hear ye! ${res.house.name} opens its doors!`);
              } catch { /* best-effort */ }
            }
          }
        }
      }

      // ateliers for successful designers
      for (const c of list) {
        try {
          const username = usernameOf(c.record);
          if (!username) continue;
          const d = Runways.designerFor(username);
          if (d && (d.collectionsMade || 0) >= ATELIER_MIN_COLLECTIONS && !Runways.atelierFor(username)) {
            const res = Runways.openAtelier(username, kingdomId);
            if (res.ok) {
              const latest = Runways.collectionsIn(kingdomId)
                .filter((col) => String(col.designer).toLowerCase() === username.toLowerCase())
                .sort((a, b) => b.createdAt - a.createdAt)[0];
              if (latest) {
                try { Runways.stockAtelier(username, latest.id); } catch { /* skip */ }
              }
            }
          }
        } catch { /* per-citizen safety */ }
      }

      // fashion weeks: restless houses tour
      for (const house of Runways.housesIn(kingdomId)) {
        try {
          if (cooled(lastTour, house.nameLower, TOUR_COOLDOWN_MS, now)) continue;
          const loc = Runways.houseLocation(house);
          if (!loc || loc.traveling) continue;
          const founder = (Runways.load().designers ?? {})[String(house.founder || "").toLowerCase()];
          const wander = Number(founder ? 0.5 : 0); // houses tour steadily once established
          const rng = agentRng(`runway-tour:${house.nameLower}:${Math.floor(now / TOUR_COOLDOWN_MS)}`);
          if (rng() < 0.25 + wander * 0.2 && (house.collections?.length || 0) >= 1) {
            const { KINGDOM_IDS } = require("../brain/CitizenSites");
            const others = (KINGDOM_IDS || []).filter((k) => k !== loc.kingdomId);
            if (others.length) {
              const dest = others[Math.floor(rng() * others.length)];
              Runways.tourTo(house.name, dest);
            }
          }
        } catch { /* per-house safety */ }
      }

      // settle finished shows
      for (const show of Runways.finishedUnsettledShows(kingdomId)) {
        try {
          const res = Runways.settleShow(show.id);
          if (!res.ok) continue;
          // model-purse coins to the cast models' REAL inventories
          for (const u of res.review.pursePaid) {
            try {
              const rec = list.find((c) => usernameOf(c.record) === u)?.record;
              if (rec && res.splits.purseEach > 0) Runways.giveCoins(rec, res.splits.purseEach);
            } catch { /* per-model safety */ }
          }
          if (res.review.stars >= 4 && !cooled(lastAnnounce, kingdomId, ANNOUNCE_COOLDOWN_MS, now)) {
            const witness = list.find((c) => nearRealPlayers(c.record));
            if (witness) {
              try {
                sayPublic(
                  witness.record,
                  `${res.review.houseName}'s "${res.review.collectionName}" ${res.review.verdict}!`
                );
              } catch { /* best-effort */ }
            }
          }
        } catch { /* per-show safety */ }
      }

      // upkeep decay on crown venues
      const venue = Runways.venueFor(kingdomId);
      if (venue && venue.owner === "crown" && now > (venue.upkeepDueAt || 0)) {
        try { Runways.decayVenue(kingdomId); } catch { /* skip */ }
      }
    } catch { /* per-kingdom safety */ }
  }

  try { Runways.save(); } catch { /* save best-effort */ }
}

function capName(s) {
  const t = String(s || "");
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

module.exports = {
  tickRunwayLife,
  resetForTests,
};
