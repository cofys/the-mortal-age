"use strict";

/**
 * SuccessionHunt.Kingdoms — STAGES 13-17: the young man surfaces, the backers'
 * trace, the claimed page, the disappearance, the second player.
 *
 * The interactive layer for the hunt. The trail went cold at stage 8 and
 * coiled at stage 12; these stages keep it coiled but moving — the world
 * keeps acting, and movement leaves marks. Same arc rules as every
 * succession layer (world bible, locked):
 * - The hidden bastard son is a PHASE 10 custom questline. This module NEVER
 *   resolves, never names the son, never confirms anything, and never touches
 *   the `misthalin:bastard-son-hidden` story flag.
 * - Nobody says "the king's bastard son" out loud. The truth stays one
 *   inference away. Everyone here has reasons — no mustache-twirling.
 *
 * What it does:
 *
 *   STAGE 13 — THE YOUNG MAN SURFACES (somewhere unexpected). The farm boy
 *   from stage 4 is gone from the Riverlands (stage 9) — and now sailors
 *   are talking about a lad with a farm accent working the Port Sarim
 *   docks, young, strong, quiet, looking over his shoulder. Could be
 *   anyone. Rare tavern overheards, never a claim.
 *
 *   STAGE 14 — THE BACKERS' TRACE (follow the money). The Merciful Hand
 *   pinned its charity-auction donors on Varrock's market board (a real
 *   cache object: Bank notice board 961, matched by location, not name).
 *   A long vellum list — and one name struck through in palace-green ink,
 *   too thoroughly to read. Below, a fresh hand: "the palace thanks its
 *   friends." Reading it grants the `auction-ledger` fragment once and
 *   raises heat (+6).
 *
 *   STAGE 15 — THE CLAIMED PAGE. Lives in SuccessionTrail.Kingdoms.js: the
 *   reward poster from stage 11 is claimed — "PAID AND COLLECTED" — and a
 *   shakier hand says the taker walked toward the palace quarter.
 *
 *   STAGE 16 — THE DISAPPEARANCE (someone knew too much). The drunk
 *   courtier from stage 1 — the one who slurred about "the king's heir" —
 *   hasn't been seen at the Blue Moon in a fortnight. His lodgings are let
 *   to a quiet man in grey. Nobody saw him leave. Nobody's asking. Rare
 *   tavern overheards, dread by absence.
 *
 *   STAGE 17 — THE SECOND PLAYER (who else is in the game). A second buyer
 *   for old paper has entered: not the Hand, a private man, plain clothes,
 *   paying in GOLD where the Hand pays silver. No charity, no questions,
 *   no face anyone remembers. An unsigned notice appears on Varrock's
 *   market board — but only players who've already dug deep (2+ fragments)
 *   recognize it for what it is; to everyone else it's just bills of fare.
 *   Reading it with understanding grants the `second-buyer` fragment once
 *   and raises heat (+8). Is he hunting the heir to find him — or to bury
 *   him? The arc doesn't say. The street doesn't know.
 *
 * In (custom events):
 *   (none — rumors and object interactions only)
 * Out (custom events):
 *   kingdom:rumor { kingdomId: "misthalin", text }
 *
 * Fragments (per-player `succession:fragments`, shared with Deep/Keepers/Trail):
 *   auction-ledger  — the Hand's donor list, one name struck out (board, stage 14+)
 *   second-buyer    — the unsigned gold-buyer notice (board, stage 17+, 2+ fragments)
 *
 * Numbers live in DESIGN.md.
 */

const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const { matchDiegetic } = require("../world/DiegeticObjects");
const { whisperStage } = require("./Succession.Kingdoms");
const {
  addSuccessionHeat,
  grantSuccessionFragment,
} = require("./SuccessionDeep.Kingdoms");

// Stage gates.
const STAGE_SURFACING = 13; // the young man, overheard in taverns
const STAGE_TRACE = 14; // the donor list on the market board
const STAGE_DISAPPEARED = 16; // the courtier is gone, overheard
const STAGE_SECOND_PLAYER = 17; // the gold buyer, overheard + board notice

