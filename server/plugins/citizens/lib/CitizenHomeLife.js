"use strict";

/**
 * CitizenHomeLife — the dynamics of citizen housing (director tick).
 *
 * Data tier, zero LLM. Every decision below reads real state: the roster,
 * real coin pouches, the friendship graph, the journal. Nothing is
 * hash-derived.
 *
 * Per slow tick:
 *   1. Assignment — roster citizens without a home get one, sized by
 *      their real role (courtiers manors, merchants/guards houses,
 *      everyone else cottages). The record's spawn anchor (record.home)
 *      is pointed at the house tile, so citizens wake up and materialize
 *      at home. Sleep itself is the existing offline sleep window.
 *   2. Rent — once a day per home. Online owners pay rent + arrears from
 *      their real inventory (verified before/after). Offline or broke
 *      owners accrue debt; four unpaid days evicts, and the anchor
 *      falls back to the market tile.
 *   3. Furnishing — online owners with spare coins occasionally buy a
 *      carpenter-crafted furniture piece (real coin sink, comfort up).
 *   4. Gatherings — homeowners sometimes invite online friends over for
 *      a couple of hours (real guest list, announced out loud).
 *
 * Wiring: CitizenDirector.tick() calls tickHomes(director, nowMs).
 */

const Homes = require("./CitizenHomes");
const { bonds, isFriend, normalizeName } = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");

const COINS = 995; // ItemIds.COINS, verified in ItemIdentifiers.ts

// Per-tick probabilities (the director slow-ticks roughly every 60s).
const FURNISH_CHANCE = 0.03;
const GATHER_CHANCE = 0.02;
const FURNISH_MIN_COINS = 2000; // owners keep a buffer before decorating

const DAY_MS = 24 * 3600 * 1000;

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function recordOf(director, name) {
  return director?.roster?.get?.(normalizeName(name)) ?? null;
}

function botOf(director, record) {
  try {
    return director?.getBot ? director.getBot(record) : null;
  } catch {
    return null;
  }
}

function coinCount(bot) {
  try {
    return bot?.getInventory?.()?.getAmount?.(COINS) ?? 0;
  } catch {
    return 0;
  }
}

/** Remove coins for real; returns the amount actually removed. */
function takeCoins(bot, amount) {
  try {
    const inv = bot?.getInventory?.();
    if (!inv || typeof inv.deleted !== "function" || typeof inv.getAmount !== "function") return 0;
    const before = inv.getAmount(COINS) ?? 0;
    if (before < amount) return 0;
    inv.deleted(COINS, amount, true);
    const after = inv.getAmount(COINS) ?? before;
    return Math.max(0, before - after);
  } catch {
    return 0;
  }
}

function marketAnchor(director, kingdomId) {
  try {
    const { siteTileByKingdom } = require("../brain/CitizenSites");
    return siteTileByKingdom(kingdomId, "market") ?? { x: 3200, y: 3200, z: 0 };
  } catch {
    return { x: 3200, y: 3200, z: 0 };
  }
}

// --- 1. assignment ------------------------------------------------------------

function assignHomes(director, rng) {
  for (const record of director.roster.values()) {
    try {
      const name = record?.username;
      if (!name) continue;
      if (Homes.homeOf(name)) continue;
      const size = Homes.sizeForRole(record.role);
      const home = Homes.createHome(name, record.displayName ?? name, record.kingdomId, size);
      if (!home) continue;
      // Spawn at home: wake-ups and materialization use record.home.
      record.home = { x: home.tile.x, y: home.tile.y, z: home.tile.z ?? 0 };
      const label = Homes.HOUSE_SIZES[size].label;
      journalEvent(name, `Settled into a ${label} of my own.`, "social");
    } catch {
      // Non-fatal per citizen.
    }
  }
}

// --- 2. rent ------------------------------------------------------------------

