"use strict";

/**
 * SuccessionTrail.Kingdoms — STAGES 9-12 + 15: the empty farm, the Hand's
 * coin, the ledger page, the warning, the claimed page.
 *
 * The trail went cold at stage 8 (the squeeze — Mara silent, the grey men
 * came calling). These stages pick it back up, colder and more dangerous.
 * Same arc rules as every succession layer (world bible, locked):
 * - The hidden bastard son is a PHASE 10 custom questline. This module NEVER
 *   resolves, never names the son, never confirms anything, and never touches
 *   the `misthalin:bastard-son-hidden` story flag.
 * - Nobody says "the king's bastard son" out loud. The truth stays one
 *   inference away. Everyone here has reasons — no mustache-twirling.
 *
 * What it does:
 *
 *   STAGE 9 — THE EMPTY FARM (the hunted young man). The farm from stage 4
 *   (the Riverlands farm that pays no taxes, where the boy with the king's
 *   eyes was seen) stands empty. A neighbor's letter, found in the Varrock
 *   papers, tells it: cold hearth, door swinging, a child's wooden sword on
 *   the table. Gone in the night. He's running.
 *
 *   STAGE 10 — THE HAND'S COIN (the Hand's true backers). The Merciful Hand
 *   held a charity auction. Half of Varrock's merchant houses bought tables —
 *   and the palace sent a representative nobody bid against. Follow the money
 *   and it walks back toward the throne. Overheard in taverns, never written
 *   down (the Hand learned about letters).
 *
 *   STAGE 11 — THE LEDGER PAGE (the ledger page). The cut page surfaces —
 *   not the ledger, just the one page, and it's in the wrong hands. A reward
 *   poster in the Varrock papers offers a fortune for "a single leaf of
 *   vellum, a birth record, corner torn." Someone knows what it's worth.
 *   Someone else wants it first.
 *
 *   STAGE 12 — THE WARNING (the coil). The grey men stop asking questions
 *   and start watching. Players who dug deep (2+ fragments, heat 50+) get a
 *   visit: "Some stones are better left unturned." Dread, never damage.
 *   The arc coils. Phase 10 will uncoil it.
 *
 *   STAGE 15 — THE CLAIMED PAGE (the hunt, SuccessionHunt.Kingdoms.js's
 *   era). The reward poster from stage 11 is gone — claimed. What's pasted
 *   over its ghost says "PAID AND COLLECTED," and a shakier hand says the
 *   taker walked toward the palace quarter. The page moved. Someone paid.
 *   Someone is owed.
 *
 * In (custom events):
 *   citizens:chat-heard { citizenUsername, speakerUsername, text }
 * Out (custom events):
 *   kingdom:rumor { kingdomId: "misthalin", text }
 *
 * Fragments (per-player `succession:fragments`, shared with Deep + Keepers):
 *   empty-farm        — the neighbor's letter (papers, stage 9+)
 *   auction-whispers  — what the taverns say about the Hand's auction (overheard, stage 10+)
 *   fence-posting     — the reward poster for the ledger page (papers, stage 11+)
 *   page-claimed      — the claimed poster (papers, stage 15+)
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

// Stage gates.
const STAGE_FARM = 9; // the neighbor's letter appears in the papers
const STAGE_COIN = 10; // auction gossip in the overhear pool
const STAGE_PAGE = 11; // the reward poster appears in the papers
const STAGE_WARNING = 12; // the grey men visit the diggers
const STAGE_CLAIMED = 15; // the poster is claimed; the page moved

const FRAGMENT_FARM = "empty-farm";
const FRAGMENT_AUCTION = "auction-whispers";
const FRAGMENT_POSTING = "fence-posting";
const FRAGMENT_CLAIMED = "page-claimed";

// Heat for digging: paper trails and tavern talk, like the earlier fragments.
const HEAT_PAPER = 6;
const HEAT_OVERHEARD = 8;

// Warning: players this deep get the visit.
const WARNING_MIN_FRAGMENTS = 2;
const WARNING_MIN_HEAT = 50;
const WARNING_ATTRIBUTE = "succession:warned-12";

let pluginApi = null;

// --- text ------------------------------------------------------------------
// ARC-SEED content. Oblique, deniable, never naming the son.

const FARM_LINES = [
  "You unfold a neighbor's letter, rain-spotted, left among the market papers.",
  "\"—and the farm stands empty, Maren. Cold hearth, door swinging in the wind. " +
    "A child's wooden sword on the table, like someone left mid-play. The tax man " +
    "came twice and found nothing to count. Whatever they were running from, " +
    "they're running still. Burn this. — T.\"",
];

const FARM_GONE_TEXT =
  "More rain-spoiled tallies. The neighbor's letter is gone — you pocketed it days ago.";

const POSTING_LINES = [
  "A reward poster, fresh paste, half-covering a market tally:",
  "\"WANTED: a single leaf of vellum, a birth record some thirty years old, " +
    "corner torn where it was cut from its book. Discretion assured. Reward " +
    "beyond a craftsman's yearly wage. Inquire at the sign of the Rusty Anchor, " +
    "ask for no one. Come alone.\"",
  "Below, in charcoal, someone has scrawled: \"it was here Tuesday. it isn't now.\"",
];

const POSTING_GONE_TEXT =
  "The reward poster is gone — torn down, or weather took it. You kept your copy.";

const CLAIMED_LINES = [
  "The reward poster is gone — but something new is pasted over its ghost, " +
    "the paste still tacky:",
  "\"PAID AND COLLECTED. The leaf of vellum is claimed. The Merciful Hand " +
    "thanks the discreet. Inquire no further.\"",
  "The old charcoal scrawl — \"it was here Tuesday. it isn't now.\" — has " +
    "been scratched out. Beneath it, in a shakier hand: \"grey cloak. he " +
    "took it toward the palace quarter. gods help the seller.\"",
];

const CLAIMED_GONE_TEXT =
  "The claimed notice is weather-stained now. You kept your copy.";

const AUCTION_OVERHEARD = [
  "Overheard in the Blue Moon, a merchant too deep in his cups: \"The Hand's " +
    "auction, aye — silver plate, old tapestries. Half the merchant houses " +
    "bought tables. And the palace sent a man. Nobody — nobody — bid against " +
    "him. What kind of charity has the palace bidding at its auction?\"",
  "Overheard at the market: \"You hear what the Merciful Hand's auction raised? " +
    "Enough to buy the street. And who do you think underwrote it? Follow the " +
    "silver, love. It always walks uphill.\"",
];

const WARNING_LINES = [
  "A grey man is waiting by your shoulder. You didn't see him arrive.",
  "\"You've been asking questions,\" he says, pleasantly. \"About old births. " +
    "About missing pages. About farms.\" He smiles. \"Some stones are better " +
    "left unturned, friend. For your sake. For your mother's sake.\"",
  "He's gone before you think to answer. You don't sleep well that night.",
];

const PAPERS_LITTER_TEXT =
  "Discarded market tallies and bills of lading, rain-spoiled. Nothing worth keeping.";

// --- helpers ---------------------------------------------------------------

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

function fragmentCount(player) {
  try {
    const raw = player?.getAttribute?.("succession:fragments");
    return Array.isArray(raw) ? raw.length : 0;
  } catch {
    return 0;
  }
}

// --- the papers: farm letter (stage 9), reward poster (stage 11) ------------

/**
 * The discarded papers at Varrock market. From stage 9 they can hold the
 * neighbor's letter about the empty farm; from stage 11, the reward poster
 * for the ledger page; from stage 15, the claimed-poster notice that
 * replaced it. One fragment per player per document.
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
  if (match.capitalId !== "misthalin") {
    player.sendMessage(PAPERS_LITTER_TEXT);
    return true;
  }

  const stage = whisperStage();

  // The claimed poster (stage 15+) takes precedence — the freshest paste.
  if (stage >= STAGE_CLAIMED) {
    if (hasFragment(player, FRAGMENT_CLAIMED)) {
      player.sendMessage(CLAIMED_GONE_TEXT);
      return true;
    }
    for (const line of CLAIMED_LINES) {
      player.sendMessage(line);
    }
    grantSuccessionFragment(player, FRAGMENT_CLAIMED);
    addSuccessionHeat(player, HEAT_PAPER);
    console.info("[succession] trail: claimed-page fragment granted", {
      player: player.getUsername(),
      fragment: FRAGMENT_CLAIMED,
    });
    return true;
  }

  // The reward poster (stage 11+) takes precedence — it's fresher paste.
  if (stage >= STAGE_PAGE) {
    if (hasFragment(player, FRAGMENT_POSTING)) {
      player.sendMessage(POSTING_GONE_TEXT);
      return true;
    }
    for (const line of POSTING_LINES) {
      player.sendMessage(line);
    }
    grantSuccessionFragment(player, FRAGMENT_POSTING);
    addSuccessionHeat(player, HEAT_PAPER);
    console.info("[succession] trail: poster fragment granted", {
      player: player.getUsername(),
      fragment: FRAGMENT_POSTING,
    });
    return true;
  }

  // The neighbor's letter (stage 9+).
  if (stage >= STAGE_FARM) {
    if (hasFragment(player, FRAGMENT_FARM)) {
      player.sendMessage(FARM_GONE_TEXT);
      return true;
    }
    for (const line of FARM_LINES) {
      player.sendMessage(line);
    }
    grantSuccessionFragment(player, FRAGMENT_FARM);
    addSuccessionHeat(player, HEAT_PAPER);
    console.info("[succession] trail: farm fragment granted", {
      player: player.getUsername(),
      fragment: FRAGMENT_FARM,
    });
    return true;
  }

  player.sendMessage(PAPERS_LITTER_TEXT);
  return true;
}

// --- the auction, overheard (stage 10) --------------------------------------

/**
 * The Hand learned about letters (stage 6 burned them). So stage 10 lives in
 * tavern talk: what the merchants say about the charity auction, and where
 * the silver walks. Rare ambient, never a claim.
 */
