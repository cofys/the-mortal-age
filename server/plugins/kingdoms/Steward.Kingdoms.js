"use strict";

/**
 * Steward.Kingdoms — DIEGETIC ::office replacement (no-commands migration, phase 2).
 *
 * Jon's directive: no ::commands for players. Everything through the world.
 * A "Steward's desk" stands in each capital castle. Click "Petition" and the
 * court's steward grants you an audience — a chatbox dialogue (the proven
 * sendMultiChatboxPrompt pattern from the origins fix):
 *
 *   THE STEWARD'S DESK
 *   "What offices are open?"        — the office list (::office list)
 *   "I wish to petition for an office" — petition / challenge flow (Politics.petition)
 *   "How do I stand with the court?"   — influence standing (::office influence)
 *   "I resign my office"            — vacate a held office (::office vacate)
 *
 * Nothing here reimplements office logic. The list comes from
 * Commands.officeListLines, petitions route into Politics.petition (the same
 * court that hears ::office petition — vacant offices appoint on influence,
 * held offices are challenged, trials of service and cooldowns all apply),
 * influence from Politics.showInfluence, and resignations from
 * Commands.vacateOffice (same kingdom:office-vacated event, same owner
 * override). The desk's kingdom is inferred from position — a desk serves
 * the capital it stands in — mirroring the DonationChest/MarketBoard
 * kingdomAt table.
 *
 * The ::office command stays registered until the desk is verified in-game,
 * then it goes. Migration rule: build the world path, verify it works,
 * remove the command. Never the reverse.
 *
 * NOTE: the physical desks are a world edit — same as the Market Board's
 * "place a board in each capital market" step. This file is the interaction.
 * Verify: place a "Steward's desk" in a capital castle, click Petition, walk
 * each of the four options, and confirm the outcomes match the ::office
 * command (list output, petition ruling, influence readout, vacate event).
 */

const Commands = require("./Commands.Kingdoms");
const Politics = require("./Politics.Kingdoms");
const Offices = require("./Offices.Kingdoms");
const Store = require("./KingdomStore");

const DESK_OBJECT_NAME = "Steward's desk";
const DESK_ACTION = "Petition";

let pluginApi = null;

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

function kingdomName(kingdomId) {
  return Store.getKingdom(kingdomId)?.name ?? kingdomId;
}

/**
 * Which kingdom's capital is this desk in? Mirrors the DonationChest's
 * kingdomAt table (itself a mirror of the Market Board's): capitals within
 * a 60-tile radius. A desk serves the court of the capital it stands in.
 */
