"use strict";

/**
 * SuccessionDeep.Kingdoms — WHO KNOWS, WHO'S HUNTING, WHAT HAPPENS WHEN YOU DIG.
 *
 * The companion to Succession.Kingdoms (which plants ambient whispers, stages
 * 0-4). This module is the INTERACTIVE layer: what happens when a player
 * starts asking questions about the heirless crown.
 *
 * READ THE ARC RULES FIRST (world bible, locked):
 * - The hidden bastard son is a PHASE 10 custom questline. This module NEVER
 *   resolves, never names the son, never confirms anything, and never touches
 *   the `misthalin:bastard-son-hidden` story flag.
 * - Everything is deniable by design. Fragments are oblique. The answer is
 *   always "drunk talk" — until phase 10.
 *
 * What this module does:
 *
 *   KEEPERS (who knows) — four keeper archetypes in Varrock hold one fragment
 *   each. A fragment is a shard of the puzzle, never the picture:
 *     guardsman  (commoner)  — the palace servant's memory
 *     midwife    (merchant)   — the birth no one speaks of
 *     priest     (courtier)   — what the king confesses
 *     trader     (merchant)   — the farm that pays no taxes
 *   A player gets each fragment once, delivered privately (sendMessage, never
 *   public — deniable). Keepers are archetypes, not named NPCs: any matching
 *   citizen in Misthalin can be the keeper for that conversation.
 *
 *   HEAT (what happens when you dig) — per-player `succession:heat` (0-100).
 *   Asking about the heir near a Misthalin citizen raises it. Heat decays
 *   with time. Thresholds escalate the world's response:
 *     25+  "You feel eyes on you." — the first chill (once per crossing)
 *     40+  keepers refuse to talk — "I can't. Not here." (no fragment)
 *     55+  the grey man asks about YOU in the Blue Moon (rumor, named)
 *     70+  keepers go quiet for you permanently — fragments locked
 *     85+  a grey man finds you in the street — "Careful what you ask
 *          about, friend." (dread, never damage, never theft)
 *
 *   HUNTERS (who's hunting) — the suppression side, ambient:
 *   - When any player's heat crosses 55, there's a chance a planted whisper
 *     gets publicly retracted ("recanted — said he made it all up").
 *   - Rare street sightings: "a grey man watching the market."
 *
 * In (custom events):
 *   citizens:chat-heard { citizenUsername, speakerUsername, text }
 * Out (custom events):
 *   kingdom:rumor { kingdomId: "misthalin", text }
 *
 * Player attributes (kebab-case, namespaced per AGENTS.md):
 *   succession:heat       number 0-100
 *   succession:heat-at    timestamp of last heat change (for decay)
 *   succession:fragments  array of fragment ids collected
 *   succession:warned-25  (etc.) threshold-crossing markers
 *   succession:grey-met   timestamp of last grey-man encounter (daily cap)
 *
 * Numbers live in DESIGN.md.
 */

const Store = require("./KingdomStore");

// --- tuning ---------------------------------------------------------------

const HEAT_ATTRIBUTE = "succession:heat";
const HEAT_AT_ATTRIBUTE = "succession:heat-at";
const FRAGMENTS_ATTRIBUTE = "succession:fragments";
const GREY_MET_ATTRIBUTE = "succession:grey-met";

// Heat gained per detected heir-question (30s per-player cooldown).
const HEAT_PER_QUESTION = 12;
const QUESTION_COOLDOWN_MS = 30 * 1000;
// Heat decays this much per hour of real time.
const HEAT_DECAY_PER_HOUR = 5;

const THRESHOLD_WATCHED = 25;
const THRESHOLD_REFUSE = 40;
const THRESHOLD_GREY_RUMOR = 55;
const THRESHOLD_LOCKED = 70;
const THRESHOLD_GREY_MEETING = 85;

