"use strict";

/**
 * CitizenGalleriesLife — the slow tick for the gallery operations layer.
 *
 * What it does (all defensive, never throws):
 *   - Registers curators from the online roster: citizens in the curator
 *     career, or cultured/organized citizens who wander near a gallery.
 *   - Closes ripe auctions (endsAt passed): settles winners, refunds,
 *     house cuts → acquisition budgets. Big hammer prices are announced
 *     near real players via throttled sayPublic.
 *   - Accrues weekly kingdom stipends into gallery acquisition budgets.
 *   - Advances traveling exhibitions along their routes (real travel time);
 *     arrivals are announced near real players.
 *   - Curators acquire standout market pieces for the permanent collection
 *     when the budget allows (ambient, throttled per kingdom).
 *   - Prestige decays slowly without activity (galleries must stay alive).
 *
 * Complements CitizenArtLife (artwork creation, exhibitions, market expiry)
 * — this only runs the operations economics: auctions, acquisitions,
 * commissions, appraisals, tours, prestige.
 */

const Galleries = require("./CitizenGalleries");
const { agentRng } = require("./humanizer");
const { sayPublic } = require("../chat/CitizenSayPublic");

const STIPEND_CHECK_MS = 60 * 60 * 1000; // check stipends hourly
const AUCTION_CLOSE_MS = 5 * 60 * 1000; // close ripe auctions every 5 min
const TOUR_ADVANCE_MS = 30 * 60 * 1000; // advance tours every 30 min
const ACQUIRE_COOLDOWN_MS = 12 * 60 * 60 * 1000; // ambient acquisitions at most every 12h/kingdom
const ANNOUNCE_COOLDOWN_MS = 2 * 60 * 60 * 1000; // announcements at most every 2h/kingdom
const PRESTIGE_DECAY_DAYS = 30; // prestige decays after 30 idle days

const lastStipendCheck = new Map(); // kingdomId -> timestamp
const lastAuctionClose = new Map(); // "global" -> timestamp
const lastTourAdvance = new Map(); // "global" -> timestamp
const lastAcquire = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp

function cooled(map, key, ms, now) {
  const last = map.get(key) || 0;
  if (last > 0 && now - last < ms) return true;
  map.set(key, now);
  return false;
}

