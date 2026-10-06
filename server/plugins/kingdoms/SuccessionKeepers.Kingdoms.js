"use strict";

/**
 * SuccessionKeepers.Kingdoms — STAGES 5-8: who knows, who's hunting, the squeeze.
 *
 * The interactive layer for the escalation beats. Succession.Kingdoms plants
 * the stage 5-8 whispers; this module puts the people and the paper in the
 * world. Same arc rules as the seed and deep layers (world bible, locked):
 * - The hidden bastard son is a PHASE 10 custom questline. This module NEVER
 *   resolves, never names the son, never confirms anything, and never touches
 *   the `misthalin:bastard-son-hidden` story flag.
 * - Nobody says "the king's bastard son" out loud. The truth stays one
 *   inference away. Everyone here has reasons — no mustache-twirling.
 *
 * What it does:
 *
 *   THE KEEPER (stage 5 — who knows). Mara Hartley, the midwife's daughter,
 *   becomes a real citizen of Varrock: a named record in the CitizenDirector
 *   with a fixed name, personality, and schedule (market stall by day, tavern
 *   evenings, home at night). Her personality card carries her secret — her
 *   mother's birthing ledger, the page cut out with a knife, the grey men who
 *   came last winter asking after old patients — so the LLM mouth knows what
 *   she hides and that she deflects. She needs money. She will not sell her
 *   mother. Both things are true.
 *
 *   THE BRIBE (player agency). Talk to Mara about her mother's work and offer
 *   coin — money-words plus topic-words in chat heard by her — and she tells
 *   you about the cut page, once, privately. She takes half the coins and
 *   pushes half back. Digging raises `succession:heat` (+10), like asking
 *   about the heir. At heat 40+ she refuses like every other keeper; at
 *   stage 8 she is frightened and refuses everyone.
 *
 *   THE HUNT (stages 6-7 — who's hunting). Two new buyers in the market for
 *   old paper, both deniable, both one inference away from the throne:
 *   - The Merciful Hand: a charity buying up birth records — orphanage
 *     ledgers, parish rolls, anything with names. Whether it's gang money,
 *     palace money or Church money, nobody knows.
 *   - Black-plate men asking questions in a border town about a young man,
 *     thirty or so, farm-bred. They didn't say whose.
 *   The hunt is visible as rumors (stage whispers), as overheard street
 *   arguments (rare ambient), and as a paper trail: the Hand's dropped
 *   letter, readable in the discarded papers at Varrock market from stage 6.
 *
 *   THE LETTER (player agency). A diegetic "papers" object (cache Paper 7108)
 *   sits at every capital's market. In Varrock, from whisper stage 6, it
 *   holds the charity's half-trampled letter — a folded note about "the
 *   east-end rolls", "the missing pages", and "the cut page". Reading it
 *   grants the `charity-letter` fragment once and raises heat (+6).
 *
 *   THE SQUEEZE (stage 8). The street says the grey men came calling. Mara
 *   goes quiet — bribes refused, frightened, loyal to the end. The trail goes
 *   cold without resolving anything. The arc stays open for phase 10.
 *
 * In (custom events):
 *   citizens:chat-heard { citizenUsername, speakerUsername, text }
 * Out (custom events):
 *   kingdom:rumor { kingdomId: "misthalin", text }
 *
 * Fragments (per-player `succession:fragments`, shared with SuccessionDeep):
 *   mara-ledger     — Mara's story of the cut page (bribe, stage 5+)
 *   charity-letter  — the Merciful Hand's dropped letter (papers, stage 6+)
 *
 * Numbers live in DESIGN.md.
 */

const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const { matchDiegetic } = require("../world/DiegeticObjects");
const { whisperStage } = require("./Succession.Kingdoms");
const {
  successionHeat,
  addSuccessionHeat,
  grantSuccessionFragment,
} = require("./SuccessionDeep.Kingdoms");

// --- the keeper ------------------------------------------------------------

