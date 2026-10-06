"use strict";

/**
 * Reputation.Myreque — the two-sided reputation track for The Mortal Age.
 *
 * Morytania's powder keg, made personal. One axis, -1000..+1000, stored in
 * the namespaced attribute `myreque:standing`:
 *
 *   +600..+1000  Sworn of the Hollow     (Myreque)
 *   +200..+599   Hollow-Trusted          (Myreque)
 *   +1..+199     Whisper-Friend          (leans Myreque)
 *   0            Unremarkable
 *   -1..-199     Watched                 (leans Drakan)
 *   -200..-599  Tithe-Favored           (Drakan)
 *   -600..-1000 Oathbound of the Blood  (Drakan)
 *
 * Helping one side moves the needle toward it and AWAY from the other —
 * there is no fence-sitting, because there is only one needle. Tier doors
 * lock behind you: at Hollow-Trusted and above, Drakan's content shuts
 * (myrequeLocked); at Tithe-Favored and below, the Hollow shuts
 * (drakanLocked). Turning coat is possible but the world remembers
 * (`myreque:turncoat-at`, citizen gossip, both sides' cold lines).
 *
 * The track opens after "In Search of the Myreque" — that quest is the
 * on-ramp; this module is what comes next. Before it, the tithe-officer
 * will still take your coin (the tithe is just taxes until you know
 * better), but it can only sour you to -199.
 *
 * Out (custom events, AGENTS.md: plugins talk through events):
 *   (none — this module only listens)
 * In:
 *   kingdom:rumor { kingdomId, text }  (the realm hears tier crossings)
 *   kingdom:task-completed { player, kingdomId, task }
 *     — SunkenHollow's "sunken-hollow:vost" / "sunken-hollow:captive-saved"
 *       tasks award standing for the Hollow's avengers. (A future
 *       `myreque:vost-slain` emit is also honored, deduped by timestamp.)
 *
 * Data exports (Actors/Danger/SunkenHollow require this module):
 *   getStanding, addStanding, tierOf, TIERS, hasMetMyreque,
 *   myrequeLocked, drakanLocked, standingProse, titleFor, markDeed,
 *   hottestRival, usernameOf, isRealPlayer
 */

const Store = require("../kingdoms/KingdomStore");
const Tension = require("../kingdoms/Tension.Kingdoms");
const { getMemory } = require("../citizens/lib/CitizenMemory");

let api = null;

// --- attributes (kebab-case, namespaced — AGENTS.md rule 14) ----------------

const STANDING_ATTRIBUTE = "myreque:standing";
const TURNCOAT_ATTRIBUTE = "myreque:turncoat-at";

const PERSISTED = [
  STANDING_ATTRIBUTE,
  TURNCOAT_ATTRIBUTE,
  "myreque:tithe-at",
  "myreque:inform-at",
  "myreque:informed-once",
  "myreque:word-at",
  "myreque:carrying-word",
  "myreque:courier-kill-at",
  "myreque:cache-at",
  "myreque:token-sickle",
  "myreque:token-brand",
  "myreque:warned-at",
];

// --- tiers ------------------------------------------------------------------

const TIER_SWORN = "sworn";
const TIER_TRUSTED = "trusted";
const TIER_WHISPER = "whisper";
const TIER_NEUTRAL = "neutral";
const TIER_WATCHED = "watched";
const TIER_FAVORED = "favored";
const TIER_OATHBOUND = "oathbound";

const SWORN_AT = 600;
const TRUSTED_AT = 200;
const FAVORED_AT = -200;
const OATHBOUND_AT = -600;
const STANDING_MIN = -1000;
const STANDING_MAX = 1000;