/** Test seam — clear cooldown memory. */
function resetForTests() {
  lastStipendCheck.clear();
  lastAuctionClose.clear();
  lastTourAdvance.clear();
  lastAcquire.clear();
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

function isOnline(record) {
  try {
    return record?.isOnline?.() ?? record?.online ?? true;
  } catch {
    return true;
  }
}

/** Citizens near real players (for announcements). */
function nearRealPlayers(record) {
  try {
    const { getLocalPlayers } = require("../brain/CitizenPerception");
    const locals = getLocalPlayers(record) ?? [];
    return locals.some((p) => {
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

/** Pay a username: online bot inventory, else bank credit. Returns boolean. */
function payUsername(director, username, amount) {
  try {
    const { normalizeName } = require("./CitizenBonds");
    const key = normalizeName(username);
    const record = director?.roster?.get?.(key);
    const bot = record && director?.isOnline?.(record) ? director.getBot?.(record) : null;
    if (bot) {
      const inv = bot.getInventory?.();
      if (inv && typeof inv.add === "function") {
        inv.add(995, amount);
        return true;
      }
    }
  } catch {
    // fall through to bank credit
  }
  return false;
}

/** Register curators from the online roster. */
function registerCurators(director, nowMs) {
  const roster = director?.roster;
  if (!roster) return;
  let list = [];
  try {
    list = [...roster.values()];
  } catch {
    return;
  }
  for (const record of list) {
    try {
      if (!isOnline(record)) continue;
      const username = usernameOf(record);
      if (!username || Galleries.isCurator(username)) continue;
      const career = careerOf(record);
      const p = personalityOf(record);
      const cultured = (p.culture ?? p.creativity ?? p.sophistication ?? 0) >= 0.6;
      const organized = (p.organization ?? p.conscientiousness ?? 0) >= 0.6;
      if (career === "curator" || (cultured && organized)) {
        const kid = kingdomIdOf(record);
        if (kid) Galleries.registerCurator(username, kid, nowMs);
      }
    } catch {
      // per-citizen safety
    }
  }
}

/** Close ripe auctions and announce notable sales. */
function closeRipeAuctions(director, nowMs) {
  if (cooled(lastAuctionClose, "global", AUCTION_CLOSE_MS, nowMs)) return;
  const ripe = Galleries.ripeAuctions(nowMs);
  for (const auction of ripe) {
    try {
      const res = Galleries.closeAuction(auction.id, (u, a) => payUsername(director, u, a), nowMs);
      if (res.ok && res.sold && res.hammerPrice >= 500) {
        // Notable sale — announce near real players.
        if (!cooled(lastAnnounce, auction.kingdomId, ANNOUNCE_COOLDOWN_MS, nowMs)) {
          const roster = director?.roster;
          let witness = null;
          try {
            for (const record of roster?.values?.() ?? []) {
              if (kingdomIdOf(record) === auction.kingdomId && nearRealPlayers(record)) {
                witness = record;
                break;
              }
            }
          } catch {
            // no witness
          }
          if (witness) {
            try {
              sayPublic(
                witness,
                `"${auction.title}" sold at auction for ${res.hammerPrice} coins!`
              );
            } catch {
              // speech is best-effort
            }
          }
        }
      }
      try {
        director?.journal?.("galleries", `auction closed: ${auction.title}`, {
          sold: res.sold,
          hammerPrice: res.hammerPrice ?? 0,
          kingdomId: auction.kingdomId,
        });
      } catch {
        // journaling is best-effort
      }
    } catch {
      // per-auction safety
    }
  }
}

/** Accrue stipends and decay idle prestige. */
function maintainGalleries(director, nowMs) {
  let kingdoms = [];
  try {
    const { KINGDOM_IDS } = require("../brain/CitizenSites");
    kingdoms = KINGDOM_IDS ?? [];
  } catch {
    return;
  }
  for (const kid of kingdoms) {
    try {
      if (cooled(lastStipendCheck, kid, STIPEND_CHECK_MS, nowMs)) continue;
      Galleries.accrueStipend(kid, nowMs);
      // Idle prestige decay: galleries that do nothing fade.
      const ops = Galleries.galleryOpsFor(kid, nowMs);
      const DAY = 24 * 60 * 60 * 1000;
      const idleMs = nowMs - (ops.lastActivityAt ?? ops.lastStipendAt ?? nowMs);
      if (idleMs > PRESTIGE_DECAY_DAYS * DAY && (ops.prestige ?? 10) > 10) {
        ops.prestige = Math.max(10, (ops.prestige ?? 10) - 1);
        Galleries.markDirty();
      }
    } catch {
      // per-kingdom safety
    }
  }
}

/** Advance traveling exhibitions; announce arrivals. */
function advanceTours(director, nowMs) {
  if (cooled(lastTourAdvance, "global", TOUR_ADVANCE_MS, nowMs)) return;
  const arrived = Galleries.advanceTours(nowMs);
  for (const tour of arrived) {
    try {
      if (tour.status === "showing") {
        const stopKingdom = tour.kingdomIds[tour.currentIdx];
        director?.journal?.("galleries", `tour arrived: ${tour.name}`, {
          kingdomId: stopKingdom,
          pieces: tour.pieces.length,
        });
      } else if (tour.status === "done") {
        director?.journal?.("galleries", `tour home: ${tour.name}`, {
          kingdomId: tour.homeKingdom,
        });
      }
    } catch {
      // journaling is best-effort
    }
  }
}

/**
 * Ambient acquisitions: curators with healthy budgets buy standout market
 * pieces for the permanent collection. Throttled per kingdom.
 */
function ambientAcquisitions(director, nowMs) {
  let Art;
  try {
    Art = require("./CitizenArt");
  } catch {
    return;
  }
  let kingdoms = [];
  try {
    const { KINGDOM_IDS } = require("../brain/CitizenSites");
    kingdoms = KINGDOM_IDS ?? [];
  } catch {
    return;
  }
  for (const kid of kingdoms) {
    try {
      if (cooled(lastAcquire, kid, ACQUIRE_COOLDOWN_MS, nowMs)) continue;
      const curs = Galleries.curatorsIn(kid);
      if (!curs.length) continue;
      const ops = Galleries.galleryOpsFor(kid, nowMs);
      if ((ops.budget ?? 0) < 300) continue; // keep a reserve

      // Find the best-value market listing in this kingdom.
      const listings = Art.marketListings(kid) ?? [];
      let best = null;
      let bestScore = 0;
      for (const listing of listings) {
        try {
          const quality = listing.quality ?? 50;
          const price = listing.price ?? 0;
          if (price <= 0 || price > ops.budget) continue;
          const score = quality / Math.max(1, price);
          if (score > bestScore) {
            bestScore = score;
            best = listing;
          }
        } catch {
          // per-listing safety
        }
      }
      if (best && bestScore > 0.05) {
        const res = Galleries.acquireForCollection(
          best.id ?? best.artworkId,
          curs[0].username,
          best.price,
          (u, a) => payUsername(director, u, a),
          nowMs
        );
        if (res.ok) {
          ops.lastActivityAt = nowMs;
          Galleries.markDirty();
          director?.journal?.("galleries", `acquired: ${best.title}`, {
            kingdomId: kid,
            price: best.price,
          });
        }
      }
    } catch {
      // per-kingdom safety
    }
  }
}

/** The slow tick entry point. Never throws. */
function tickGalleriesLife(director, nowMs = Date.now()) {
  try {
    registerCurators(director, nowMs);
  } catch {
    // registration is best-effort
  }
  try {
    closeRipeAuctions(director, nowMs);
  } catch {
    // auction closing is best-effort
  }
  try {
    maintainGalleries(director, nowMs);
  } catch {
    // maintenance is best-effort
  }
  try {
    advanceTours(director, nowMs);
  } catch {
    // tours are best-effort
  }
  try {
    ambientAcquisitions(director, nowMs);
  } catch {
    // acquisitions are best-effort
  }
}

module.exports = { tickGalleriesLife, resetForTests };
