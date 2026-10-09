"use strict";

/**
 * CitizenArtLife — slow-tick dynamics for citizen art and culture.
 *
 * WHAT IT DOES (runs in the director's slow tick, never throws):
 *   - Exhibition scheduling: when a kingdom's gallery has enough
 *     unexhibited works and the cooldown has passed, hosts an exhibition
 *     and announces it via sayPublic near real players.
 *   - Market expiry: removes stale art listings.
 *   - Artist inspiration: creative citizens with materials produce art
 *     over time (the slow, ambient path — the brain action is the
 *     active path).
 *   - Masterpiece announcements: when a citizen creates a masterpiece
 *     (quality 85+), it's journaled and announced.
 *
 * WHAT IT DOES NOT DO:
 *   - No LLM. Announcements are template + journal facts.
 *   - No invented art. Everything flows through CitizenArt.
 *   - Never throws — one bad citizen never breaks the tick.
 */

const Art = require("./CitizenArt");

const TICK_MS = 5 * 60 * 1000; // slow tick runs every ~5 min
const INSPIRATION_CHANCE = 0.02; // 2% per tick per eligible citizen
const MIN_UNEXHIBITED_FOR_SHOW = 3; // gallery needs 3+ new works to exhibit

let lastTick = 0;

/**
 * The director calls this on its slow tick.
 * @param {object} director - the CitizenDirector
 * @param {number} nowMs
 */
function tickArt(director, nowMs = Date.now()) {
  try {
    if (nowMs - lastTick < TICK_MS) return;
    lastTick = nowMs;

    // Expire stale market listings.
    Art.expireListings(nowMs);

    // Exhibition scheduling per kingdom.
    const kingdoms = kingdomsOf(director);
    for (const kingdomId of kingdoms) {
      try {
        maybeExhibit(director, kingdomId, nowMs);
      } catch {
        // One bad kingdom never breaks the tick.
      }
    }

    // Artist inspiration: ambient creation by creative citizens.
    try {
      maybeInspire(director, nowMs);
    } catch {
      // Inspiration failure never breaks the tick.
    }
  } catch {
    // Never throw out of the tick.
  }
}

function kingdomsOf(director) {
  try {
    const roster = director.roster?.values?.() ?? director.roster ?? [];
    const ids = new Set();
    for (const record of roster) {
      const k = record?.kingdomId ?? record?.kingdom ?? null;
      if (k) ids.add(String(k));
    }
    return [...ids];
  } catch {
    return [];
  }
}

function maybeExhibit(director, kingdomId, nowMs) {
  const st = Art.load();
  const unexhibited = st.artworks.filter(
    (a) => a.kingdomId === String(kingdomId) && !a.exhibited
  );
  if (unexhibited.length < MIN_UNEXHIBITED_FOR_SHOW) return;
  if (!Art.canExhibit(kingdomId, nowMs)) return;

  const exhibition = Art.hostExhibition(kingdomId, nowMs);
  if (!exhibition) return;

  // Announce near real players.
  const say = director.sayPublic ?? director.say ?? null;
  const journal = safeJournal(director);
  const titles = exhibition.artworkIds
    .map((id) => st.artworks.find((a) => a.id === id)?.title)
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");

  const msg = `The ${kingdomId} Gallery opens a new exhibition featuring ${titles}!`;
  journal?.log?.("art-exhibition", {
    kingdomId,
    count: exhibition.artworkIds.length,
    artists: exhibition.artists,
    at: nowMs,
  });
  try {
    if (typeof say === "function") say(msg);
  } catch {
    // Announcement failure is not fatal.
  }
}