const TIER_INFO = {
  [TIER_SWORN]: { name: "Sworn of the Hollow", side: "myreque", title: "Sworn of the Hollow" },
  [TIER_TRUSTED]: { name: "Hollow-Trusted", side: "myreque", title: null },
  [TIER_WHISPER]: { name: "Whisper-Friend", side: "myreque", title: null },
  [TIER_NEUTRAL]: { name: "Unremarkable", side: null, title: null },
  [TIER_WATCHED]: { name: "Watched", side: "drakan", title: null },
  [TIER_FAVORED]: { name: "Tithe-Favored", side: "drakan", title: null },
  [TIER_OATHBOUND]: { name: "Oathbound of the Blood", side: "drakan", title: "Oathbound of the Blood" },
};

const TIERS = Object.freeze({ ...TIER_INFO });

function tierOf(standing) {
  const s = Number(standing) || 0;
  if (s >= SWORN_AT) return TIER_SWORN;
  if (s >= TRUSTED_AT) return TIER_TRUSTED;
  if (s >= 1) return TIER_WHISPER;
  if (s <= OATHBOUND_AT) return TIER_OATHBOUND;
  if (s <= FAVORED_AT) return TIER_FAVORED;
  if (s <= -1) return TIER_WATCHED;
  return TIER_NEUTRAL;
}

function isRealPlayer(p) {
  return p?.isPlayer?.() === true && p?.isPlayerBot?.() !== true;
}

function usernameOf(player) {
  try {
    return String(player.getUsername?.() ?? "").toLowerCase();
  } catch {
    return "";
  }
}

function displayNameOf(player) {
  try {
    return String(player.getUsername?.() ?? "traveler");
  } catch {
    return "traveler";
  }
}

function getStanding(player) {
  const value = Number(player?.getAttribute?.(STANDING_ATTRIBUTE));
  if (!Number.isFinite(value)) return 0;
  return Math.max(STANDING_MIN, Math.min(STANDING_MAX, value | 0));
}

/** The player-facing title at the extreme tiers, else null. */
function titleFor(player) {
  const info = TIER_INFO[tierOf(getStanding(player))];
  return info?.title ?? null;
}

/** Myreque content shuts for the regime's friends. */
function myrequeLocked(player) {
  const tier = tierOf(getStanding(player));
  return tier === TIER_FAVORED || tier === TIER_OATHBOUND;
}

/** Drakan content shuts for the Hollow's friends. */
function drakanLocked(player) {
  const tier = tierOf(getStanding(player));
  return tier === TIER_TRUSTED || tier === TIER_SWORN;
}

// --- the quest gate -----------------------------------------------------------

let myrequeQuestHandle = null;

function myrequeQuest() {
  if (!myrequeQuestHandle) {
    try {
      // Quests register after this plugin (alphabetical load), so resolve lazily.
      const { getRegisteredQuests } = require("../quests/QuestRuntime");
      myrequeQuestHandle =
        (getRegisteredQuests() || []).find((q) => q.key === "in_search_of_the_myreque") || null;
    } catch {
      myrequeQuestHandle = null;
    }
  }
  return myrequeQuestHandle;
}

/** The reputation track opens after "In Search of the Myreque". */
function hasMetMyreque(player) {
  try {
    const quest = myrequeQuest();
    return !!quest && quest.isComplete(player) === true;
  } catch {
    return false;
  }
}

// --- world reactions ------------------------------------------------------------

function hottestRival() {
  try {
    const pairs = Tension.hottestPairs?.(12) ?? [];
    const hit = pairs.find((e) => e.a === "morytania" || e.b === "morytania");
    if (hit) return hit.a === "morytania" ? hit.b : hit.a;
  } catch {
    // fall through
  }
  return "kandarin"; // seeded hottest at 74
}

function emitRumor(kingdomId, text) {
  try {
    api?.emitCustomEvent("kingdom:rumor", { kingdomId, text });
  } catch {
    // cosmetic
  }
}

function nudgeTension(a, b, amount) {
  try {
    Tension.addTension(a, b, amount);
  } catch (error) {
    console.warn("[myreque] tension nudge failed", error?.message);
  }
}

