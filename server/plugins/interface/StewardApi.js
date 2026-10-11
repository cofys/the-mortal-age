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
 *      | { open: true, kingdom: { id, name }, allegiance: { id, name } | null,
 *          offices: [...], held: [...],
 *          influence: { value, petitionThreshold, challengeThreshold, trial },
 *          naturalization: null | { kingdomId, kingdomName, influence, target,
 *            fee, feeCarried, cooldownDaysLeft, oathReady, blockers } }
 *
 *   ...&action=close                  — dismiss the overlay (clears steward:open)
 *   ...&action=open                   — sidebar tab: seat the player at a desk.
 *                                        A physical desk session (attribute
 *                                        already set) is left untouched and
 *                                        reported with opened:false; otherwise
 *                                        the player's own court is used (their
 *                                        allegiance, or their naturalization
 *                                        quest's court) and opened:true is
 *                                        returned, so the tab knows it owns —
 *                                        and must clear — the attribute.
 *   ...&action=petition&office=<id>    — petition for an office (Politics.petition;
 *                                        ruling messages go to the player's chatbox)
 *   ...&action=vacate&office=<id>      — resign an office (Commands.vacateOffice)
 *   ...&action=renounce                — renounce the oath to this court
 *                                        (Switching.renounce; hatred backend)
 *   ...&action=petition-join           — petition this court for naturalization
 *                                        (Switching.startNaturalization)
 *   ...&action=take-oath               — swear the oath at this desk once the
 *                                        naturalization quest is complete
 *                                        (Switching.takeOath)
 *
 * Trigger: Steward.Kingdoms sets the steward:open attribute (to the kingdom id)
 * when the desk is clicked. The overlay polls this endpoint; closing clears it.
 * The native showAudience remains in Steward.Kingdoms as the fallback path.
 *
 * The desk's kingdom is the court in the room: kingdom, offices, and
 * influence are read for the DESK's court, not the player's allegiance. A
 * foreign desk offers naturalization; a home desk offers the oath's release.
 */

const STEWARD_OPEN_ATTRIBUTE = "steward:open";
const KINGDOM_ID_ATTRIBUTE = "kingdom:id";

const Offices = require("../kingdoms/Offices.Kingdoms");
const Politics = require("../kingdoms/Politics.Kingdoms");
const Commands = require("../kingdoms/Commands.Kingdoms");
const Influence = require("../kingdoms/Influence.Kingdoms");
const Switching = require("../kingdoms/Switching.Kingdoms");
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

/**
 * The court in the room: the desk's kingdom (steward:open holds the desk's
 * kingdom id), not the player's allegiance. A foreign desk serves a foreign
 * court — that is what makes naturalization diegetic.
 */
function deskKingdomFor(player) {
  try {
    const id = String(safeGet(player, STEWARD_OPEN_ATTRIBUTE) || "").trim();
    if (!id) return null;
    const kingdom = Store.getKingdom(id);
    if (!kingdom) return null;
    return { id: String(id), name: String(kingdom.name ?? id) };
  } catch {
    return null;
  }
}

/** The player's own allegiance, for the home-court / foreign-court split. */
function allegianceFor(player) {
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
        action === "close" ||
        action === "open" ||
        action === "petition" ||
        action === "vacate" ||
        action === "renounce" ||
        action === "petition-join" ||
        action === "take-oath";
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

      // Sidebar tab: seat the player at a desk (see header). A desk clicked
      // in-world always wins — the tab only fills an empty attribute, with
      // the player's own court: their allegiance, or failing that the court
      // of their naturalization quest.
      let openedByTab = false;
      if (action === "open") {
        const current = String(safeGet(player, STEWARD_OPEN_ATTRIBUTE) || "").trim();
        if (!current) {
          let courtId = allegianceFor(player)?.id ?? null;
          if (!courtId) {
            try {
              courtId = Switching.naturalizationProgress(player)?.kingdomId ?? null;
            } catch {}
          }
          if (!courtId) return { open: false, opened: false };
          try {
            player.setAttribute(STEWARD_OPEN_ATTRIBUTE, courtId);
            openedByTab = true;
          } catch {}
        }
      }

      const desk = deskKingdomFor(player);

      if (action === "renounce") {
        const allegiance = allegianceFor(player);
        if (!allegiance || !desk || allegiance.id !== desk.id) {
          return { open: true, ok: false, message: "This court holds no oath of yours to release." };
        }
        let otherIds = [];
        try {
          otherIds = Store.getKingdoms()
            .map((k) => k.id)
            .filter((id) => id && id !== allegiance.id);
        } catch {}
        const result = Switching.renounce(player, otherIds);
        return {
          open: true,
          ok: !!result,
          spreadTo: result?.spreadTo ?? [],
          message: result
            ? `Your oath to ${desk.name} is renounced. The realm will remember.`
            : "You serve no kingdom — there is nothing to renounce.",
        };
      }

      if (action === "petition-join") {
        if (!desk) return { open: false };
        const res = Switching.startNaturalization(player, desk.id);
        return { open: true, ok: res.ok, message: res.message };
      }

      if (action === "take-oath") {
        if (!desk) return { open: false };
        const res = Switching.takeOath(player, desk.id);
        return { open: true, ok: res.ok, message: res.message };
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

      const kingdom = desk;
      if (!kingdom) return { open: false };

      return {
        open: true,
        ...(action === "open" ? { opened: openedByTab } : {}),
        kingdom,
        allegiance: allegianceFor(player),
        offices: officeList(kingdom.id),
        held: officesHeldBy(player, kingdom.id),
        influence: influenceFor(player, kingdom.id),
        naturalization: Switching.naturalizationProgress(player),
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
