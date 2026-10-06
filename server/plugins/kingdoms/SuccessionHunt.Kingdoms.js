"use strict";

/**
 * SuccessionHunt.Kingdoms — STAGES 13-22: the young man surfaces, the backers'
 * trace, the claimed page, the disappearance, the second player — then the
 * hunt escalates: the confrontation, the flight, the struck name, the bidding
 * war, the quay.
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
 *   STAGE 18 — THE CONFRONTATION (the agents cross paths). The two buyers'
 *   men come to blows over the same informant: a grey man and a plain-
 *   dressed man, both flashing coin at one dock clerk in the Rusty Anchor.
 *   The clerk takes neither — and is gone by morning. Rare overheards;
 *   the street understands these men are hunting each other now.
 *
 *   STAGE 19 — THE FLIGHT (the young man runs). The lad's bunk at Port
 *   Sarim is empty; the harbormaster took double fare off a young man at
 *   midnight, no name, no questions. Somebody warned that boy — or somebody
 *   bought him a ticket. Rare overheards; the docks feel watched.
 *
 *   STAGE 20 — THE STRUCK NAME (who pulled out, and why). The donor list is
 *   re-pinned, reprinted — and the struck-through name is simply GONE, as if
 *   it never existed. The fresh hand now reads "the palace thanks its LOYAL
 *   friends." Overheards name the leaver: the Fustian Guild pulled its gold
 *   the week the palace leaned on the auction — and the factor's son just
 *   took a palace post. Reading the reprinted list grants the `struck-donor`
 *   fragment once and raises heat (+8).
 *
 *   STAGE 21 — THE BIDDING WAR (neither side blinks). Old paper's worth
 *   triple; the gold buyer doubled his offer and the Hand is matching coin
 *   for coin. A fresh paste covers the board: GOLD DOUBLED, no charity, no
 *   questions. Clerks are getting rich and getting frightened; one scribe
 *   fled Varrock. Only diggers (2+ fragments) read it with understanding —
 *   to everyone else it's bills of fare. Reading it grants the `bidding-war`
 *   fragment once and raises heat (+8).
 *
 *   STAGE 22 — THE QUAY (bought, or taken?). A sailor swears the farm lad
 *   clasped hands with a man in grey on the midnight quay — once, never
 *   twice. After that, the street goes quiet: nobody talks about the docks
 *   anymore, and the tavern goes silent when you ask. Rare overheards at a
 *   reduced rate; the silence itself is the dread.
 *
 * In (custom events):
 *   (none — rumors and object interactions only)
 * Out (custom events):
 *   kingdom:rumor { kingdomId: "misthalin", text }
 *
 * Fragments (per-player `succession:fragments`, shared with Deep/Keepers/Trail):
 *   auction-ledger  — the Hand's donor list, one name struck out (board, stage 14+)
 *   second-buyer    — the unsigned gold-buyer notice (board, stage 17+, 2+ fragments)
 *   struck-donor    — the reprinted list, the name gone, "LOYAL friends" (board, stage 20+)
 *   bidding-war     — the doubled-gold notice, neither side blinking (board, stage 21+, 2+ fragments)
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
const STAGE_CONFRONTATION = 18; // the two buyers' men cross paths, overheard
const STAGE_FLIGHT = 19; // the young man runs, overheard
const STAGE_STRUCK_NAME = 20; // the reprinted donor list, overheard + board
const STAGE_BIDDING_WAR = 21; // the doubled-gold notice, overheard + board
const STAGE_QUAY = 22; // the midnight handshake, overheard, then silence

const FRAGMENT_LEDGER = "auction-ledger";
const FRAGMENT_BUYER = "second-buyer";
const FRAGMENT_STRUCK = "struck-donor";
const FRAGMENT_WAR = "bidding-war";

// Heat for digging: paper trails and recognition, like the earlier fragments.
const HEAT_PAPER = 6;
const HEAT_DEEP = 8;

// Only diggers recognize the second buyer's notice for what it is.
const BUYER_MIN_FRAGMENTS = 2;

// Overhear sweep: ~20 minutes at 600ms/tick, matching the other layers.
// After the quay (stage 22) the street goes quiet — the sweep runs half as
// often, and half of what slips through is the silence itself.
const SWEEP_TICK_TICKS = 2000;
const SWEEP_CHANCE = 0.12;
const QUAY_SILENCE_FACTOR = 0.5;

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

const CONFRONTATION_OVERHEARD = [
  "Overheard in the Rusty Anchor: \"Two men near came to blows last night — " +
    "one grey, one plain-dressed, both flashing coin at the same dock clerk. " +
    "The clerk took neither. He's gone this morning. Vanished.\"",
  "Overheard at the market: \"The gold man and the grey men want the same " +
    "paper now. There's going to be blood, or a wedding of purses. Either way, " +
    "the clerks get paid.\"",
];

const FLIGHT_OVERHEARD = [
  "Overheard from a sailor: \"The farm lad's bunk is empty. Harbormaster took " +
    "double fare off a young man at midnight — no name, no cargo, no questions. " +
    "Ran like the tide was after him.\"",
  "Overheard in the Rusty Anchor: \"Somebody warned that boy. Packed bag, " +
    "midnight ship — you don't move like that unless you know the hounds " +
    "are out.\"",
];

const STRUCK_OVERHEARD = [
  "Overheard at the market: \"The Fustian Guild pulled its gold from the Hand " +
    "— same week the palace man leaned on the auction. And their factor's son " +
    "just took a palace post. Loyalty has a price, and the palace pays it.\"",
  "Overheard in the Blue Moon: \"You saw the new list? One name clean gone. " +
    "Not struck — erased. 'The palace thanks its LOYAL friends.' Read that " +
    "however you like.\"",
];

const BIDDING_OVERHEARD = [
  "Overheard at the market: \"Old paper's worth triple. The gold man's doubled " +
    "his offer, and the Hand is matching coin for coin. The clerks are getting " +
    "rich and getting frightened in equal measure.\"",
  "Overheard in the Rusty Anchor: \"Scribe over in Varrock quit his post, " +
    "took the first cart south. Wouldn't say why. Wouldn't look back. Paper's " +
    "a dangerous trade now.\"",
];

const QUAY_OVERHEARD = [
  "Overheard from a sailor, once, never twice: \"Saw the farm lad on the " +
    "midnight quay. Clasped hands with a man in grey. Bought, or taken — you " +
    "tell me. I'm done talking about it.\"",
];

const QUAY_SILENCE = [
  "Nobody talks about the docks anymore. Ask, and the tavern goes quiet — " +
    "the kind of quiet that has a price on it.",
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

const STRUCK_LINES = [
  "A fresh paste covers the older notices — the Merciful Hand's donor list, " +
    "reprinted clean:",
  "\"THE HAND THANKS ITS FRIENDS: House Drakan, Widow Mell, the Salt Factors " +
    "of Port Sarim...\"",
  "The list is shorter than you remember. One name is simply gone — no ink, " +
    "no strike, as if it had never been there at all.",
  "Below, in a fresh hand: \"the palace thanks its LOYAL friends.\"",
];

const STRUCK_GONE_TEXT =
  "Bills of fare, auction notices. The reprinted list is gone. You kept your copy.";

const WAR_LINES = [
  "A fresh paste, no seal, no signature — the same hand as the gold buyer's notice:",
  "\"WANTED: old paper. Parish rolls, birth ledgers, anything with names, " +
    "thirty years or more. GOLD DOUBLED. No charity. No questions. Rusty " +
    "Anchor. Come alone. Tell no one.\"",
  "Underneath, in charcoal, someone has written: \"two buyers now, and neither " +
    "one blinks.\" You know what this means — and you wish you didn't.",
];

const WAR_GONE_TEXT =
  "Bills of fare, auction notices. The doubled notice is gone. You kept your copy.";

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
 * The market board at Varrock. The freshest paste takes precedence:
 * - stage 21+: the second buyer's notice, gold doubled — only diggers (2+
 *   fragments) read it with understanding; `bidding-war` fragment once, +8 heat
 * - stage 20: the reprinted donor list, one name erased, "LOYAL friends" —
 *   `struck-donor` fragment once, +8 heat
 * - stage 17+: the second buyer's unsigned notice, gold not silver —
 *   `second-buyer` fragment once, +8 heat, 2+ fragments to recognize
 * - stage 14+: the Hand's donor list, one name struck through — `auction-ledger`
 *   fragment once, +6 heat
 * One fragment per player per document. Other capitals' boards are litter.
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
  const logFragment = (fragment, heat) =>
    console.info("[succession] hunt: fragment granted", {
      player: player.getUsername(),
      fragment,
      heat,
    });

  // The bidding war's doubled-gold notice (stage 21+) — the freshest paste.
  if (stage >= STAGE_BIDDING_WAR) {
    if (fragmentCount(player) < BUYER_MIN_FRAGMENTS) {
      player.sendMessage(BOARD_LITTER_TEXT);
      return true;
    }
    if (hasFragment(player, FRAGMENT_WAR)) {
      player.sendMessage(WAR_GONE_TEXT);
      return true;
    }
    for (const line of WAR_LINES) {
      player.sendMessage(line);
    }
    grantSuccessionFragment(player, FRAGMENT_WAR);
    addSuccessionHeat(player, HEAT_DEEP);
    logFragment(FRAGMENT_WAR, HEAT_DEEP);
    return true;
  }

  // The reprinted donor list (stage 20) — the name simply gone.
  if (stage >= STAGE_STRUCK_NAME) {
    if (hasFragment(player, FRAGMENT_STRUCK)) {
      player.sendMessage(STRUCK_GONE_TEXT);
      return true;
    }
    for (const line of STRUCK_LINES) {
      player.sendMessage(line);
    }
    grantSuccessionFragment(player, FRAGMENT_STRUCK);
    addSuccessionHeat(player, HEAT_DEEP);
    logFragment(FRAGMENT_STRUCK, HEAT_DEEP);
    return true;
  }

  // The second buyer's notice (stage 17+) — the freshest paste before the war.
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
    logFragment(FRAGMENT_BUYER, HEAT_DEEP);
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
    logFragment(FRAGMENT_LEDGER, HEAT_PAPER);
    return true;
  }

  player.sendMessage(BOARD_LITTER_TEXT);
  return true;
}

// --- the hunt, overheard ----------------------------------------------------

/**
 * Rare ambient: the young man surfacing (stage 13), the courtier gone
 * (stage 16), the second buyer (stage 17), the confrontation (stage 18),
 * the flight (stage 19), the struck name (stage 20), the bidding war
 * (stage 21), the quay (stage 22). Never a claim — always talk
 * the street can't quite source. Highest stage first; the board follows
 * the same precedence.
 */