/** Any citizen username of Morytania to seed a rumor with (online first). */
function morytaniaGossipSeed() {
  try {
    const { getDirector } = require("../citizens/director/CitizenDirector");
    const director = getDirector();
    if (!director) return "";
    const online = director.onlineBotsForKingdom?.("morytania") ?? [];
    if (online.length > 0) return online[0].getUsername?.() ?? "";
    for (const record of director.roster.values()) {
      if (record.kingdomId === "morytania") return record.username;
    }
  } catch {
    // citizens idle — the rumor still travels the realm
  }
  return "";
}

/**
 * A deed the streets should talk about, without a standing change:
 * citizen gossip (when the population is live) + a realm rumor.
 */
function markDeed(player, gossipText, rumorText) {
  const name = usernameOf(player);
  const display = displayNameOf(player);
  if (!name) return;
  try {
    const holder = morytaniaGossipSeed();
    if (holder) {
      getMemory().seedGossip({
        kingdomId: "morytania",
        kind: "rep",
        subject: name,
        subjectDisplay: display,
        text: String(gossipText ?? "").slice(0, 160),
        holder,
      });
    }
  } catch {
    // best-effort
  }
  if (rumorText) emitRumor("morytania", rumorText);
}

function swornCount() {
  try {
    return Number(Store.getKingdom("morytania")?.flags?.["morytania:myreque-sworn-count"]) || 0;
  } catch {
    return 0;
  }
}

function oathboundCount() {
  try {
    return Number(Store.getKingdom("morytania")?.flags?.["morytania:drakan-oathbound-count"]) || 0;
  } catch {
    return 0;
  }
}

function setSwornCount(n) {
  try {
    const count = Math.max(0, n | 0);
    Store.setFlag("morytania", "morytania:myreque-sworn-count", count);
    Store.setFlag("morytania", "morytania:myreque-sworn-walks", count > 0);
    Store.save();
  } catch {
    // best-effort
  }
}

function setOathboundCount(n) {
  try {
    const count = Math.max(0, n | 0);
    Store.setFlag("morytania", "morytania:drakan-oathbound-count", count);
    Store.setFlag("morytania", "morytania:drakan-oathbound-walks", count > 0);
    Store.save();
  } catch {
    // best-effort
  }
}

const MYREQUE_COMMITTED = new Set([TIER_TRUSTED, TIER_SWORN]);
const DRAKAN_COMMITTED = new Set([TIER_FAVORED, TIER_OATHBOUND]);

