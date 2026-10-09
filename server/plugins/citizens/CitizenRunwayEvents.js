"use strict";

/**
 * CitizenRunwayEvents — player-facing runway fashion shows: the ::runway command.
 *
 * Mirrors the ::stage / ::dig / ::spy command pattern (PlayerRights.NONE
 * so every player can use it). Players can list venues and designers,
 * register as designers and models, create collections, form and join
 * designer houses, book runway shows, cast themselves, buy tickets, open
 * ateliers, buy collection pieces, and send houses on fashion-week tours.
 * Bots are rejected: citizens stage through the brain, not the command.
 */

const Runways = require("./lib/CitizenRunways");

const RUNWAY_USAGE =
  "::runway [venues|designers|register|collections|create <theme>|houses|form [name]|join <house>|model|cast <show>|shows|book <house> <collection> [price]|ticket <show>|ateliers|open|stock <collection>|buy <owner> <piece>|reviews|tour <house> <kingdom>|renovate <points>]";

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function isRealPlayer(player) {
  try {
    // Engine truth: Player#isPlayerBot() (server/src/main/typescript/elvarg/game/entity/impl/player/Player.ts:1084)
    // returns true for bot entities. The `?? false` fallback is deliberate: gate
    // call sites always receive a live command entity, so isPlayerBot() is always
    // callable there; the fallback preserves the legacy pass-through for anything
    // that isn't a known bot instead of silently blocking a new class of callers.
    return !(player?.isPlayerBot?.() ?? false);
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

/** Default cast: house members who are registered models. */
function defaultCast(house) {
  try {
    return (house.members || []).filter((m) => Runways.isModel(m)).map(String);
  } catch {
    return [];
  }
}

function onRunwayCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens stage through their own houses, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kingdomId = kingdomOf(player);
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "venues").toLowerCase();

  switch (sub) {
    case "venues": {
      const lines = [];
      for (const kid of ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania"]) {
        const v = Runways.ensureVenue(kid);
        if (!v) continue;
        lines.push(`${v.name}: ${Runways.effectiveCapacity(v)}/${v.capacity} seats, condition ${v.condition}%, owner ${v.owner}`);
      }
      say(player, lines.length ? lines.join(" | ") : "No runway venues yet.");
      return;
    }
    case "designers": {
      const st = Runways.load();
      const list = Object.values(st.designers || {})
        .filter((d) => !kingdomId || d.kingdomId === kingdomId)
        .slice(0, 8);
      say(player, list.length ? list.map((d) => `${d.username} (${d.collectionsMade || 0} collections)`).join(" | ") : "No designers yet.");
      return;
    }
    case "register": {
      const r = Runways.registerDesigner(username, kingdomId);
      say(player, r.ok ? "Registered as a designer. Collections cost 1 papyrus + cloth per piece." : `Could not register: ${r.reason}.`);
      return;
    }
    case "model": {
      const r = Runways.registerModel(username, kingdomId);
      say(player, r.ok ? "Registered as a runway model. Houses will cast you for shows." : `Could not register: ${r.reason}.`);
      return;
    }
    case "collections": {
      const cols = kingdomId ? Runways.collectionsIn(kingdomId) : [];
      if (!cols.length) {
        say(player, "No collections here yet. Designers create them with ::runway create <theme>.");
        return;
      }
      say(player, cols.slice(0, 8).map((c) => `#${c.id} "${c.name}" (${c.theme}, ${c.quality}/10) by ${c.designer}`).join(" | "));
      return;
    }
    case "create": {
      const theme = (parts[1] || "").toLowerCase();
      if (!Runways.isDesigner(username)) {
        const r = Runways.registerDesigner(username, kingdomId);
        if (!r.ok) {
          say(player, "Could not register as designer.");
          return;
        }
        say(player, "Registered as a designer. Run create again with a theme.");
        return;
      }
      const res = Runways.createCollection(username, theme, { payer: player });
      if (!res.ok) {
        say(player, `Could not create: ${res.reason}. Themes: ${Runways.THEMES.join(", ")}.`);
        return;
      }
      say(player, `Created "${res.collection.name}" — ${res.collection.pieces.length} pieces, quality ${res.collection.quality}/10.`);
      return;
    }
    case "houses": {
      const houses = kingdomId ? Runways.housesIn(kingdomId) : [];
      if (!houses.length) {
        say(player, "No designer houses here yet. Form one with ::runway form [name].");
        return;
      }
      say(player, houses.map((h) => `${h.name} (${h.members.length} members, ${h.treasury || 0}c treasury)`).join(" | "));
      return;
    }
    case "form": {
      const name = parts.slice(1).join(" ") || undefined;
      const res = Runways.formHouse(username, name);
      say(player, res.ok ? `Formed ${res.house.name}!` : `Could not form house: ${res.reason}.`);
      return;
    }
    case "join": {
      const name = parts.slice(1).join(" ");
      if (!name) {
        say(player, "Usage: ::runway join <house>");
        return;
      }
      const res = Runways.joinHouse(username, name);
      say(player, res.ok ? `Joined ${res.house.name}!` : `Could not join: ${res.reason}.`);
      return;
    }
    case "cast": {
      const showId = parts[1];
      if (!showId) {
        say(player, "Usage: ::runway cast <show>");
        return;
      }
      if (!Runways.isModel(username)) {
        const r = Runways.registerModel(username, kingdomId);
        if (!r.ok) {
          say(player, "Could not register as model.");
          return;
        }
      }
      const res = Runways.castModel(showId, username);
      say(player, res.ok ? `Cast for show #${showId}!` : `Could not cast: ${res.reason}.`);
      return;
    }
    case "shows": {
      const shows = kingdomId ? Runways.upcomingShows(kingdomId) : [];
      if (!shows.length) {
        say(player, "No upcoming runway shows here.");
        return;
      }
      say(player, shows.slice(0, 6).map((s) => `${s.id}: "${s.collectionName}" by ${s.houseName} — ${s.ticketPrice}c, ${s.ticketsSold} sold`).join(" | "));
      return;
    }
    case "book": {
      // house names may contain spaces; the collection id is always numeric,
      // and an optional price is a second trailing number.
      if (parts.length < 3) {
        say(player, "Usage: ::runway book <house> <collection> [price]");
        return;
      }
      let price;
      let rest = parts.slice(1);
      if (rest.length >= 4 && /^\d+$/.test(rest[rest.length - 1]) && /^\d+$/.test(rest[rest.length - 2])) {
        price = Number(rest.pop());
      }
      const collectionId = rest.pop();
      const houseName = rest.join(" ");
      const house = Runways.houseFor(houseName);
      if (!house) {
        say(player, `Could not book: no such house.`);
        return;
      }
      const cast = defaultCast(house);
      if (cast.length < Runways.MIN_CAST) {
        say(player, `Could not book: need at least ${Runways.MIN_CAST} cast models in the house — register with ::runway model.`);
        return;
      }
      const res = Runways.bookShow(houseName, collectionId, { kingdomId, ticketPrice: price, castModels: cast });
      if (!res.ok) {
        say(player, `Could not book: ${res.reason}.`);
        return;
      }
      say(player, `Booked "${res.show.collectionName}" at ${res.show.kingdomId} runway — tickets ${res.show.ticketPrice} coins.`);
      return;
    }
    case "ticket": {
      const showId = parts[1];
      if (!showId) {
        say(player, "Usage: ::runway ticket <show>");
        return;
      }
      const res = Runways.buyTicket(player, showId);
      say(player, res.ok ? `Ticket bought for "${res.show.collectionName}"!` : `No ticket: ${res.reason}.`);
      return;
    }
    case "ateliers": {
      const list = kingdomId ? Runways.ateliersIn(kingdomId) : [];
      if (!list.length) {
        say(player, "No ateliers here yet.");
        return;
      }
      say(player, list.map((a) => `${a.owner}'s atelier (${a.inventory.filter((i) => !i.sold).length} pieces for sale)`).join(" | "));
      return;
    }
    case "open": {
      const res = Runways.openAtelier(username, kingdomId);
      say(player, res.ok ? "Atelier opened! Stock it with ::runway stock <collection>." : `Could not open: ${res.reason}.`);
      return;
    }
    case "stock": {
      const collectionId = parts[1];
      if (!collectionId) {
        say(player, "Usage: ::runway stock <collection>");
        return;
      }
      const res = Runways.stockAtelier(username, collectionId);
      say(player, res.ok ? `Stocked ${res.stocked} pieces.` : `Could not stock: ${res.reason}.`);
      return;
    }
    case "buy": {
      // owner names may contain spaces: piece id is always last
      if (parts.length < 3) {
        say(player, "Usage: ::runway buy <owner> <piece>");
        return;
      }
      const pieceId = parts[parts.length - 1];
      const owner = parts.slice(1, -1).join(" ");
      const res = Runways.buyFromAtelier(player, owner, pieceId);
      say(player, res.ok ? `Bought the ${res.piece.garment} for ${res.piece.price} coins!` : `Could not buy: ${res.reason}.`);
      return;
    }
    case "reviews": {
      const reviews = kingdomId ? Runways.reviewsFor(kingdomId) : [];
      if (!reviews.length) {
        say(player, "No reviews yet.");
        return;
      }
      say(player, reviews.map((r) => `"${r.collectionName}" ${"★".repeat(r.stars)}${"☆".repeat(5 - r.stars)} — ${r.verdict}`).join(" | "));
      return;
    }
    case "tour": {
      // house names may contain spaces: the destination is always last
      if (parts.length < 3) {
        say(player, "Usage: ::runway tour <house> <kingdom>");
        return;
      }
      const dest = parts[parts.length - 1];
      const houseName = parts.slice(1, -1).join(" ");
      const res = Runways.tourTo(houseName, dest);
      say(player, res.ok ? `${houseName} departs for fashion week in ${dest}!` : `Could not tour: ${res.reason}.`);
      return;
    }
    case "renovate": {
      const points = Number(parts[1]) || 10;
      const res = Runways.renovate(kingdomId, player, points);
      say(player, res.ok ? `Runway renovated (+${points} condition) for ${res.cost} coins.` : `Could not renovate: ${res.reason}.`);
      return;
    }
    default:
      say(player, RUNWAY_USAGE);
  }
}

module.exports = { onRunwayCommand, RUNWAY_USAGE };