const MARA_NAME = "Mara Hartley";

const MARA_SPEC = {
  name: MARA_NAME,
  kingdomId: "misthalin",
  role: "merchant",
  traits: ["dutiful", "suspicious"],
  quirk: "counts coins twice before every trade",
  secret:
    "Thirty years ago your mother, the midwife Goodwife Hartley, delivered a " +
    "child she never speaks of — one birth with its page cut from her ledger. " +
    "Last winter, grey men came asking after her old patients. Your mother is " +
    "frightened; you are trying to be brave for both of you. You need the money, " +
    "but you will not sell your mother.",
  sleepStart: 23,
  sleepHours: 7,
};

// Stage gates.
const STAGE_KEEPER = 5; // Mara's bribe path opens
const STAGE_LETTER = 6; // the charity's letter appears in the papers
const STAGE_OVERHEARD = 7; // overheard arguments about the hunt
const STAGE_SQUEEZE = 8; // Mara goes quiet; the trail goes cold

// Bribe detection: money-words AND topic-words in chat Mara hears.
const MONEY_WORDS = [
  "coin",
  "coins",
  "gp",
  "gold",
  "silver",
  "pay",
  "paid",
  "paying",
  "money",
  "buy",
  "bought",
];
const TOPIC_WORDS = [
  "mother",
  "midwife",
  "birth",
  "born",
  "baby",
  "ledger",
  "records",
  "patient",
  "patients",
  "delivered",
  "goodwife",
];

const FRAGMENT_MARA = "mara-ledger";
const FRAGMENT_LETTER = "charity-letter";

// Heat for digging: bribes and found letters, like asking about the heir.
const HEAT_BRIBE = 10;
const HEAT_LETTER = 6;
// Heat at which keepers refuse (mirrors SuccessionDeep).
const HEAT_REFUSE = 40;

// Overhear sweep: ~20 minutes at 600ms/tick.
const OVERHEAR_TICK_TICKS = 2000;
const OVERHEAR_CHANCE = 0.15;

let pluginApi = null;

// --- text ------------------------------------------------------------------
// ARC-SEED content. Oblique, deniable, never naming the son.

const MARA_BRIBE_TEXT = [
  "She doesn't look at the coins. Then she does.",
  "\"My mother's ledger. Thirty years of births — every babe she caught in this city. " +
    "There's a page — was a page — cut out with a knife, clean as surgery. She keeps " +
    "what's left of it in her wedding chest and cries when she thinks I can't hear. " +
    "Last winter grey men came asking after her old patients. I told them nothing.\"",
  "She pushes half the coins back across the stall. \"Take those. If they come for me " +
    "too, I want to be able to say I never sold her.\"",
];

const MARA_REFUSE_TEXT =
  "Her face closes. \"Not here. Not for any price. Walk away, friend.\"";

const MARA_SQUEEZE_TEXT =
  "She shakes her head without looking up. \"They came to the house, friend. " +
  "My mother won't open the door anymore. Please. Leave us alone.\"";

const MARA_SPENT_TEXT =
  "\"I told you what I know. There's no more. Please — buy some feverfew and go.\"";

const LETTER_LINES = [
  "You smooth out a half-trampled letter. The seal is broken — a hand clutching a coin.",
  "\"Matron — The Hand thanks you for the east-end rolls. Thirty years of names is a " +
    "heavy box, and we lift it gladly. Do not trouble yourself over the missing pages; " +
    "we pay for what is delivered, not for what is lost. Burn this. — S.\"",
  "Below, in a different hand, hurried: \"she asked after the cut page again. Told her it was never there.\"",
];

const LETTER_GONE_TEXT =
  "More rain-spoiled tallies and market lists. The letter is gone — you pocketed it days ago.";

const PAPERS_LITTER_TEXT =
  "Discarded market tallies and bills of lading, rain-spoiled. Nothing worth keeping.";