function onTierCross(player, oldTier, newTier) {
  const display = displayNameOf(player);
  const name = usernameOf(player);

  // The headcounts behind the street rumors.
  if (newTier === TIER_SWORN && oldTier !== TIER_SWORN) setSwornCount(swornCount() + 1);
  if (oldTier === TIER_SWORN && newTier !== TIER_SWORN) setSwornCount(swornCount() - 1);
  if (newTier === TIER_OATHBOUND && oldTier !== TIER_OATHBOUND) setOathboundCount(oathboundCount() + 1);
  if (oldTier === TIER_OATHBOUND && newTier !== TIER_OATHBOUND) setOathboundCount(oathboundCount() - 1);

  // Turning coat: committed to one side, now walking with the other.
  const wasMyreque = MYREQUE_COMMITTED.has(oldTier);
  const wasDrakan = DRAKAN_COMMITTED.has(oldTier);
  const nowMyreque = MYREQUE_COMMITTED.has(newTier) || newTier === TIER_WHISPER;
  const nowDrakan = DRAKAN_COMMITTED.has(newTier) || newTier === TIER_WATCHED;
  if ((wasMyreque && nowDrakan) || (wasDrakan && nowMyreque)) {
    try {
      player.setAttribute(TURNCOAT_ATTRIBUTE, Date.now());
    } catch {
      // best-effort
    }
    player.sendMessage(
      "You feel the weight of old oaths. Both sides will remember what you were."
    );
    markDeed(
      player,
      `${display} turned their coat — neither side trusts a turncoat.`,
      `Whispers in Canifis: ${display} turned their coat. The Hollow and the tithe both mark the name.`
    );
  }

  if (newTier === TIER_SWORN && oldTier !== TIER_SWORN) {
    player.sendMessage(
      "[Myreque] You are Sworn of the Hollow now. The cell's doors open to you — and the patrols will know your face."
    );
    markDeed(
      player,
      `${display} is Sworn of the Hollow — Lowerniel will have their head.`,
      `Word in the swamp: ${display} is Sworn of the Hollow. The regime's patrols have a new face to hunt.`
    );
    nudgeTension("morytania", hottestRival(), 2);
    player.sendMessage("The fence in the Mort Myre will have a token for you — ask him.");
  }
  if (newTier === TIER_TRUSTED && oldTier !== TIER_TRUSTED && oldTier !== TIER_SWORN) {
    player.sendMessage("[Myreque] The Hollow trusts you now. Its caches, its runners, its fences — yours.");
    markDeed(
      player,
      `the Myreque trusts ${display} now.`,
      null
    );
    player.sendMessage("The fence in the Mort Myre will have a token for you — ask him.");
  }
  if (oldTier === TIER_SWORN && newTier !== TIER_SWORN) {
    player.sendMessage("[Myreque] The Hollow's trust cools. The oath still binds, but thinner than before.");
  }
  if (newTier === TIER_OATHBOUND && oldTier !== TIER_OATHBOUND) {
    player.sendMessage(
      "[Drakan] You are Oathbound of the Blood. The patrols will let you pass — the Hollow never will."
    );
    markDeed(
      player,
      `${display} is Oathbound of the Blood — the tithe's own hound.`,
      `Fear in Canifis: ${display} is Oathbound of the Blood. Lowerniel's tithe has a new hound.`
    );
    nudgeTension("morytania", hottestRival(), 2);
    player.sendMessage("The tithe-officer in Canifis will have a brand for you — ask him.");
  }
  if (newTier === TIER_FAVORED && oldTier !== TIER_FAVORED && oldTier !== TIER_OATHBOUND) {
    player.sendMessage("[Drakan] The tithe favors you. Sarev's door is open, and his coin with it.");
    player.sendMessage("The tithe-officer in Canifis will have a brand for you — ask him.");
  }
  if (oldTier === TIER_OATHBOUND && newTier !== TIER_OATHBOUND) {
    player.sendMessage("[Drakan] The Blood's grip loosens. Sarev will not forget the lapse.");
  }
}

/**
 * Move the needle. Positive = toward the Myreque, negative = toward Drakan.
 * Tier crossings fire messages, rumors, gossip and tension nudges.
 */
function addStanding(player, delta, reason) {
  if (!player || !delta) return getStanding(player);
  const before = getStanding(player);
  const after = Math.max(STANDING_MIN, Math.min(STANDING_MAX, before + (delta | 0)));
  if (after === before) return after;
  try {
    player.setAttribute(STANDING_ATTRIBUTE, after);
  } catch {
    return before;
  }
  const oldTier = tierOf(before);
  const newTier = tierOf(after);
  if (oldTier !== newTier) {
    try {
      onTierCross(player, oldTier, newTier);
    } catch (error) {
      console.warn("[myreque] tier crossing failed", { reason, error: error?.message });
    }
  }
  return after;
}

/** The "How do I stand?" prose — diegetic, no numbers shown to players. */
function standingProse(player) {
  const tier = tierOf(getStanding(player));
  switch (tier) {
    case TIER_SWORN:
      return "Sworn of the Hollow. The cell would bleed for you — and the regime would bleed you. Walk Canifis carefully.";
    case TIER_TRUSTED:
      return "Trusted in the Hollow. Its caches open to you, its runners know your name. The tithe-officer would call it treason.";
    case TIER_WHISPER:
      return "A whisper-friend of the Myreque. They've marked you as one who might help — prove it, and the Hollow opens.";
    case TIER_WATCHED:
      return "Watched. The tithe's men have noticed your coin and your compliance. Nothing more — yet.";
    case TIER_FAVORED:
      return "Favored of the tithe. Sarev pays you well and asks little. The Hollow, if it knew your name, would close its doors.";
    case TIER_OATHBOUND:
      return "Oathbound of the Blood. The patrols salute you. The Myreque would put a stake through you given half a chance.";
    default:
      return "Unremarkable. Neither the Hollow nor the tithe has reason to know your name — for now.";
  }
}