// Chance a planted whisper gets retracted when someone's heat crosses 55.
const RETRACTION_CHANCE = 0.25;
// Chance per tick of a grey-man street sighting while any heat is high.
const GREY_SIGHTING_CHANCE = 0.08;
// Grey-man street meeting: at most once per day per player.
const GREY_MEETING_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Keywords that count as "asking about the heir". Matched case-insensitively
// against the player's chat text. Deliberately broad — curiosity is the tripwire.
const HEIR_KEYWORDS = [
  "heir",
  "bastard",
  "succession",
  "heirless",
  "bloodline",
  "true king",
  "king's son",
  "kings son",
  "roald's son",
  "roalds son",
  "no heir",
  "who rules next",
  "who inherits",
];

let pluginApi = null;

// --- fragments ------------------------------------------------------------
// ARC-SEED content. Each is a shard — evocative, deniable, never confirming.
// Keepers are archetypes (role in Varrock), not named NPCs.

const KEEPERS = {
  guardsman: {
    role: "commoner",
    fragmentId: "guardsman-memory",
    text:
      "The old guardsman lowers his voice. \"Twenty year I stood at the palace " +
      "doors. Saw the queen's maid crying once, in the corridor, like her heart " +
      "was broke. Wouldn't say why. Nobody ever asked me twice.\"",
  },
  midwife: {
    role: "merchant",
    fragmentId: "midwife-silence",
    text:
      "The merchant glances around before answering. \"My mother delivered half " +
      "the noble babes in Varrock, rest her. There's one she never speaks of. " +
      "One. I've asked. She just... stops. Like the words won't come.\"",
  },
  priest: {
    role: "courtier",
    fragmentId: "priest-absolution",
    text:
      "The courtier's smile doesn't reach his eyes. \"The king confesses, friend. " +
      "That's all I'll say about that. The king confesses, and I absolve. Some " +
      "sins are too heavy for one man to carry alone — even a king.\"",
  },
  trader: {
    role: "merchant",
    fragmentId: "trader-farm",
    fragmentAlt: true,
    text:
      "The trader leans in. \"There's a farm out east pays no taxes. Royal writ, " +
      "sealed and signed. Nobody asks why. You want my advice? Don't you ask " +
      "why either. Some questions cost more than answers.\"",
  },
};

// --- helpers --------------------------------------------------------------

function heatOf(player) {
  const raw = player?.getAttribute?.(HEAT_ATTRIBUTE);
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
}

/** Time-decayed heat: what the player's heat is RIGHT NOW. */
function currentHeat(player) {
  const stored = heatOf(player);
  if (stored <= 0) return 0;
  const at = player?.getAttribute?.(HEAT_AT_ATTRIBUTE) ?? Date.now();
  const hours = Math.max(0, (Date.now() - at) / (60 * 60 * 1000));
  return Math.max(0, stored - hours * HEAT_DECAY_PER_HOUR);
}

function setHeat(player, value) {
  if (!player?.setAttribute) return;
  player.setAttribute(HEAT_ATTRIBUTE, Math.max(0, Math.min(100, value)));
  player.setAttribute(HEAT_AT_ATTRIBUTE, Date.now());
}

function fragmentsOf(player) {
  const raw = player?.getAttribute?.(FRAGMENTS_ATTRIBUTE);
  return Array.isArray(raw) ? raw : [];
}

function hasFragment(player, fragmentId) {
  return fragmentsOf(player).includes(fragmentId);
}

function grantFragment(player, fragmentId) {
  if (!player?.setAttribute || hasFragment(player, fragmentId)) return false;
  player.setAttribute(FRAGMENTS_ATTRIBUTE, [...fragmentsOf(player), fragmentId]);
  return true;
}

function isMisthalinCitizen(citizenUsername) {
  try {
    const { getDirector } = require("../citizens/director/CitizenDirector");
    const { normalizeName } = require("../citizens/lib/CitizenBonds");
    const record = getDirector()?.roster.get(normalizeName(citizenUsername));
    return record?.kingdomId === "misthalin";
  } catch {
    return false;
  }
}