const OVERHEARD_LINES = [
  "Overheard outside the Blue Moon, two men arguing in low voices: \"—paying double " +
    "for parish rolls now.\" \"Double? What's in old paper worth double?\" \"Don't. The Hand pays, we don't ask.\"",
  "Overheard at the market: \"Black plate, down the south road. Asking after farm lads, " +
    "thirty-ish, with—\" \"With what?\" \"Wouldn't say. Just walked on.\"",
  "Overheard by the east gate: \"The orphanage matron sold thirty years of ledgers to " +
    "that charity.\" \"The Merciful Hand?\" \"Aye. Silver for paper. What kind of charity " +
    "buys names?\"",
];

const CHARITY_SIGHTING_LINES = [
  "The Merciful Hand's clerk was seen paying a churchwarden for a box of old parish rolls.",
  "A woman in a grey habit bought an orphanage's whole ledger shelf — paid in silver, asked no questions.",
];

// --- helpers ---------------------------------------------------------------

function getDirector() {
  try {
    const { getDirector } = require("../citizens/director/CitizenDirector");
    return getDirector() ?? null;
  } catch {
    return null;
  }
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

function hasFragment(player, fragmentId) {
  try {
    const raw = player?.getAttribute?.("succession:fragments");
    return Array.isArray(raw) && raw.includes(fragmentId);
  } catch {
    return false;
  }
}

function containsWord(text, words) {
  const lower = String(text ?? "").toLowerCase();
  return words.some((w) => lower.includes(w));
}

// --- the keeper ------------------------------------------------------------

/**
 * Mara Hartley joins Varrock's citizen roster: a fixed name, a fixed
 * personality, a fixed schedule. The director's tick spawns her, works her
 * and sleeps her like anyone else. Retried once if the director isn't up
 * yet (plugin order); skipped quietly if citizens are disabled.
 */
function ensureKeeper() {
  const director = getDirector();
  if (!director) {
    console.warn("[succession] keepers: no citizen director yet, will retry once");
    return false;
  }
  if (director.roster.has(MARA_NAME)) return true;
  const record = director.addNamedCitizen(MARA_SPEC);
  if (record) {
    console.info("[succession] keepers: Mara Hartley joined Varrock", {
      role: record.role,
      home: record.home,
    });
  }
  return !!record;
}

function ensureKeeperRetry() {
  class KeeperRetryTask extends Task {
    execute() {
      try {
        ensureKeeper();
      } finally {
        this.stop?.();
      }
    }
  }
  // ~5 minutes at 600ms/tick — one retry, then the director's tick owns her.
  pluginApi.getTaskManager()?.submit(new KeeperRetryTask(500));
}

/**
 * A player talked near Mara about her mother's work and offered coin.
 * Money tempts her; loyalty holds her; at stage 8 fear wins.
 */
function onMaraBribe({ player }) {
  if (!player || player.isPlayerBot?.() === true) return;
  const stage = whisperStage();

  // The squeeze: she is frightened and refuses everyone.
  if (stage >= STAGE_SQUEEZE) {
    player.sendMessage(MARA_SQUEEZE_TEXT);
    return;
  }

  // Heat 40+: keepers refuse, like the deep layer's archetypes.
  if (successionHeat(player) >= HEAT_REFUSE) {
    player.sendMessage(MARA_REFUSE_TEXT);
    return;
  }

  if (hasFragment(player, FRAGMENT_MARA)) {
    player.sendMessage(MARA_SPENT_TEXT);
    return;
  }

  // The bribe lands: half the coins back, the story out, heat up.
  for (const line of MARA_BRIBE_TEXT) {
    player.sendMessage(line);
  }
  grantSuccessionFragment(player, FRAGMENT_MARA);
  addSuccessionHeat(player, HEAT_BRIBE);
  console.info("[succession] keepers: bribe fragment granted", {
    player: player.getUsername(),
    fragment: FRAGMENT_MARA,
  });
}

function onChatHeard(event) {
  try {
    const { citizenUsername, speakerUsername, text } = event ?? {};
    if (!citizenUsername || !speakerUsername || !text) return;
    if (citizenUsername !== MARA_NAME) return;
    if (whisperStage() < STAGE_KEEPER) return;
    if (!containsWord(text, MONEY_WORDS)) return;
    if (!containsWord(text, TOPIC_WORDS)) return;
    const player = findPlayer(speakerUsername);
    if (!player || player.isPlayerBot?.() === true) return;
    onMaraBribe({ player });
  } catch (error) {
    // The arc must never break chat.
    console.warn("[succession] keepers chat failed", error?.message ?? error);
  }
}

// --- the letter ------------------------------------------------------------

/**
 * The discarded papers at each capital's market. In Varrock, from stage 6,
 * they hold the Merciful Hand's dropped letter. Elsewhere — and before
 * stage 6 — they're just rain-spoiled litter.
 */
function onObjectInteract(event) {
  const { player, objectId, location } = event ?? {};
  if (!player || player.isPlayerBot?.() === true) return false;
  let match = null;
  try {
    match = matchDiegetic(objectId, location, "papers");
  } catch {
    return false;
  }
  if (!match) return false;

  if (match.capitalId !== "misthalin" || whisperStage() < STAGE_LETTER) {
    player.sendMessage(PAPERS_LITTER_TEXT);
    return true;
  }
  if (hasFragment(player, FRAGMENT_LETTER)) {
    player.sendMessage(LETTER_GONE_TEXT);
    return true;
  }
  for (const line of LETTER_LINES) {
    player.sendMessage(line);
  }
  grantSuccessionFragment(player, FRAGMENT_LETTER);
  addSuccessionHeat(player, HEAT_LETTER);
  console.info("[succession] keepers: letter fragment granted", {
    player: player.getUsername(),
    fragment: FRAGMENT_LETTER,
  });
  return true;
}

// --- the hunt, overheard ----------------------------------------------------

/**
 * Rare ambient: the hunt made audible. Overheard arguments about the Hand's
 * prices, black-plate men on the south road — never a claim, always a
 * question the street can't answer.
 */
function overhearSweep() {
  try {
    if (whisperStage() < STAGE_OVERHEARD) return;
    if (Math.random() >= OVERHEAR_CHANCE) return;
    const line = OVERHEARD_LINES[Math.floor(Math.random() * OVERHEARD_LINES.length)];
    emitRumor(line);
  } catch (error) {
    console.warn("[succession] keepers sweep failed", error?.message ?? error);
  }
}

/** The charity's paper-buying, seen in the world from stage 6. */
function charitySightingSweep() {
  try {
    if (whisperStage() < STAGE_LETTER) return;
    if (Math.random() >= OVERHEAR_CHANCE / 2) return;
    const line =
      CHARITY_SIGHTING_LINES[Math.floor(Math.random() * CHARITY_SIGHTING_LINES.length)];
    emitRumor(line);
  } catch (error) {
    console.warn("[succession] keepers sweep failed", error?.message ?? error);
  }
}

function startSweeps(api) {
  class KeepersTask extends Task {
    execute() {
      overhearSweep();
      charitySightingSweep();
    }
  }
  api.getTaskManager()?.submit(new KeepersTask(OVERHEAR_TICK_TICKS));
  console.info("[succession] keepers: sweeps armed", { tickTicks: OVERHEAR_TICK_TICKS });
}

// --- attach ----------------------------------------------------------------

function attachSuccessionKeepers(api) {
  pluginApi = api;
  api.onCustomEvent("citizens:chat-heard", onChatHeard);
  api.onObjectInteraction(onObjectInteract);
  if (!ensureKeeper()) {
    ensureKeeperRetry();
  }
  startSweeps(api);
  console.info("[succession] keepers armed — stages 5-8: the keeper, the hunt, the squeeze");
}

module.exports = attachSuccessionKeepers;
module.exports.attachSuccessionKeepers = attachSuccessionKeepers;