function kingdomAt(player) {
  try {
    const pos = player.getLocation?.();
    const x = pos.getX?.() ?? 0;
    const y = pos.getY?.() ?? 0;
    const capitals = [
      { id: "asgarnia", x: 2964, y: 3378 },
      { id: "misthalin", x: 3165, y: 3485 },
      { id: "kandarin", x: 2660, y: 3290 },
      { id: "morytania", x: 3495, y: 3235 },
      { id: "keldagrim", x: 2855, y: 10200 },
    ];
    let best = null;
    let bestD = 60; // must be within 60 tiles of a capital
    for (const c of capitals) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) {
        bestD = d;
        best = c.id;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/** Offices of this kingdom the player personally holds the seals of. */
function officesHeldBy(player, kingdomId) {
  const username = usernameOf(player);
  if (!username) return [];
  return Offices.getOffices(kingdomId).filter(
    (o) => o.holder?.kind === "player" && o.holder.ref === username
  );
}

function showPrompt(player, title, pairs) {
  try {
    return pluginApi.sendMultiChatboxPrompt(player, title, ...pairs);
  } catch (error) {
    console.warn("[steward] prompt failed", error?.message ?? error);
    player.sendMessage("The steward is momentarily attending the court. Try again.");
    return false;
  }
}

/** The audience itself: the four doors into the existing office flows. */
function showAudience(player, kingdomId) {
  if (!player) return;
  const pairs = [
    "What offices are open?",
    () => {
      Commands.showList(player, [kingdomId]);
      showAudience(player, kingdomId);
    },
    "I wish to petition for an office.",
    () => showPetitionMenu(player, kingdomId),
    "How do I stand with the court?",
    () => {
      Politics.showInfluence(player, [kingdomId]);
      showAudience(player, kingdomId);
    },
    "I resign my office.",
    () => showVacateMenu(player, kingdomId),
    "Leave.",
    () => {},
  ];
  showPrompt(player, `The steward's desk — ${kingdomName(kingdomId)}`, pairs);
}

/**
 * Petition sub-menu: one option per office of this court, labelled vacant or
 * held. Choosing one hands straight to Politics.petition — the same court
 * that hears ::office petition, with the same thresholds, trials, and
 * cooldowns. (A vacant office petitioned here is what ::office claim did.)
 */
function showPetitionMenu(player, kingdomId) {
  if (!player) return;
  const offices = Offices.getOffices(kingdomId);
  if (offices.length === 0) {
    player.sendMessage("[Offices] No offices found.");
    showAudience(player, kingdomId);
    return;
  }
  const pairs = [];
  for (const office of offices) {
    const label = office.holder
      ? `Challenge: ${office.title} — held by ${Offices.holderName(office.holder)}`
      : `Petition: ${office.title} — vacant`;
    const officeId = office.officeId;
    pairs.push(label, () => {
      Politics.petition(player, [officeId]);
      showAudience(player, kingdomId);
    });
  }
  pairs.push("On reflection, no.", () => showAudience(player, kingdomId));
  showPrompt(player, "Which seals do you seek?", pairs);
}

/**
 * Resignation sub-menu: only the seals this subject actually holds in this
 * kingdom, each behind a confirmation — resigning is the player's choice,
 * and a mis-click should not unseat them.
 */
function showVacateMenu(player, kingdomId) {
  if (!player) return;
  const held = officesHeldBy(player, kingdomId);
  if (held.length === 0) {
    player.sendMessage(
      `[Offices] You hold no seals of ${kingdomName(kingdomId)}. There is nothing to resign.`
    );
    showAudience(player, kingdomId);
    return;
  }
  const pairs = [];
  for (const office of held) {
    const label = `Resign as ${office.title} of ${kingdomName(kingdomId)}`;
    const officeId = office.officeId;
    pairs.push(label, () => showVacateConfirm(player, kingdomId, officeId));
  }
  pairs.push("Keep my seals.", () => showAudience(player, kingdomId));
  showPrompt(player, "Which seals do you lay down?", pairs);
}

function showVacateConfirm(player, kingdomId, officeId) {
  if (!player) return;
  const office = Offices.getOffice(officeId);
  const title = office ? office.title : officeId;
  const pairs = [
    "Yes. I resign.",
    () => {
      Commands.vacateOffice(player, [officeId]);
      showAudience(player, kingdomId);
    },
    "On reflection, keep them.",
    () => showAudience(player, kingdomId),
  ];
  showPrompt(
    player,
    `Lay down the seals of ${title}? The court will name another.`,
    pairs
  );
}

function openAudience({ player, kingdomId }) {
  if (!player || player.isPlayerBot?.() === true) return;
  const kid = kingdomId ?? kingdomAt(player);
  if (!kid) {
    player.sendMessage("This desk serves no court I know. The steward's audience is held in the capitals.");
    return;
  }
  showAudience(player, kid);
}

function attachSteward(api) {
  pluginApi = api;
  // Diegetic: the desk is a spawned Desk (DiegeticObjects).
  // Global handler + location gate; the "Steward's desk" name doesn't
  // exist in the cache.
  const { matchDiegetic } = require("../world/DiegeticObjects");
  api.onObjectInteraction((event) => {
    const { player, objectId, location } = event ?? {};
    if (!player || player.isPlayerBot?.() === true) return false;
    const match = matchDiegetic(objectId, location, "desk");
    if (!match) return false;
    openAudience({ player, kingdomId: match.capitalId });
    return true;
  });
  console.info("[steward] diegetic ::office replacement ready (phase 2)");
}

module.exports = attachSteward;