function citizenRole(citizenUsername) {
  try {
    const { getDirector } = require("../citizens/director/CitizenDirector");
    const { normalizeName } = require("../citizens/lib/CitizenBonds");
    return getDirector()?.roster.get(normalizeName(citizenUsername))?.role ?? null;
  } catch {
    return null;
  }
}

function asksAboutHeir(text) {
  const lower = String(text ?? "").toLowerCase();
  return HEIR_KEYWORDS.some((kw) => lower.includes(kw));
}

function findPlayer(username) {
  try {
    return pluginApi?.core?.World?.getPlayerByName?.(username) ?? null;
  } catch {
    return null;
  }
}

function emitRumor(text) {
  try {
    pluginApi.emitCustomEvent("kingdom:rumor", { kingdomId: "misthalin", text });
  } catch {
    // Rumors are cosmetic; never break the chat path.
  }
}

// --- heat -----------------------------------------------------------------

function thresholdMarker(player, threshold) {
  return `succession:warned-${threshold}`;
}

function crossedThreshold(player, threshold, heat) {
  const marker = thresholdMarker(player, threshold);
  if (player?.getAttribute?.(marker)) return false;
  if (heat < threshold) return false;
  try {
    player.setAttribute(marker, true);
  } catch {
    // Markers are best-effort.
  }
  return true;
}

/**
 * Raise a player's heat by `amount` and fire the threshold side-effects
 * (25: watched, 55: grey-man rumor + possible retraction, 85: grey-man
 * meeting). Shared by the heir-question path and the keepers layer —
 * bribes and found letters are digging too.
 */
function addSuccessionHeat(player, amount) {
  if (!player || player.isPlayerBot?.() === true) return currentHeat(player);
  const newHeat = Math.max(0, Math.min(100, currentHeat(player) + amount));
  setHeat(player, newHeat);
  fireHeatThresholds(player, newHeat, Date.now());
  return newHeat;
}

function fireHeatThresholds(player, newHeat, now) {
  // Threshold 25: the first chill.
  if (crossedThreshold(player, THRESHOLD_WATCHED, newHeat)) {
    player.sendMessage("You feel eyes on you. When you turn, no one is watching.");
  }

  // Threshold 55: the grey man asks about YOU.
  if (crossedThreshold(player, THRESHOLD_GREY_RUMOR, newHeat)) {
    emitRumor(
      `A man in grey was asking about ${player.getUsername()} in the Blue Moon Inn. ` +
        `What they talked about, what they were offered — nobody's saying.`
    );
    // The hunters clean up: sometimes a planted whisper gets retracted.
    if (Math.random() < RETRACTION_CHANCE) {
      emitRumor(
        "That drunk courtier from the Blue Moon? Recanted. Stands in the square " +
          "and swears he made it all up. He looks terrified."
      );
    }
  }

  // Threshold 85: the grey man finds you. Dread, never damage.
  const lastGrey = player.getAttribute?.(GREY_MET_ATTRIBUTE) ?? 0;
  if (newHeat >= THRESHOLD_GREY_MEETING && now - lastGrey > GREY_MEETING_COOLDOWN_MS) {
    try {
      player.setAttribute(GREY_MET_ATTRIBUTE, now);
    } catch {
      // best-effort
    }
    player.sendMessage(
      "A man in grey steps from the crowd, close enough that only you hear him. " +
        "\"Careful what you ask about, friend.\" Then he's gone."
    );
  }
}

/**
 * A player asked about the heir near a Misthalin citizen. Raise heat,
 * escalate at thresholds, and maybe grant a fragment from a keeper.
 */
