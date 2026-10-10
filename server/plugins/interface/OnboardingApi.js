"use strict";

const ContentApiAuth = require("./ContentApiAuth");

/**
 * OnboardingApi — HTTP data layer for the web client's new-player guide overlay.
 *
 * A short first-10-minutes guide: where the player is (kingdom + capital, live
 * from Membership/KingdomStore), concrete first steps (all verified against
 * existing gameplay hooks), and how this world works.
 *
 *   GET /api/onboarding-status?player=<username>
 *     -> { open: false } | { open: true, kingdom: { name, capital } | null, steps: [...], world: [...] }
 *
 *   ...&action=close    — dismiss for this session (clears onboarding:open)
 *   ...&action=dontshow — never show again (sets onboarding:dismissed, persisted)
 *
 * Trigger (gameplay code, below): onPlayerLogin offers the overlay on the first
 * couple of logins, unless the player permanently dismissed it. Brand-new
 * characters that have not chosen a home yet get their offer via the
 * origins:selected custom event, which fires right after origin selection —
 * the freshest possible moment, without clashing with the origin ceremony.
 */

const ONBOARDING_OPEN_ATTRIBUTE = "onboarding:open";
const ONBOARDING_DISMISSED_ATTRIBUTE = "onboarding:dismissed";
const ONBOARDING_SHOWN_COUNT_ATTRIBUTE = "onboarding:shown-count";
const KINGDOM_ID_ATTRIBUTE = "kingdom:id";
const ORIGIN_ID_ATTRIBUTE = "origin:id";

// How many logins the overlay may appear on before it stops on its own.
// Plain ✕ dismissals and "don't show again" stop it sooner.
const MAX_OFFER_LOGINS = 2;

// Verified against the gameplay plugins listed:
//  - citizens hear public chat: server/plugins/citizens/chat/CitizenChatHeard
//  - Town crier "Ask about the realm.": server/plugins/kingdoms/MyKingdom.Kingdoms.js
//  - Estate agent right-click "Housing-plot": server/plugins/housing/HousingDiegetic.js
//  - War table "Study": server/plugins/kingdoms/WarTable.Kingdoms.js
const FIRST_STEPS = [
  {
    title: "Talk to citizens",
    text: "Walk up to any citizen and type to talk to them. They have needs, moods, and opinions — and they will talk back.",
  },
  {
    title: "Open your kingdom panel",
    text: "Find a Town crier and ask \u201cAsk about the realm\u201d to see your kingdom, your rank, and what is happening.",
  },
  {
    title: "Claim a housing plot",
    text: "Right-click an Estate agent and choose \u201cHousing-plot\u201d to claim your own place in the world.",
  },
  {
    title: "Check the war table",
    text: "Find the war table in your capital and Study it — wars, campaigns, and your kingdom\u2019s standing are all there.",
  },
  {
    title: "Supply the war effort",
    text: "Bring food, arrows, runes or war materials to the war table and contribute — the quartermaster notes every name, and service earns standing with your crown.",
  },
];

const WORLD_LINES = [
  "Citizens are real people with needs, jobs, and grudges — befriend them, hire them, or make enemies of them.",
  "Every kingdom has a treasury, a ruler, and borders worth fighting over.",
  "Wars are fought by players and citizens alike — your choices move the realm.",
  "Everything here is player-driven: the economy, the news, the courts. All yours.",
];

function safeGet(player, key) {
  try {
    return player.getAttribute(key);
  } catch {
    return undefined;
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

/** Live kingdom name + capital from the Membership kingdom plugin's store. */
function kingdomFor(player) {
  try {
    const id = safeGet(player, KINGDOM_ID_ATTRIBUTE);
    if (!id) return null;
    const Store = require("../kingdoms/KingdomStore");
    const kingdom = Store.getKingdom(String(id));
    if (!kingdom) return null;
    return {
      name: String(kingdom.name ?? id),
      capital: kingdom.capital ? String(kingdom.capital) : null,
    };
  } catch {
    return null;
  }
}

function isDismissed(player) {
  return String(safeGet(player, ONBOARDING_DISMISSED_ATTRIBUTE) || "").trim() !== "";
}

function shownCount(player) {
  const n = parseInt(safeGet(player, ONBOARDING_SHOWN_COUNT_ATTRIBUTE) || "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Offer the overlay: set onboarding:open and bump the appearance counter.
 * Stops once the player dismissed it permanently or the login cap is hit.
 */
function offerOnboarding(player) {
  if (!player || player.isPlayerBot?.() === true) return;
  try {
    if (isDismissed(player)) return;
    const shown = shownCount(player);
    if (shown >= MAX_OFFER_LOGINS) return;
    player.setAttribute(ONBOARDING_SHOWN_COUNT_ATTRIBUTE, String(shown + 1));
    player.setAttribute(ONBOARDING_OPEN_ATTRIBUTE, "1");
  } catch (e) {
    console.warn("[onboarding-api] offer failed", e?.message ?? e);
  }
}

/** Returning players (or pre-existing accounts): offer on the first couple of logins. */
function offerOnLogin({ player }) {
  if (!player) return;
  // Brand-new characters have no origin yet — the origins:selected handler
  // below offers at the right moment instead, clear of the origin ceremony.
  try {
    if (!safeGet(player, ORIGIN_ID_ATTRIBUTE)) return;
  } catch {
    // fall through and offer anyway
  }
  offerOnboarding(player);
}

/** A fresh character just picked a home: the freshest moment for the guide. */
function offerOnSelection({ player }) {
  offerOnboarding(player);
}

function attach(api) {
  console.info("[onboarding-api] registering onboarding-status endpoint");
  ContentApiAuth.setPluginApi(api);
  api.persistAttribute(ONBOARDING_DISMISSED_ATTRIBUTE);
  api.persistAttribute(ONBOARDING_SHOWN_COUNT_ATTRIBUTE);
  api.onPlayerLogin(offerOnLogin);
  api.onCustomEvent("origins:selected", offerOnSelection);
  api.registerContentEndpoint("onboarding-status", (query) => {
    try {
      const action = (query.get("action") || "").trim().toLowerCase();

      // Close/dontshow change state, so they require auth; reads use the token
      // when present but the guide content itself is public info.
      const player =
        action === "close" || action === "dontshow"
          ? ContentApiAuth.requireAuth(query)
          : ContentApiAuth.requireAuth(query) || findPlayer(api, query.get("player"));
      if ((action === "close" || action === "dontshow") && !player) {
        return { open: false, error: "unauthorized" };
      }

      if (player && action === "close") {
        player.setAttribute(ONBOARDING_OPEN_ATTRIBUTE, "");
        return { open: false };
      }
      if (player && action === "dontshow") {
        player.setAttribute(ONBOARDING_DISMISSED_ATTRIBUTE, "1");
        player.setAttribute(ONBOARDING_OPEN_ATTRIBUTE, "");
        return { open: false };
      }

      if (!player) return { open: false };
      const open = String(safeGet(player, ONBOARDING_OPEN_ATTRIBUTE) || "").trim();
      if (!open) return { open: false };

      return {
        open: true,
        kingdom: kingdomFor(player),
        steps: FIRST_STEPS.slice(0, 6),
        world: WORLD_LINES.slice(0, 4),
      };
    } catch (e) {
      console.warn("[onboarding-api] status failed", e?.message ?? e);
      return { open: false };
    }
  });
}

module.exports = {
  attach,
  ONBOARDING_OPEN_ATTRIBUTE,
  ONBOARDING_DISMISSED_ATTRIBUTE,
  ONBOARDING_SHOWN_COUNT_ATTRIBUTE,
};