function auctionSweep() {
  try {
    if (whisperStage() < STAGE_COIN) return;
    if (Math.random() >= 0.12) return;
    const line = AUCTION_OVERHEARD[Math.floor(Math.random() * AUCTION_OVERHEARD.length)];
    emitRumor(line);
  } catch (error) {
    console.warn("[succession] trail sweep failed", error?.message ?? error);
  }
}

// --- the warning (stage 12) -------------------------------------------------

/**
 * The grey men stop asking and start watching. Any player who dug deep —
 * two or more fragments, heat 50+ — gets one visit. Dread, never damage,
 * never theft. Once per player, ever.
 */
function warningSweep() {
  try {
    if (whisperStage() < STAGE_WARNING) return;
    if (Math.random() >= 0.1) return;
    const players = pluginApi?.core?.World?.getPlayers?.() ?? [];
    for (const player of players) {
      if (!player || player.isPlayerBot?.() === true) continue;
      if (player.getAttribute?.(WARNING_ATTRIBUTE)) continue;
      if (fragmentCount(player) < WARNING_MIN_FRAGMENTS) continue;
      if (successionHeat(player) < WARNING_MIN_HEAT) continue;
      player.setAttribute(WARNING_ATTRIBUTE, Date.now());
      for (const line of WARNING_LINES) {
        player.sendMessage(line);
      }
      console.info("[succession] trail: grey warning delivered", {
        player: player.getUsername(),
      });
      return; // one visit per sweep
    }
  } catch (error) {
    console.warn("[succession] trail warning failed", error?.message ?? error);
  }
}

function startSweeps(api) {
  class TrailTask extends Task {
    execute() {
      auctionSweep();
      warningSweep();
    }
  }
  // ~20 minutes at 600ms/tick, matching the keepers' cadence.
  api.getTaskManager()?.submit(new TrailTask(2000));
  console.info("[succession] trail: sweeps armed", { tickTicks: 2000 });
}

// --- attach ----------------------------------------------------------------

function attachSuccessionTrail(api) {
  pluginApi = api;
  api.onObjectInteraction(onObjectInteract);
  startSweeps(api);
  console.info("[succession] trail armed — stages 9-12: the farm, the coin, the page, the warning");
}

module.exports = attachSuccessionTrail;
module.exports.attachSuccessionTrail = attachSuccessionTrail;