function onHeirQuestion({ player, citizenUsername }) {
  if (!player || player.isPlayerBot?.() === true) return;

  // Per-player cooldown so one curious burst doesn't max heat instantly.
  const now = Date.now();
  const lastQ = player.getAttribute?.("succession:last-question-at") ?? 0;
  if (now - lastQ >= QUESTION_COOLDOWN_MS) {
    try {
      player.setAttribute("succession:last-question-at", now);
    } catch {
      // best-effort
    }
    addSuccessionHeat(player, HEAT_PER_QUESTION);
  }
  const newHeat = currentHeat(player);

  // Keepers: refused at 40+, locked at 70+.
  if (newHeat >= THRESHOLD_LOCKED) return;
  if (newHeat >= THRESHOLD_REFUSE) {
    if (!player.getAttribute?.("succession:refused-once")) {
      try {
        player.setAttribute("succession:refused-once", true);
      } catch {
        // best-effort
      }
      player.sendMessage(
        "The citizen's face closes. \"I can't talk about that. Not here. Not anywhere. Walk away, friend.\""
      );
    }
    return;
  }

  // A keeper shares their fragment — once per keeper per player.
  // Prefer keepers whose fragment this player hasn't collected yet, so the
  // trader's fragment (also a merchant) stays reachable after the midwife's.
  const role = citizenRole(citizenUsername);
  const keepers = Object.values(KEEPERS).filter((k) => k.role === role);
  const keeper =
    keepers.find((k) => !hasFragment(player, k.fragmentId)) ?? keepers[0];
  if (keeper && grantFragment(player, keeper.fragmentId)) {
    // A beat before the fragment lands — deniable, private.
    player.sendMessage(keeper.text);
    console.info("[succession] fragment granted", {
      player: player.getUsername(),
      fragment: keeper.fragmentId,
      heat: Math.round(newHeat),
    });
  }
}

// --- entry ----------------------------------------------------------------

/**
 * Watches citizens:chat-heard for heir questions. Only Misthalin citizens
 * count — the whispers live in Varrock, and so does the danger.
 */
function onChatHeard(event) {
  try {
    const { citizenUsername, speakerUsername, text } = event ?? {};
    if (!citizenUsername || !speakerUsername || !text) return;
    if (!isMisthalinCitizen(citizenUsername)) return;
    if (!asksAboutHeir(text)) return;
    const player = findPlayer(speakerUsername);
    if (!player || player.isPlayerBot?.() === true) return;
    onHeirQuestion({ player, citizenUsername });
  } catch (error) {
    // The arc must never break chat.
    console.warn("[succession] deep tick failed", error?.message ?? error);
  }
}

/**
 * Ambient hunter pressure: while any online player's heat runs hot, the
 * streets occasionally notice the watchers.
 */
function greySightingSweep() {
  try {
    const players = pluginApi?.core?.World?.getPlayers?.();
    if (!players) return;
    let hot = false;
    players.stream?.().forEach?.((p) => {
      if (p && !p.isPlayerBot?.() && currentHeat(p) >= THRESHOLD_GREY_RUMOR) hot = true;
    });
    if (hot && Math.random() < GREY_SIGHTING_CHANCE) {
      emitRumor(
        "Saw a grey man watching the market today. Didn't buy nothing. Just watched."
      );
    }
  } catch (error) {
    console.warn("[succession] sweep failed", error?.message ?? error);
  }
}

function attachSuccessionDeep(api) {
  pluginApi = api;
  api.onCustomEvent("citizens:chat-heard", onChatHeard);

  // Slow ambient sweep: piggyback the succession whisper cadence concept —
  // a lightweight repeating task every ~30 minutes.
  const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
  class SuccessionDeepTask extends Task {
    execute() {
      greySightingSweep();
    }
  }
  api.getTaskManager()?.submit(new SuccessionDeepTask(3000));
  console.info("[succession] deep arc armed — keepers, heat, hunters");
}

module.exports = attachSuccessionDeep;
module.exports.attachSuccessionDeep = attachSuccessionDeep;
// Shared with the keepers layer (stages 5-8): bribes and found letters dig too.
module.exports.successionHeat = currentHeat;
module.exports.addSuccessionHeat = addSuccessionHeat;
module.exports.grantSuccessionFragment = grantFragment;