const FRAGMENT_LEDGER = "auction-ledger";
const FRAGMENT_BUYER = "second-buyer";

// Heat for digging: paper trails and recognition, like the earlier fragments.
const HEAT_PAPER = 6;
const HEAT_DEEP = 8;

// Only diggers recognize the second buyer's notice for what it is.
const BUYER_MIN_FRAGMENTS = 2;

// Overhear sweep: ~20 minutes at 600ms/tick, matching the other layers.
const SWEEP_TICK_TICKS = 2000;
const SWEEP_CHANCE = 0.12;

let pluginApi = null;

// --- text ------------------------------------------------------------------
// ARC-SEED content. Oblique, deniable, never naming the son.

const SURFACING_OVERHEARD = [
  "Overheard from a sailor at the Rusty Anchor: \"Docks lad at Port Sarim, " +
    "fresh off a farm cart, couldn't be more'n thirty. Riverlands in his " +
    "voice, palace in his cheekbones — and you never heard me say that.\"",
  "Overheard at the market: \"Ship's boy at Port Sarim, they say. Young, " +
    "strong, quiet. Keeps a packed bag by his bunk and looks over his " +
    "shoulder when the gulls cry. Somebody taught that boy to run.\"",
];

const DISAPPEARED_OVERHEARD = [
  "Overheard in the Blue Moon, two men in low voices: \"He hasn't been seen " +
    "in a fortnight.\" \"Who?\" \"The courtier. The one with the loose tongue. " +
    "His room's let to a quiet man in grey. Nobody saw him leave.\"",
  "Overheard outside the Blue Moon: \"Ask about the courtier? I'd rather not. " +
    "Rooms turn over fast in this city, and some tenants don't pack.\"",
];

const BUYER_OVERHEARD = [
  "Overheard at the market: \"Second buyer for old paper now. Not the Hand — " +
    "a private man, plain clothes. Pays in gold where the Hand pays silver. " +
    "No face I remember. No questions I heard.\"",
  "Overheard in the Rusty Anchor: \"Gold for parish rolls. Gold! What kind of " +
    "man pays gold for dead names?\" \"The kind who doesn't want the Hand to " +
    "have them first, I'd wager.\"",
];

const LEDGER_LINES = [
  "A vellum sheet, pinned crooked to the market board:",
  "\"DONORS OF THE MERCIFUL HAND'S CHARITY AUCTION — the Hand thanks its " +
    "friends: House Drakan, the Fustian Guild, Widow Mell, the Salt Factors " +
    "of Port Sarim...\"",
  "Halfway down, one name is struck through in palace-green ink — struck " +
    "hard, three times, too thoroughly to read.",
  "Below the list, in a fresh hand: \"the palace thanks its friends.\"",
];

const LEDGER_GONE_TEXT =
  "Bills of fare, auction notices. The donor list is gone — taken down. You kept your copy.";

const BUYER_LINES = [
  "Pinned over the older notices, a fresh one — no seal, no signature:",
  "\"WANTED: old paper. Parish rolls, birth ledgers, anything with names, " +
    "thirty years or more. GOLD, not silver. No charity. No questions. Leave " +
    "word at the Rusty Anchor. Come alone.\"",
  "Someone has underlined GOLD twice. You know what this means — and you " +
    "wish you didn't.",
];

const BUYER_GONE_TEXT =
  "Bills of fare, auction notices. The unsigned one is gone. You kept your copy.";

const BOARD_LITTER_TEXT =
  "Pinned bills of fare, auction notices, a charity list. Nothing for you.";

// --- helpers ---------------------------------------------------------------

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

function fragmentCount(player) {
  try {
    const raw = player?.getAttribute?.("succession:fragments");
    return Array.isArray(raw) ? raw.length : 0;
  } catch {
    return 0;
  }
}

function pick(lines) {
  return lines[Math.floor(Math.random() * lines.length)];
}

// --- the market board: the donor list (stage 14), the buyer (stage 17) -----

