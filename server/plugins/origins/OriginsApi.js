"use strict";

/**
 * OriginsApi — HTTP data layer for the web client's origin overlay.
 *
 * The web client cannot render the game engine's widget system, so the
 * origin selection screen is a React HTML/CSS overlay. This module feeds
 * it: realm data, background data, and per-player creation status.
 *
 *   GET /api/origins-status?player=<username>
 *     -> { needsChoice: boolean,
 *          hasOrigin: boolean, hasBackground: boolean, hasName: boolean,
 *          realms: [{ id, name, city, demonym, epithet, lens, welcome }],
 *          backgrounds: [{ id, name, epithet, lens }] }
 *
 * Unified creation claim (all three in one request):
 *   GET /api/origins-status?player=<username>
 *       &origin=<realmId>&background=<bgId>&firstname=<f>&lastname=<l>
 *     -> applies background + names + origin in dependency order, so the
 *        legacy chatbox flows (which check hasBackground/hasFullName) skip.
 *        Emits origins:selected (via claimOrigin) then character:created.
 *
 * Legacy single-origin claim (kept for backward compatibility):
 *   GET /api/origins-status?player=<username>&claim=<realmId>
 *
 * The overlay sends the player's choice back through HTTP — more reliable
 * than websocket chat during creation. This endpoint is read-only by design
 * apart from the claim actions above.
 */

const Data = require("./Data.Origins");
const BgData = require("./Data.Backgrounds");
const Selection = require("./Selection.Origins");
const Backgrounds = require("./Backgrounds.Origins");

let apiRef = null;

function statusPayload(player) {
  const realms = Data.ORIGINS.map((o) => ({
    id: o.id,
    name: o.name,
    city: o.city,
    demonym: o.demonym,
    epithet: o.epithet,
    lens: o.lens,
    welcome: o.welcome,
  }));
  const backgrounds = BgData.BACKGROUNDS.map((b) => ({
    id: b.id,
    name: b.name,
    epithet: b.epithet,
    lens: b.lens,
  }));
  if (!player) {
    return { needsChoice: false, realms, backgrounds };
  }
  const hasOrigin = Selection.hasOrigin(player);
  const hasBackground = Backgrounds.hasBackground(player);
  const hasName = Backgrounds.hasFullName(player);
  return {
    needsChoice: !(hasOrigin && hasBackground && hasName),
    hasOrigin,
    hasBackground,
    hasName,
    realms,
    backgrounds,
  };
}

/**
 * Unified creation: apply background + names + origin in one go.
 * Order matters: background and names are set BEFORE claimOrigin emits
 * origins:selected, so the legacy chatbox handlers (which check
 * hasBackground/hasFullName) skip their prompts.
 *
 * Resumable: any piece the player already has (from an interrupted earlier
 * attempt) is skipped rather than erroring, so a partial claim completes
 * on retry instead of failing silently with "Home already claimed."
 * Returns { ok: true } or { ok: false, error }.
 */
function claimFullCharacter(player, originId, backgroundId, firstName, lastName) {
  if (!player) return { ok: false, error: "No player." };

  const needsOrigin = !Selection.hasOrigin(player);
  const needsBackground = !Backgrounds.hasBackground(player);
  const needsName = !Backgrounds.hasFullName(player);
  if (!needsOrigin && !needsBackground && !needsName) return { ok: true };

  // Validate origin (only when still needed).
  if (needsOrigin && !Data.BY_ID.get(originId)) {
    return { ok: false, error: "Unknown home." };
  }

  // Validate background (only when still needed).
  if (needsBackground && !BgData.BY_ID.has(backgroundId)) {
    return { ok: false, error: "Unknown past." };
  }
  // Validate names (only when still needed).
  let first = null;
  let last = null;
  if (needsName) {
    first = Backgrounds.cleanNamePart(firstName);
    last = Backgrounds.cleanNamePart(lastName);
    if (!first || !last) {
      return { ok: false, error: "That name won't do — letters only, 2 to 16 characters each." };
    }
  }

  // Apply background (no UI) — sets attribute, skills, kit, contact.
  if (needsBackground) {
    const bg = Backgrounds.applyBackground(player, backgroundId);
    if (!bg) return { ok: false, error: "Could not take up that past." };
  }

  // Apply names (no UI, no event yet).
  if (needsName) {
    const nameResult = Backgrounds.setNames(player, first, last);
    if (nameResult.error) return { ok: false, error: nameResult.error };
  }

  // Claim origin: sets origin:id, joins kingdom, grants kit, moves to spawn,
  // emits origins:selected. The backgrounds handler sees hasBackground and
  // skips its chatbox prompts.
  if (needsOrigin) {
    try {
      Selection.claimOrigin(player, originId);
    } catch (e) {
      return { ok: false, error: "Could not claim home." };
    }
  }

  // Now the character is fully formed — emit for quest start and other systems.
  player.sendMessage(`From this day, you are ${first} ${last}. Make the name mean something.`);
  try {
    apiRef.emitCustomEvent("character:created", {
      player,
      firstName: first,
      lastName: last,
      backgroundId,
      originId,
    });
  } catch (e) {
    console.warn("[origins-api] character:created emit failed", e?.message ?? e);
  }

  return { ok: true };
}

function attach(api) {
  apiRef = api;
  console.info("[origins-api] registering origins-status endpoint");
  api.registerContentEndpoint("origins-status", (query) => {
    const username = (query.get("player") || "").trim();
    let player = null;
    if (username) {
      try {
        player = api.core.World.getPlayerByName(username) || null;
      } catch {
        player = null;
      }
    }

    // Failed-claim error for this request, surfaced in the payload so the
    // client can show it — never fail silently while the overlay stays open.
    let claimError = null;

    if (player) {
      // Reset creation: clears origin, background, and name for a fresh start.
      const reset = (query.get("reset") || "").trim().toLowerCase();
      if (reset === "true") {
        try {
          player.setAttribute("origin:id", null);
          player.setAttribute("background:id", null);
          player.setAttribute("character:first-name", null);
          player.setAttribute("character:last-name", null);
          player.setAttribute("character:display-name", null);
          api.emitCustomEvent("origins:reset", { player });
        } catch (e) {
          console.warn("[origins-api] reset failed", e?.message ?? e);
        }
      }
      // Unified creation claim: origin + background + names in one request.
      const originId = (query.get("origin") || "").trim().toLowerCase();
      const backgroundId = (query.get("background") || "").trim().toLowerCase();
      const firstname = (query.get("firstname") || "").trim();
      const lastname = (query.get("lastname") || "").trim();
      if (originId && backgroundId && firstname && lastname) {
        const result = claimFullCharacter(player, originId, backgroundId, firstname, lastname);
        if (!result.ok) {
          claimError = result.error;
          console.warn(`[origins-api] full character claim failed for ${username}: ${result.error}`);
        }
      } else {
        // Legacy single-origin claim.
        const claimId = (query.get("claim") || "").trim().toLowerCase();
        if (claimId && Data.BY_ID.has(claimId) && !Selection.hasOrigin(player)) {
          try {
            Selection.claimOrigin(player, claimId);
          } catch (e) {
            console.warn("[origins-api] claim failed", e?.message ?? e);
          }
        }
      }
    }
    const payload = statusPayload(player);
    if (claimError) payload.claimError = claimError;
    return payload;
  });
}

module.exports = { attach };