// --- Sunken Hollow tie-in -------------------------------------------------------
// Vost's death is the Hollow's signature sabotage. SunkenHollow already
// emits kingdom:task-completed per participant ("sunken-hollow:vost",
// "sunken-hollow:captive-saved") — award standing on those. A future
// myreque:vost-slain emit is honored too; a timestamp dedupes double awards.

const VOST_AWARD_ATTRIBUTE = "myreque:vost-award-at";
const VOST_AWARD_DEDUPE_MS = 60 * 1000;

function awardVostKill(player, award, reason, message) {
  if (!player || !isRealPlayer(player)) return;
  const now = Date.now();
  let last = 0;
  try {
    last = Number(player.getAttribute(VOST_AWARD_ATTRIBUTE)) || 0;
  } catch {
    // best-effort
  }
  if (now - last < VOST_AWARD_DEDUPE_MS) return; // already honored this kill
  try {
    player.setAttribute(VOST_AWARD_ATTRIBUTE, now);
  } catch {
    // best-effort
  }
  addStanding(player, award, reason);
  player.sendMessage(message);
}

function onTaskCompleted(event) {
  const { player, task } = event ?? {};
  if (!player || !isRealPlayer(player)) return;
  if (task === "sunken-hollow:vost") {
    awardVostKill(
      player,
      100,
      "vost-slain",
      "[Myreque] Vost the Tithe-Taker is dead by your hand. The Hollow will remember this. (+100 standing)"
    );
  } else if (task === "sunken-hollow:captive-saved") {
    awardVostKill(
      player,
      50,
      "captive-saved",
      "[Myreque] You saved the Hollow's captive. Debts like that are never forgotten. (+50 standing)"
    );
  }
}

function onVostSlain(event) {
  const { participants } = event ?? {};
  for (const name of participants ?? []) {
    try {
      const p = api?.core?.World?.getPlayerByName?.(name);
      awardVostKill(
        p,
        100,
        "vost-slain",
        "[Myreque] Vost the Tithe-Taker is dead by your hand. The Hollow will remember this. (+100 standing)"
      );
    } catch {
      // best-effort per participant
    }
  }
}

// --- wiring -----------------------------------------------------------------------

function registerReputation(pluginApi) {
  api = pluginApi;
  for (const key of PERSISTED) api.persistAttribute(key);
  api.persistAttribute(VOST_AWARD_ATTRIBUTE);
  api.onCustomEvent("kingdom:task-completed", onTaskCompleted);
  api.onCustomEvent("myreque:vost-slain", onVostSlain);
  console.info("[myreque] reputation track live — one needle, no fence-sitting");
}

module.exports = registerReputation;
module.exports.getStanding = getStanding;
module.exports.addStanding = addStanding;
module.exports.tierOf = tierOf;
module.exports.TIERS = TIERS;
module.exports.TIER_SWORN = TIER_SWORN;
module.exports.TIER_TRUSTED = TIER_TRUSTED;
module.exports.TIER_WHISPER = TIER_WHISPER;
module.exports.TIER_NEUTRAL = TIER_NEUTRAL;
module.exports.TIER_WATCHED = TIER_WATCHED;
module.exports.TIER_FAVORED = TIER_FAVORED;
module.exports.TIER_OATHBOUND = TIER_OATHBOUND;
module.exports.hasMetMyreque = hasMetMyreque;
module.exports.myrequeLocked = myrequeLocked;
module.exports.drakanLocked = drakanLocked;
module.exports.standingProse = standingProse;
module.exports.titleFor = titleFor;
module.exports.markDeed = markDeed;
module.exports.hottestRival = hottestRival;
module.exports.usernameOf = usernameOf;
module.exports.isRealPlayer = isRealPlayer;
module.exports.STANDING_ATTRIBUTE = STANDING_ATTRIBUTE;