/**
 * The market board at Varrock. From stage 14 it can hold the Merciful
 * Hand's auction donor list — one name struck through in palace-green ink.
 * From stage 17 the fresher paste takes precedence: the second buyer's
 * unsigned notice, gold not silver. Only players who've already dug deep
 * (2+ fragments) read it with understanding; to everyone else it's litter.
 * One fragment per player per document.
 */
function onObjectInteract(event) {
  const { player, objectId, location } = event ?? {};
  if (!player || player.isPlayerBot?.() === true) return false;
  let match = null;
  try {
    match = matchDiegetic(objectId, location, "board");
  } catch {
    return false;
  }
  if (!match) return false;
  if (match.capitalId !== "misthalin") {
    player.sendMessage(BOARD_LITTER_TEXT);
    return true;
  }

  const stage = whisperStage();

  // The second buyer's notice (stage 17+) — the freshest paste.
  if (stage >= STAGE_SECOND_PLAYER) {
    if (fragmentCount(player) < BUYER_MIN_FRAGMENTS) {
      player.sendMessage(BOARD_LITTER_TEXT);
      return true;
    }
    if (hasFragment(player, FRAGMENT_BUYER)) {
      player.sendMessage(BUYER_GONE_TEXT);
      return true;
    }
    for (const line of BUYER_LINES) {
      player.sendMessage(line);
    }
    grantSuccessionFragment(player, FRAGMENT_BUYER);
    addSuccessionHeat(player, HEAT_DEEP);
    console.info("[succession] hunt: buyer fragment granted", {
      player: player.getUsername(),
      fragment: FRAGMENT_BUYER,
    });
    return true;
  }

  // The donor list (stage 14+).
  if (stage >= STAGE_TRACE) {
    if (hasFragment(player, FRAGMENT_LEDGER)) {
      player.sendMessage(LEDGER_GONE_TEXT);
      return true;
    }
    for (const line of LEDGER_LINES) {
      player.sendMessage(line);
    }
    grantSuccessionFragment(player, FRAGMENT_LEDGER);
    addSuccessionHeat(player, HEAT_PAPER);
    console.info("[succession] hunt: ledger fragment granted", {
      player: player.getUsername(),
      fragment: FRAGMENT_LEDGER,
    });
    return true;
  }

  player.sendMessage(BOARD_LITTER_TEXT);
  return true;
}

// --- the hunt, overheard ----------------------------------------------------

/**
 * Rare ambient: the young man surfacing (stage 13), the courtier gone
 * (stage 16), the second buyer (stage 17). Never a claim — always talk
 * the street can't quite source.
 */
function overhearSweep() {
  try {
    const stage = whisperStage();
    if (stage >= STAGE_SECOND_PLAYER && Math.random() < SWEEP_CHANCE) {
      emitRumor(pick(BUYER_OVERHEARD));
      return;
    }
    if (stage >= STAGE_DISAPPEARED && Math.random() < SWEEP_CHANCE) {
      emitRumor(pick(DISAPPEARED_OVERHEARD));
      return;
    }
    if (stage >= STAGE_SURFACING && Math.random() < SWEEP_CHANCE) {
      emitRumor(pick(SURFACING_OVERHEARD));
    }
  } catch (error) {
    console.warn("[succession] hunt sweep failed", error?.message ?? error);
  }
}

function startSweeps(api) {
  class HuntTask extends Task {
    execute() {
      overhearSweep();
    }
  }
  api.getTaskManager()?.submit(new HuntTask(SWEEP_TICK_TICKS));
  console.info("[succession] hunt: sweeps armed", { tickTicks: SWEEP_TICK_TICKS });
}

// --- attach ----------------------------------------------------------------

function attachSuccessionHunt(api) {
  pluginApi = api;
  api.onObjectInteraction(onObjectInteract);
  startSweeps(api);
  console.info(
    "[succession] hunt armed — stages 13-17: the surfacing, the trace, the disappearance, the second player"
  );
}

module.exports = attachSuccessionHunt;
module.exports.attachSuccessionHunt = attachSuccessionHunt;
