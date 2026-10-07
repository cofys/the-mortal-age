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
 * Unified creation claim (all four in one request):
 *   GET /api/origins-status?player=<username>
 *       &origin=<realmId>&background=<bgId>&firstname=<f>&lastname=<l>
 *       &appearance=<urlencoded JSON {gender,head,beard,hairColor,torsoColor,legColor,feetColor,skinColor}>
 *     -> applies background + names + appearance + origin in dependency order,
 *        so the legacy chatbox flows (which check hasBackground/hasFullName)
 *        skip. Emits origins:selected (via claimOrigin) then character:created.
 *
 * The status payload also carries the player's current `appearance` so the
 * creation UI can preview it live.
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

// Appearance slot indices (mirror Appearance.ts).
const APP_GENDER = 0;
const APP_HEAD = 1;
const APP_CHEST = 2;
const APP_ARMS = 3;
const APP_HANDS = 4;
const APP_LEGS = 5;
const APP_FEET = 6;
const APP_BEARD = 7;
const APP_HAIR_COLOUR = 8;
const APP_TORSO_COLOUR = 9;
const APP_LEG_COLOUR = 10;
const APP_FEET_COLOUR = 11;
const APP_SKIN_COLOUR = 12;

// Curated valid kit/color ranges for the creation UI. Kit ids come from the
// cache's identikit configs; these ranges bracket the engine defaults
// (male head 3, female head 48, male beard 14) so every choice renders.
const MALE_HEADS = [0, 1, 2, 3, 4, 5, 6, 7];
const FEMALE_HEADS = [45, 46, 47, 48, 49, 50, 51, 52];
const MALE_BEARDS = [-1, 10, 11, 12, 13, 14, 15, 16, 17];
const HAIR_COLORS = 24;   // 0-23
const CLOTH_COLORS = 28;  // 0-27
const SKIN_COLORS = 7;    // 0-6
const FEET_COLORS = 6;    // 0-5

function defaultAppearance(gender) {
  const female = gender === 1;
  return female
    ? { gender: 1, head: 48, beard: -1, hairColor: 2, torsoColor: 14, legColor: 5, feetColor: 4, skinColor: 0 }
    : { gender: 0, head: 3, beard: 14, hairColor: 2, torsoColor: 14, legColor: 5, feetColor: 4, skinColor: 0 };
}

function sanitizeAppearance(raw) {
  let a;
  try {
    a = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!a || typeof a !== "object") return null;
  const gender = a.gender === 1 ? 1 : 0;
  const heads = gender === 1 ? FEMALE_HEADS : MALE_HEADS;
  const head = heads.includes(a.head | 0) ? (a.head | 0) : heads[3];
  const beard = gender === 1 ? -1 : (MALE_BEARDS.includes(a.beard | 0) ? (a.beard | 0) : 14);
  const clamp = (v, n) => {
    v |= 0;
    return v >= 0 && v < n ? v : 0;
  };
  return {
    gender,
    head,
    beard,
    hairColor: clamp(a.hairColor, HAIR_COLORS),
    torsoColor: clamp(a.torsoColor, CLOTH_COLORS),
    legColor: clamp(a.legColor, CLOTH_COLORS),
    feetColor: clamp(a.feetColor, FEET_COLORS),
    skinColor: clamp(a.skinColor, SKIN_COLORS),
  };
}

/**
 * Apply a sanitized appearance to the player via the engine Appearance API.
 * Uses the gender-appropriate default body kits (chest/arms/hands/legs/feet)
 * since creation only customizes head/beard/colors.
 */
function applyAppearance(player, app) {
  try {
    const appearance = player.getAppearance?.();
    if (!appearance) return false;
    const female = app.gender === 1;
    const look = appearance.getLook ? [...appearance.getLook()] : new Array(13).fill(0);
    look[APP_GENDER] = app.gender;
    look[APP_HEAD] = app.head;
    look[APP_BEARD] = app.beard;
    // Body kits: engine defaults per gender (creation doesn't change these).
    if (female) {
      look[APP_CHEST] = 57; look[APP_ARMS] = 65; look[APP_HANDS] = 68;
      look[APP_LEGS] = 77; look[APP_FEET] = 80;
    } else {
      look[APP_CHEST] = 18; look[APP_ARMS] = 26; look[APP_HANDS] = 34;
      look[APP_LEGS] = 38; look[APP_FEET] = 42;
    }
    look[APP_HAIR_COLOUR] = app.hairColor;
    look[APP_TORSO_COLOUR] = app.torsoColor;
    look[APP_LEG_COLOUR] = app.legColor;
    look[APP_FEET_COLOUR] = app.feetColor;
    look[APP_SKIN_COLOUR] = app.skinColor;
    appearance.setLookArray(look);
    return true;
  } catch (e) {
    console.warn("[origins-api] applyAppearance failed", e?.message ?? e);
    return false;
  }
}

/** Read the player's current appearance into the creation shape (for preview). */
function readAppearance(player) {
  try {
    const look = player.getAppearance?.()?.getLook?.();
    if (!look || look.length < 13) return null;
    return {
      gender: look[APP_GENDER] === 1 ? 1 : 0,
      head: look[APP_HEAD] | 0,
      beard: look[APP_BEARD] | 0,
      hairColor: look[APP_HAIR_COLOUR] | 0,
      torsoColor: look[APP_TORSO_COLOUR] | 0,
      legColor: look[APP_LEG_COLOUR] | 0,
      feetColor: look[APP_FEET_COLOUR] | 0,
      skinColor: look[APP_SKIN_COLOUR] | 0,
    };
  } catch {
    return null;
  }
}

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
    return { needsChoice: false, realms, backgrounds, appearance: null };
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
    appearance: readAppearance(player),
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
function claimFullCharacter(player, originId, backgroundId, firstName, lastName, appearanceRaw) {
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

  // Apply appearance (from the creation UI's appearance step). Falls back to
  // the engine default for the chosen gender when absent/invalid.
  const app = sanitizeAppearance(appearanceRaw) || defaultAppearance(0);
  applyAppearance(player, app);

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
      // Unified creation claim: origin + background + names + appearance.
      const originId = (query.get("origin") || "").trim().toLowerCase();
      const backgroundId = (query.get("background") || "").trim().toLowerCase();
      const firstname = (query.get("firstname") || "").trim();
      const lastname = (query.get("lastname") || "").trim();
      const appearanceRaw = (query.get("appearance") || "").trim();
      if (originId && backgroundId && firstname && lastname) {
        const result = claimFullCharacter(player, originId, backgroundId, firstname, lastname, appearanceRaw);
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
