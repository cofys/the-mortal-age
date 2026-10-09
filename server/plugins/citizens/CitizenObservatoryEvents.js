"use strict";

/**
 * CitizenObservatoryEvents — player-facing observatory operations:
 * the ::observatory command.
 *
 * Mirrors the ::library / ::gallery / ::festival command pattern
 * (PlayerRights.NONE so every player can use it). Players can visit the
 * observatory at night, look through the telescope, buy chart copies,
 * join guided tours and viewing parties, and host their own stargazing
 * gatherings. Bots are rejected: citizens work through the brain, not
 * the command.
 */

const Obs = require("./lib/CitizenObservatories");

const OBSERVATORY_USAGE =
  "::observatory [visit|sky|charts|buy <chartId>|tours|join <tourId>|party|host|collection]";

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function isRealPlayer(player) {
  try {
    return player?.isRealPlayer?.() ?? !player?.isBot;
  } catch {
    return true;
  }
}

function say(player, text) {
  try {
    player?.sendMessage?.(text);
  } catch {
    // messaging is best-effort
  }
}

function kingdomOf(player) {
  try {
    const { kingdomIdOf } = require("./brain/CitizenSites");
    return kingdomIdOf(player) || null;
  } catch {
    return null;
  }
}

function onObservatoryCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens work the observatories through their own routines.");
    return;
  }
  const sub = (args[0] || "visit").toLowerCase();
  const kid = kingdomOf(player);
  const nowMs = Date.now();

  if (sub === "visit") {
    if (!kid) return say(player, "You are not in a kingdom with an observatory.");
    if (!Obs.observatoryTile(kid)) return say(player, "There is no observatory in this kingdom yet.");
    if (!Obs.isNight(nowMs)) return say(player, "The observatory opens at nightfall (21:00–05:00).");
    const res = Obs.beginVisit(player, kid, nowMs);
    if (!res.ok && res.reason === "cannot-afford") {
      return say(player, `Entry is ${Obs.ENTRY_FEE} coins — you cannot afford it.`);
    }
    if (!res.ok) return say(player, `Could not enter: ${res.reason}.`);
    const sky = Obs.describeSky(kid, nowMs);
    say(player, `You pay ${Obs.ENTRY_FEE} coins and step up to the great telescope. Above you: ${sky}.`);
    Obs.recordSighting(player, kid, nowMs);
    return;
  }

  if (sub === "sky") {
    if (!kid || !Obs.observatoryTile(kid)) return say(player, "No observatory here to read the sky from.");
    const v = Obs.whatIsVisible(kid, nowMs);
    const bits = [];
    if (v.event) bits.push(`a ${String(v.event).replace(/_/g, " ")} is active`);
    bits.push(`visible: ${v.objects.slice(0, 4).join(", ")}`);
    say(player, `Tonight's sky: ${bits.join(" — ")}.`);
    return;
  }

  if (sub === "charts") {
    if (!kid) return say(player, "You are not in a kingdom with an observatory.");
    const forSale = Obs.chartsForSale(kid);
    if (!forSale.length) return say(player, "No star charts for sale — the astronomers have charted nothing yet.");
    for (const c of forSale.slice(0, 10)) {
      say(player, `[${c.id}] quality ${c.quality}/10, by ${c.astronomer} — ${c.price} coins`);
    }
    return;
  }

  if (sub === "buy") {
    const chartId = args[1];
    if (!chartId) return say(player, "Usage: ::observatory buy <chartId>");
    if (!kid) return say(player, "You are not in a kingdom with an observatory.");
    const res = Obs.buyChart(player, chartId, kid, nowMs);
    if (!res.ok && res.reason === "cannot-afford") return say(player, "You cannot afford that chart.");
    if (!res.ok && res.reason === "no-such-chart") return say(player, "No chart with that id is for sale here.");
    if (!res.ok) return say(player, `Could not buy: ${res.reason}.`);
    say(player, `You buy a copy of ${res.chart.astronomer}'s chart (quality ${res.chart.quality}/10) for ${res.chart.price} coins.`);
    return;
  }

  if (sub === "collection") {
    const copies = Obs.chartCopiesFor(player);
    if (!copies.length) return say(player, "You own no star chart copies yet. Buy them with ::observatory buy <chartId>.");
    for (const c of copies.slice(0, 10)) {
      say(player, `[${c.id}] quality ${c.quality ?? "?"}/10, charted by ${c.astronomer}`);
    }
    return;
  }

  if (sub === "tours") {
    if (!kid) return say(player, "You are not in a kingdom with an observatory.");
    const tours = Obs.toursFor(kid, nowMs);
    if (!tours.length) return say(player, "No guided sky tours scheduled. Astronomers schedule them through their routines.");
    for (const t of tours.slice(0, 5)) {
      const when = new Date(t.scheduledFor).toLocaleString();
      say(player, `[${t.id}] led by ${t.astronomer} — ${when} (${t.attendees.length} attending)`);
    }
    return;
  }

  if (sub === "join") {
    const tourId = args[1];
    if (!tourId) return say(player, "Usage: ::observatory join <tourId>");
    const res = Obs.joinTour(player, tourId, nowMs);
    if (!res.ok && res.reason === "tour-full") return say(player, "That tour is full.");
    if (!res.ok && res.reason === "tour-over") return say(player, "That tour has ended.");
    if (!res.ok) return say(player, `Could not join: ${res.reason}.`);
    say(player, `You join ${res.tour.astronomer}'s sky tour. Look up when it begins.`);
    return;
  }

  if (sub === "party") {
    if (!kid) return say(player, "You are not in a kingdom with an observatory.");
    const party = Obs.partyFor(kid, nowMs);
    if (!party) {
      const v = Obs.whatIsVisible(kid, nowMs);
      if (v.event) {
        say(player, "A viewing party is forming — try again in a moment.");
      } else {
        say(player, "No viewing party tonight — parties gather when a celestial event fills the sky.");
      }
      return;
    }
    const res = Obs.joinParty(player, kid, nowMs);
    if (!res.ok) return say(player, `Could not join: ${res.reason}.`);
    const label = String(party.eventKind).replace(/_/g, " ");
    say(player, `You join the viewing party — ${res.party.attendees.length} sky-watchers sharing the ${label}.`);
    return;
  }

  if (sub === "host") {
    if (!kid) return say(player, "You are not in a kingdom with an observatory.");
    if (!Obs.isNight(nowMs)) return say(player, "Stargazing gatherings happen at night (21:00–05:00).");
    const res = Obs.hostGathering(player, kid, nowMs);
    if (!res.ok) return say(player, `Could not host: ${res.reason}.`);
    say(player, "You host a stargazing gathering. Others can join with ::observatory gatherings.");
    return;
  }

  if (sub === "gatherings") {
    if (!kid) return say(player, "You are not in a kingdom with an observatory.");
    const gs = Obs.gatheringsFor(kid, nowMs);
    if (!gs.length) return say(player, "No stargazing gatherings tonight. Host one with ::observatory host.");
    for (const g of gs.slice(0, 5)) {
      say(player, `[${g.id}] hosted by ${g.host} — ${g.attendees.length} attending`);
    }
    return;
  }

  say(player, OBSERVATORY_USAGE);
}

module.exports = { onObservatoryCommand, OBSERVATORY_USAGE };
