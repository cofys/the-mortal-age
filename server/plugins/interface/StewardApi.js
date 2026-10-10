"use strict";

const ContentApiAuth = require("./ContentApiAuth");

/**
 * StewardApi — HTTP data layer for the web client's steward's-desk overlay.
 *
 * Replaces the native sendMultiChatboxPrompt audience (Steward.Kingdoms.js)
 * with a heraldic web overlay. All office logic is reused, not reimplemented:
 * office data from Offices.Kingdoms, petitions via Politics.petition,
 * influence numbers from Influence.Kingdoms, resignations via
 * Commands.vacateOffice.
 *
 *   GET /api/steward-status?player=<username>
 *     -> { open: false }
 *      | { open: true, kingdom: { id, name }, offices: [...], held: [...],
 *          influence: { value, petitionThreshold, challengeThreshold, trial } }
 *
 *   ...&action=close                  — dismiss the overlay (clears steward:open)
 *   ...&action=petition&office=<id>    — petition for an office (Politics.petition;
 *                                        ruling messages go to the player's chatbox)
 *   ...&action=vacate&office=<id>      — resign an office (Commands.vacateOffice)
 *
 * Trigger: Steward.Kingdoms sets the steward:open attribute (to the kingdom id)
 * when the desk is clicked. The overlay polls this endpoint; closing clears it.
 * The native showAudience remains in Steward.Kingdoms as the fallback path.
 */

const STEWARD_OPEN_ATTRIBUTE = "steward:open";
const KINGDOM_ID_ATTRIBUTE = "kingdom:id";

const Offices = require("../kingdoms/Offices.Kingdoms");
const Politics = require("../kingdoms/Politics.Kingdoms");
const Commands = require("../kingdoms/Commands.Kingdoms");
const Influence = require("../kingdoms/Influence.Kingdoms");
const Store = require("../kingdoms/KingdomStore");

function safeGet(player, key) {
  try {
    return player.getAttribute(key);
  } catch {
    return undefined;
  }
}

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

function findPlayer(api, username) {
  const name = (username || "").trim();
  if (!name) return null;
  try {
    return api.core.World.getPlayerByName(name) || null;
  } catch {
    return null;
  }
}

function kingdomFor(player) {
  try {
    const id = safeGet(player, KINGDOM_ID_ATTRIBUTE);
    if (!id) return null;
    const kingdom = Store.getKingdom(String(id));
    if (!kingdom) return null;
    return { id: String(id), name: String(kingdom.name ?? id) };
  } catch {
    return null;
  }
}

/** Plain office list for the overlay: title, vacancy, holder name. */
function officeList(kingdomId) {
  try {
    return Offices.getOffices(kingdomId).map((o) => ({
      officeId: String(o.officeId ?? o.office ?? ""),
      title: String(o.title ?? o.office ?? ""),
      vacant: !o.holder,
      holderName: o.holder ? String(Offices.holderName(o.holder)) : null,
    }));
  } catch {
    return [];
  }
}

/** Offices of this kingdom the player personally holds. */
function officesHeldBy(player, kingdomId) {
  const username = usernameOf(player);
  if (!username) return [];
  try {
    return Offices.getOffices(kingdomId)
      .filter((o) => o.holder?.kind === "player" && o.holder.ref === username)
      .map((o) => ({
        officeId: String(o.officeId ?? o.office ?? ""),
        title: String(o.title ?? o.office ?? ""),
      }));
  } catch {
    return [];
  }
}

/** Influence numbers (not the chatbox version) for the standing readout. */
function influenceFor(player, kingdomId) {
  try {
    const trial = Influence.getTrial(player);
    return {
      value: Influence.effectiveInfluence(player, kingdomId),
      petitionThreshold: Influence.PETITION_THRESHOLD,
      challengeThreshold: Influence.CHALLENGE_THRESHOLD,
      trial:
        trial && trial.kingdomId === kingdomId
          ? {
              progress: trial.progress ?? 0,
              target: trial.target ?? 0,
              daysLeft: Math.max(
                0,
                Math.ceil((trial.deadline - Date.now()) / 86400000)
              ),
            }
          : null,
    };
  } catch {
    return { value: 0, petitionThreshold: 100, challengeThreshold: 250, trial: null };
  }
}

function attach(api) {
  console.info("[steward-api] registering steward-status endpoint");
  ContentApiAuth.setPluginApi(api);
  api.persistAttribute(STEWARD_OPEN_ATTRIBUTE);
  api.registerContentEndpoint("steward-status", (query) => {
    try {
      const action = (query.get("action") || "").trim().toLowerCase();
      const officeId = (query.get("office") || "").trim();

      // State-changing actions require auth; the status read uses the token
      // when present but falls back to the player query param.
      const authed =
        action === "close" || action === "petition" || action === "vacate";
      const player = authed
        ? ContentApiAuth.requireAuth(query)
        : ContentApiAuth.requireAuth(query) || findPlayer(api, query.get("player"));
      if (!player) return { open: false, error: authed ? "unauthorized" : undefined };

      if (action === "close") {
        try {
          player.setAttribute(STEWARD_OPEN_ATTRIBUTE, "");
        } catch {}
        return { open: false };
      }

      if (action === "petition" && officeId) {
        try {
          Politics.petition(player, [officeId]);
        } catch (e) {
          console.warn("[steward-api] petition failed", e?.message ?? e);
          return { open: true, ok: false };
        }
        return { open: true, ok: true };
      }

      if (action === "vacate" && officeId) {
        try {
          Commands.vacateOffice(player, [officeId]);
        } catch (e) {
          console.warn("[steward-api] vacate failed", e?.message ?? e);
          return { open: true, ok: false };
        }
        return { open: true, ok: true };
      }

      const openAttr = String(safeGet(player, STEWARD_OPEN_ATTRIBUTE) || "").trim();
      if (!openAttr) return { open: false };

      const kingdom = kingdomFor(player);
      if (!kingdom) return { open: false };

      return {
        open: true,
        kingdom,
        offices: officeList(kingdom.id),
        held: officesHeldBy(player, kingdom.id),
        influence: influenceFor(player, kingdom.id),
      };
    } catch (e) {
      console.warn("[steward-api] status failed", e?.message ?? e);
      return { open: false };
    }
  });
}

module.exports = {
  attach,
  STEWARD_OPEN_ATTRIBUTE,
};