function collectRent(director, nowMs, rng) {
  for (const home of Homes.allHomes()) {
    try {
      if (!Homes.rentDue(home, nowMs)) continue;
      const record = recordOf(director, home.owner);
      const bot = record ? botOf(director, record) : null;
      const amount = (home.rentPerDay ?? 50) + (home.rentDebt ?? 0);
      let paid = false;
      if (bot) {
        const removed = takeCoins(bot, amount);
        paid = removed >= amount;
      }
      if (paid) {
        Homes.recordRentPaid(home, nowMs);
        journalEvent(home.owner, `Paid ${amount} coins rent.`, "economy");
        Homes.recordActivity(home, `Rent paid (${amount} coins).`);
      } else {
        Homes.addRentDebt(home, nowMs);
        journalEvent(
          home.owner,
          bot
            ? `Couldn't make rent — ${home.rentDebt} coins owed now.`
            : `Rent went unpaid while I was away — ${home.rentDebt} coins owed.`,
          "economy"
        );
      }
      if (Homes.evictable(home)) {
        const ownerName = home.ownerDisplay ?? home.owner;
        Homes.removeHome(home.id, `unpaid rent (${home.rentDebt} coins)`);
        // Fall back to the market anchor so the citizen still spawns sanely.
        if (record) {
          const anchor = marketAnchor(director, record.kingdomId);
          record.home = { x: anchor.x, y: anchor.y, z: anchor.z ?? 0 };
        }
        const ownerBot = record ? botOf(director, record) : null;
        if (ownerBot) {
          sayPublic(ownerBot, `Lost my ${Homes.HOUSE_SIZES[home.size]?.label ?? "home"}... couldn't keep up with the rent.`);
        }
        journalEvent(home.owner ?? ownerName, "Evicted for unpaid rent.", "economy");
      }
    } catch {
      // Non-fatal per home.
    }
  }
}

// --- 3. furnishing ------------------------------------------------------------

function buyFurniture(director, nowMs, rng) {
  for (const home of Homes.allHomes()) {
    try {
      if (!chance(rng, FURNISH_CHANCE)) continue;
      const record = recordOf(director, home.owner);
      const bot = record ? botOf(director, record) : null;
      if (!bot) continue;
      const coins = coinCount(bot);
      if (coins < FURNISH_MIN_COINS) continue;
      const owned = new Set((home.furnishings ?? []).map((f) => f.key));
      const affordable = Homes.FURNITURE_CATALOG.filter((f) => !owned.has(f.key) && f.cost <= coins - 500);
      if (affordable.length === 0) continue;
      const rooms = Homes.HOUSE_SIZES[home.size]?.rooms ?? 1;
      if ((home.furnishings ?? []).length >= rooms * 2) continue;
      const piece = pickOne(rng, affordable);
      const removed = takeCoins(bot, piece.cost);
      if (removed < piece.cost) continue;
      Homes.addFurnishing(home.id, piece.key);
      journalEvent(home.owner, `Bought a ${piece.name} from the carpenter for ${piece.cost} coins.`, "economy");
      sayPublic(bot, `Just got a ${piece.name} for the place. It's coming together.`);
    } catch {
      // Non-fatal per home.
    }
  }
}

// --- 4. gatherings ------------------------------------------------------------

function hostGatherings(director, nowMs, rng) {
  for (const home of Homes.allHomes()) {
    try {
      if (!chance(rng, GATHER_CHANCE)) continue;
      const record = recordOf(director, home.owner);
      const bot = record ? botOf(director, record) : null;
      if (!bot) continue;
      // Invite online friends — real friendship graph, real guest list.
      const friends = [];
      try {
        for (const f of bonds(home.owner).friends ?? []) {
          if (friends.length >= 4) break;
          if (!isFriend(home.owner, f)) continue;
          const fr = recordOf(director, f);
          const fbot = fr ? botOf(director, fr) : null;
          if (fbot) friends.push(f);
        }
      } catch {
        // Non-fatal.
      }
      if (friends.length === 0) continue;
      for (const f of friends) Homes.inviteGuest(home.id, f, nowMs);
      const label = Homes.HOUSE_SIZES[home.size]?.label ?? "place";
      const names = friends.slice(0, 3).join(", ");
      sayPublic(bot, `Come by my ${label} tonight, ${names} — I'll put the kettle on.`);
      journalEvent(home.owner, `Hosted friends at home (${names}).`, "social");
      Homes.recordActivity(home, `Hosted a gathering (${names}).`);
    } catch {
      // Non-fatal per home.
    }
  }
}

// --- entry --------------------------------------------------------------------

function tickHomes(director, nowMs = Date.now()) {
  if (!director?.roster) return;
  const rng = agentRng(`homes:${nowMs >> 18}`);
  try {
    assignHomes(director, rng);
  } catch {
    // Non-fatal.
  }
  try {
    collectRent(director, nowMs, rng);
  } catch {
    // Non-fatal.
  }
  try {
    buyFurniture(director, nowMs, rng);
  } catch {
    // Non-fatal.
  }
  try {
    hostGatherings(director, nowMs, rng);
  } catch {
    // Non-fatal.
  }
}

module.exports = { tickHomes, COINS };
