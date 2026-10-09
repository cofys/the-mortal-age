"use strict";

/**
 * CitizenMusicFestivalEvents — player-facing music festivals: the ::festival command.
 *
 * Mirrors the ::runway / ::stage / ::cookoff command pattern (PlayerRights.NONE
 * so every player can use it). Players can list grounds and promoters,
 * register as promoters, found and join festival companies, schedule
 * festivals, book acts, set ticket prices, buy tickets, run vendor stalls,
 * camp, and send companies on tour. Bots are rejected: citizens promote
 * through the brain, not the command.
 */

const MF = require("./lib/CitizenMusicFestivals");

const FESTIVAL_USAGE =
  "::festival [grounds|promoters|register|companies|found <name>|join <company>|schedule <company> <days>|festivals|book <festival> <day> <type> <act>|prices <festival> <day> <full>|ticket <festival> [day|full]|vendor <festival>|camp <festival> <nights>|tour <company> <kingdom>|renovate <points>]";

const COINS_ID = 995;

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

/** Remove real coins from a player's inventory. Returns { ok }. */
function takeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return { ok: false };
    const has = inv.getAmount?.(COINS_ID) ?? inv.count?.(COINS_ID) ?? 0;
    if (has < amount) return { ok: false };
    if (typeof inv.remove === "function") inv.remove(COINS_ID, amount);
    else if (typeof inv.delete === "function") inv.delete(COINS_ID, amount);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function onFestivalCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens promote through their own companies, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kingdomId = kingdomOf(player);
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "grounds").toLowerCase();

  switch (sub) {
    case "grounds": {
      const lines = [];
      for (const kid of ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania"]) {
        const g = MF.ensureGround(kid);
        if (!g) continue;
        lines.push(`${kid}: ${g.capacity} capacity, condition ${g.condition}%, owner ${g.owner}`);
      }
      say(player, lines.length ? lines.join(" | ") : "No festival grounds yet.");
      return;
    }
    case "promoters": {
      // Defensive: no public list API, so report count via upcoming festivals.
      say(player, "Promoters run the festival companies. Register with ::festival register.");
      return;
    }
    case "register": {
      const r = MF.registerPromoter(username, kingdomId);
      say(player, r.ok ? "Registered as a festival promoter. Found a company to start booking." : `Could not register: ${r.reason}.`);
      return;
    }
    case "companies": {
      say(player, "Form a company with ::festival found <name>, then schedule festivals.");
      return;
    }
    case "found": {
      const name = parts.slice(1).join(" ");
      if (!name) { say(player, FESTIVAL_USAGE); return; }
      const r = MF.foundCompany(username, name);
      say(player, r.ok ? `Founded ${r.company.name}. Treasury: ${r.company.treasury} coins.` : `Could not found: ${r.reason}.`);
      return;
    }
    case "join": {
      const name = parts.slice(1).join(" ");
      if (!name) { say(player, FESTIVAL_USAGE); return; }
      const r = MF.joinCompany(username, name);
      say(player, r.ok ? `Joined ${r.company.name}.` : `Could not join: ${r.reason}.`);
      return;
    }
    case "schedule": {
      const companyName = parts[1];
      const days = parseInt(parts[2], 10) || 2;
      if (!companyName) { say(player, FESTIVAL_USAGE); return; }
      const r = MF.scheduleFestival(companyName, kingdomId, days);
      say(player, r.ok
        ? `Scheduled ${r.festival.name} — ${r.festival.days} days, starts soon. Book acts with ::festival book.`
        : `Could not schedule: ${r.reason}.`);
      return;
    }
    case "festivals": {
      const list = kingdomId ? MF.festivalsForKingdom(kingdomId) : [];
      const upcoming = list.filter((f) => f.status === "scheduled").slice(0, 5);
      say(player, upcoming.length
        ? upcoming.map((f) => `${f.name} (${f.id}, ${f.days}d, ${f.status})`).join(" | ")
        : "No festivals scheduled here yet.");
      return;
    }
    case "book": {
      // ::festival book <festivalId> <day> <type> <act name...>
      const festivalId = parts[1];
      const day = parseInt(parts[2], 10) || 0;
      const actType = (parts[3] || "").toLowerCase();
      const actName = parts.slice(4).join(" ");
      if (!festivalId || !actType || !actName) { say(player, FESTIVAL_USAGE); return; }
      // Player books by name — the act lookup is honest: we accept the name
      // as given (the promoter vouches for the act).
      const r = MF.bookAct(festivalId, day, actType, actName, false, () => ({ name: actName }));
      say(player, r.ok
        ? `Booked ${actName} (${actType}) for day ${day} — fee ${r.fee} coins from the treasury.`
        : `Could not book: ${r.reason}.`);
      return;
    }
    case "prices": {
      const festivalId = parts[1];
      const dayPass = parseInt(parts[2], 10);
      const fullPass = parseInt(parts[3], 10);
      if (!festivalId) { say(player, FESTIVAL_USAGE); return; }
      // Find the caller's company.
      const company = MF.companyForPromoter(username);
      if (!company) { say(player, "You need a festival company first."); return; }
      const r = MF.setTicketPrices(festivalId, company.nameLower, dayPass, fullPass);
      say(player, r.ok
        ? `Ticket prices set: day ${r.tickets.dayPass}, full ${r.tickets.fullPass}.`
        : `Could not set prices: ${r.reason}.`);
      return;
    }
    case "ticket": {
      const festivalId = parts[1];
      const passType = (parts[2] || "day").toLowerCase() === "full" ? "full" : "day";
      if (!festivalId) { say(player, FESTIVAL_USAGE); return; }
      const r = MF.sellTicket(festivalId, username, passType, (n) => takeCoins(player, n));
      say(player, r.ok
        ? `Ticket bought (${passType} pass, ${r.price} coins). See you at the festival!`
        : `Could not buy ticket: ${r.reason}.`);
      return;
    }
    case "vendor": {
      const festivalId = parts[1];
      if (!festivalId) { say(player, FESTIVAL_USAGE); return; }
      const r = MF.addVendor(festivalId, username, (n) => takeCoins(player, n));
      say(player, r.ok
        ? `Vendor stall secured — fee ${r.fee} coins. Sell your wares!`
        : `Could not secure stall: ${r.reason}.`);
      return;
    }
    case "camp": {
      const festivalId = parts[1];
      const nights = parseInt(parts[2], 10) || 1;
      if (!festivalId) { say(player, FESTIVAL_USAGE); return; }
      const r = MF.addCamper(festivalId, username, nights, (n) => takeCoins(player, n));
      say(player, r.ok
        ? `Camping booked — ${r.nights} nights, ${r.fee} coins.`
        : `Could not book camping: ${r.reason}.`);
      return;
    }
    case "tour": {
      const companyName = parts[1];
      const toKingdom = parts[2];
      if (!companyName || !toKingdom) { say(player, FESTIVAL_USAGE); return; }
      const r = MF.startTour(companyName, kingdomId, toKingdom);
      say(player, r.ok
        ? `${r.company} tours to ${r.to} — arrives soon.`
        : `Could not tour: ${r.reason}.`);
      return;
    }
    case "renovate": {
      const points = parseInt(parts[1], 10) || 5;
      if (!kingdomId) { say(player, "No kingdom found."); return; }
      const r = MF.renovateGround(kingdomId, points, (n) => takeCoins(player, n));
      say(player, r.ok
        ? `Ground renovated — condition ${r.condition}%, cost ${r.cost} coins.`
        : `Could not renovate: ${r.reason}.`);
      return;
    }
    default:
      say(player, FESTIVAL_USAGE);
  }
}

module.exports = { onFestivalCommand, FESTIVAL_USAGE };