function maybeInspire(director, nowMs) {
  const roster = director.roster?.values?.() ?? director.roster ?? [];
  for (const record of roster) {
    try {
      if (!record || record.role !== "commoner") continue;
      const creativity = record.personality?.creativity ?? record.personality?.creative ?? 0;
      if (creativity < 0.6) continue; // only the truly creative
      if (Math.random() >= INSPIRATION_CHANCE) continue;

      // The citizen must be online with a real bot to create art.
      const citizen = director.isOnline?.(record) ? director.getBot?.(record) : null;
      if (!citizen) continue;

      // Pick a medium they can afford (materials check).
      const medium = affordableMedium(citizen);
      if (!medium) continue;

      const craftingLevel = realCraftingLevel(citizen);
      const art = Art.createArtwork(
        record.username,
        medium,
        craftingLevel,
        creativity,
        record.kingdomId ?? record.kingdom,
        nowMs
      );
      if (!art) continue;

      // Consume the materials (real inventory).
      consumeMaterials(citizen, medium);

      // Masterpieces earn fame and get announced.
      if (Art.isMasterpiece(art)) {
        try {
          const Rep = require("./CitizenReputation");
          Rep.addReputation?.(record.username, Art.FAME_DEED_MASTERPIECE ?? 5, "masterpiece", nowMs);
        } catch {
          // No reputation → no fame, art still exists.
        }
        const journal = safeJournal(director);
        journal?.log?.("art-masterpiece", {
          artist: record.username,
          title: art.title,
          medium,
          quality: art.quality,
          at: nowMs,
        });
      }

      // One inspiration per tick — don't flood.
      break;
    } catch {
      // One bad citizen never breaks the tick.
    }
  }
}

/** Count of an item in inventory (defensive, multi-API). */
function countItem(inv, itemId) {
  try {
    if (!inv) return 0;
    if (typeof inv.getAmount === "function") return inv.getAmount(itemId) ?? 0;
    if (typeof inv.count === "function") return inv.count(itemId) ?? 0;
    if (typeof inv.contains === "function") return inv.contains(itemId) ? 1 : 0;
    return 0;
  } catch {
    return 0;
  }
}

/** Remove items from inventory (defensive, multi-API). Returns amount taken. */
function takeItem(inv, itemId, amount) {
  try {
    if (!inv) return 0;
    const have = countItem(inv, itemId);
    const take = Math.min(have, amount);
    if (take <= 0) return 0;
    if (typeof inv.deleteNumber === "function") inv.deleteNumber(itemId, take);
    else if (typeof inv.remove === "function") inv.remove(itemId, take);
    else if (typeof inv.delete === "function") inv.delete(itemId, take);
    else return 0;
    return take;
  } catch {
    return 0;
  }
}

/** Which medium can this citizen afford right now? Returns medium id or null. */
function affordableMedium(citizen) {
  const inv = citizen?.getInventory?.();
  if (!inv) return null;
  for (const mediumId of ["painting", "sculpture", "writing"]) {
    const medium = Art.ART_MEDIUMS[mediumId];
    if (!medium) continue;
    let ok = true;
    for (const mat of medium.materials) {
      const need = mat.amount;
      // anyOf: any one of the listed items satisfies the requirement.
      const ids = mat.anyOf ?? [mat.item];
      const have = ids.reduce((sum, id) => sum + countItem(inv, id), 0);
      if (have < need) {
        ok = false;
        break;
      }
    }
    // Tools must be present (not consumed).
    for (const tool of medium.tools ?? []) {
      if (countItem(inv, tool) < 1) {
        ok = false;
        break;
      }
    }
    if (ok) return mediumId;
  }
  return null;
}

/** Consume materials for a medium (tools are not consumed). */
function consumeMaterials(citizen, mediumId) {
  const medium = Art.ART_MEDIUMS[mediumId];
  if (!medium) return;
  const inv = citizen?.getInventory?.();
  if (!inv) return;
  for (const mat of medium.materials) {
    if (!mat.consumed) continue;
    let need = mat.amount;
    const ids = mat.anyOf ?? [mat.item];
    for (const id of ids) {
      if (need <= 0) break;
      need -= takeItem(inv, id, need);
    }
  }
}

function realCraftingLevel(citizen) {
  try {
    return citizen?.getSkills?.()?.getLevel?.("crafting") ?? citizen?.skills?.crafting ?? 1;
  } catch {
    return 1;
  }
}

function safeJournal(director) {
  try {
    return director.getJournal?.() ?? null;
  } catch {
    return null;
  }
}

/** Test seam — reset tick throttle. */
function _resetTickForTests() {
  lastTick = 0;
}

module.exports = {
  tickArt,
  _resetTickForTests,
};