function overhearSweep() {
  try {
    const stage = whisperStage();
    if (stage >= STAGE_QUAY && Math.random() < SWEEP_CHANCE * QUAY_SILENCE_FACTOR) {
      emitRumor(Math.random() < 0.5 ? pick(QUAY_OVERHEARD) : pick(QUAY_SILENCE));
      return;
    }
    if (stage >= STAGE_BIDDING_WAR && Math.random() < SWEEP_CHANCE) {
      emitRumor(pick(BIDDING_OVERHEARD));
      return;
    }
    if (stage >= STAGE_STRUCK_NAME && Math.random() < SWEEP_CHANCE) {
      emitRumor(pick(STRUCK_OVERHEARD));
      return;
    }
    if (stage >= STAGE_FLIGHT && Math.random() < SWEEP_CHANCE) {
      emitRumor(pick(FLIGHT_OVERHEARD));
      return;
    }
    if (stage >= STAGE_CONFRONTATION && Math.random() < SWEEP_CHANCE) {
      emitRumor(pick(CONFRONTATION_OVERHEARD));
      return;
    }
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
    "[succession] hunt armed — stages 13-22: the surfacing, the trace, the disappearance, " +
      "the second player, the confrontation, the flight, the struck name, the bidding war, the quay"
  );
}

module.exports = attachSuccessionHunt;
module.exports.attachSuccessionHunt = attachSuccessionHunt;
