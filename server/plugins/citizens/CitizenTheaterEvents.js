"use strict";

/**
 * CitizenTheaterEvents — player-facing theater: the ::stage command.
 *
 * Mirrors the ::dig / ::spy / ::charter command pattern (PlayerRights.NONE
 * so every player can use it). Players can list theaters and plays, write
 * plays (as registered playwrights), form and join troupes, book
 * performances, buy tickets, and send troupes touring. Bots are rejected:
 * citizens rehearse through the brain, not the command.
 */

const Theater = require("./lib/CitizenTheater");

const STAGE_USAGE =
  "::stage [theaters|plays|write <genre>|troupes|form [name]|join <troupe>|repertoire <troupe> <play>|book <troupe> <play> [price]|tour <troupe> <kingdom>|ticket <perf>|performances|reviews|renovate <points>]";

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
    const { kingdomIdOf } = require("./lib/../brain/CitizenSites");
    return kingdomIdOf(player) || null;
  } catch {
    return null;
  }
}

function onStageCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens rehearse through their own troupes, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kingdomId = kingdomOf(player);
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "theaters").toLowerCase();

  switch (sub) {
    case "theaters": {
      const lines = [];
      for (const kid of ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania"]) {
        const t = Theater.theaterFor(kid);
        if (!t) continue;
        lines.push(`${t.name}: ${Theater.effectiveCapacity(t)}/${t.capacity} seats, condition ${t.condition}%, owner ${t.owner}`);
      }
      say(player, lines.length ? lines.join(" | ") : "No theaters yet.");
      return;
    }
    case "plays": {
      const plays = kingdomId ? Theater.playsIn(kingdomId) : [];
      if (!plays.length) {
        say(player, "No plays written here yet. Playwrights write with ::stage write <genre>.");
        return;
      }
      say(player, plays.slice(0, 8).map((p) => `"${p.title}" (${p.genre}, ${p.quality}/10) by ${p.playwright}`).join(" | "));
      return;
    }
    case "write": {
      const genre = (parts[1] || "").toLowerCase();
      if (!Theater.isPlaywright(username)) {
        const r = Theater.registerPlaywright(username, kingdomId);
        if (!r.ok) {
          say(player, "Could not register as playwright.");
          return;
        }
        say(player, "Registered as a playwright. Drafting costs 1 papyrus per play.");
      }
      const res = Theater.writePlay(player, genre);
      if (!res.ok) {
        say(player, `Could not write: ${res.reason}. Genres: ${Theater.GENRE_KEYS.join(", ")}.`);
        return;
      }
      say(player, `Wrote "${res.play.title}" (${res.play.genre}, quality ${res.play.quality}/10).`);
      return;
    }
    case "troupes": {
      const troupes = kingdomId ? Theater.troupesIn(kingdomId) : [];
      if (!troupes.length) {
        say(player, "No troupes here yet. Form one with ::stage form [name].");
        return;
      }
      say(player, troupes.map((t) => `${t.name} (${t.members.length} members, ${t.showsPlayed} shows)`).join(" | "));
      return;
    }
    case "form": {
      const name = parts.slice(1).join(" ") || undefined;
      const res = Theater.formTroupe(username, kingdomId, name);
      say(player, res.ok ? `Formed ${res.troupe.name}!` : `Could not form troupe: ${res.reason}.`);
      return;
    }
    case "join": {
      const name = parts.slice(1).join(" ");
      if (!name) {
        say(player, "Usage: ::stage join <troupe>");
        return;
      }
      const res = Theater.joinTroupe(username, name);
      say(player, res.ok ? `Joined ${res.troupe.name}!` : `Could not join: ${res.reason}.`);
      return;
    }
    case "repertoire": {
      // troupe names may contain spaces: the play id is always the last token
      if (parts.length < 3) {
        say(player, "Usage: ::stage repertoire <troupe> <play>");
        return;
      }
      const playId = parts[parts.length - 1];
      const troupeName = parts.slice(1, -1).join(" ");
      const res = Theater.addToRepertoire(troupeName, playId);
      say(player, res.ok ? "Added to the repertoire." : `Could not add: ${res.reason}.`);
      return;
    }
    case "book": {
      // troupe names may contain spaces; optional numeric price is last
      if (parts.length < 3) {
        say(player, "Usage: ::stage book <troupe> <play> [price]");
        return;
      }
      let price;
      let rest = parts.slice(1);
      if (/^\d+$/.test(rest[rest.length - 1]) && rest.length >= 3) {
        price = Number(rest.pop());
      }
      const playId = rest.pop();
      const troupeName = rest.join(" ");
      const res = Theater.bookPerformance(troupeName, playId, kingdomId, price);
      if (!res.ok) {
        say(player, `Could not book: ${res.reason}.`);
        return;
      }
      say(player, `Booked "${res.performance.playTitle}" at ${res.theater.name} — tickets ${res.performance.ticketPrice} coins.`);
      return;
    }
    case "tour": {
      // troupe names may contain spaces: the destination is always last
      if (parts.length < 3) {
        say(player, "Usage: ::stage tour <troupe> <kingdom>");
        return;
      }
      const dest = parts[parts.length - 1];
      const troupeName = parts.slice(1, -1).join(" ");
      const res = Theater.tourTo(troupeName, dest);
      say(player, res.ok ? `${troupeName} departs for ${dest}!` : `Could not tour: ${res.reason}.`);
      return;
    }
    case "ticket": {
      const perfId = parts[1];
      if (!perfId) {
        say(player, "Usage: ::stage ticket <performance>");
        return;
      }
      const res = Theater.buyTicket(player, perfId);
      say(player, res.ok ? `Ticket bought for "${res.performance.playTitle}"!` : `No ticket: ${res.reason}.`);
      return;
    }
    case "performances": {
      const perfs = kingdomId ? Theater.upcomingPerformances(kingdomId) : [];
      if (!perfs.length) {
        say(player, "No upcoming performances here.");
        return;
      }
      say(player, perfs.slice(0, 6).map((p) => `${p.id}: "${p.playTitle}" by ${p.troupe} — ${p.ticketPrice}c, ${p.ticketsSold} sold`).join(" | "));
      return;
    }
    case "reviews": {
      const reviews = Theater.recentReviews(kingdomId, 5);
      if (!reviews.length) {
        say(player, "No reviews yet.");
        return;
      }
      say(player, reviews.map((r) => `"${r.playTitle}" ${"★".repeat(r.stars)}${"☆".repeat(5 - r.stars)} — ${r.verdict}`).join(" | "));
      return;
    }
    case "renovate": {
      const points = Number(parts[1]) || 10;
      const res = Theater.renovate(kingdomId, player, points);
      say(player, res.ok ? `Theater renovated (+${points} condition) for ${res.cost} coins.` : `Could not renovate: ${res.reason}.`);
      return;
    }
    default:
      say(player, STAGE_USAGE);
  }
}

module.exports = { onStageCommand, STAGE_USAGE };
