"use strict";

/**
 * CitizenGalleryEvents — player-facing gallery operations: the ::gallery command.
 *
 * Mirrors the ::runway / ::festival / ::cookoff command pattern
 * (PlayerRights.NONE so every player can use it). Players can check gallery
 * status, consign artworks to auction, bid, post/accept/deliver commissions,
 * request appraisals, and send traveling exhibitions (curators only).
 * Bots are rejected: citizens curate through the brain, not the command.
 */

const Galleries = require("./lib/CitizenGalleries");

const GALLERY_USAGE =
  "::gallery [status|auctions|consign <artworkId> [reserve]|bid <auctionId> <amount>|commissions|post <medium> <escrow> [theme]|accept <commissionId>|deliver <commissionId> <artworkId>|cancel <commissionId>|appraise <artworkId>|tour <kingdom> [kingdom...]]";

const KINGDOM_IDS = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania"];

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

/** Pay a username: online player inventory, else honest bank credit. */
function payUsername(username, amount) {
  // The data tier handles bank fallback internally; here we only know the
  // calling player. Return false so the tier credits the bank honestly.
  return false;
}

function onGalleryCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens curate through their own galleries, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kingdomId = kingdomOf(player);
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "status").toLowerCase();

  switch (sub) {
    case "status": {
      const lines = [];
      for (const kid of KINGDOM_IDS) {
        const s = Galleries.stats(kid);
        lines.push(
          `${kid}: prestige ${s.prestige}, budget ${s.budget}c, collection ${s.collectionSize}, auctions ${s.openAuctions}, curators ${s.curators}`
        );
      }
      say(player, lines.join(" | "));
      return;
    }
    case "auctions": {
      if (!kingdomId) {
        say(player, "I don't know which kingdom you're in.");
        return;
      }
      const list = Galleries.openAuctions(kingdomId);
      if (!list.length) {
        say(player, "No open auctions in this kingdom.");
        return;
      }
      say(
        player,
        list.slice(0, 5).map((a) => {
          const high = a.bids.length ? a.bids[a.bids.length - 1] : null;
          return `${a.id} "${a.title}" (${a.medium}) — ${high ? `high bid ${high.amount}c by ${high.bidder}` : `reserve ${a.reserve}c`}`;
        }).join(" | ")
      );
      return;
    }
    case "consign": {
      const artworkId = parts[1];
      if (!artworkId) {
        say(player, "Usage: ::gallery consign <artworkId> [reserve]");
        return;
      }
      const reserve = Number(parts[2]) || 0;
      const res = Galleries.consignAuction(artworkId, player, reserve);
      say(player, res.ok
        ? `Consigned "${res.auction.title}" to auction (${res.auction.id}). 3 days, reserve ${res.auction.reserve}c.`
        : `Could not consign: ${res.reason}.`);
      return;
    }
    case "bid": {
      const auctionId = parts[1];
      const amount = Number(parts[2]) || 0;
      if (!auctionId || !amount) {
        say(player, "Usage: ::gallery bid <auctionId> <amount>");
        return;
      }
      const res = Galleries.placeBid(auctionId, player, amount, payUsername);
      say(player, res.ok
        ? `Bid ${amount} coins placed${res.outbid ? ` (outbid ${res.outbid}, refunded)` : ""}. Coins held in escrow.`
        : `Could not bid: ${res.reason}${res.minBid ? ` (min ${res.minBid})` : ""}.`);
      return;
    }
    case "commissions": {
      if (!kingdomId) {
        say(player, "I don't know which kingdom you're in.");
        return;
      }
      const list = Galleries.openCommissions(kingdomId);
      if (!list.length) {
        say(player, "No open commissions in this kingdom.");
        return;
      }
      say(
        player,
        list.slice(0, 5).map((c) => `${c.id}: ${c.medium} "${c.theme}" — escrow ${c.escrow}c by ${c.patron}`).join(" | ")
      );
      return;
    }
    case "post": {
      const medium = parts[1];
      const escrow = Number(parts[2]) || 0;
      if (!medium || !escrow) {
        say(player, "Usage: ::gallery post <painting|sculpture|writing> <escrow> [theme]");
        return;
      }
      const theme = parts.slice(3).join(" ") || "untitled";
      const res = Galleries.postCommission(player, medium, theme, escrow, kingdomId);
      say(player, res.ok
        ? `Commission posted (${res.commission.id}): ${medium} "${theme}", ${escrow}c escrowed.`
        : `Could not post: ${res.reason}.`);
      return;
    }
    case "accept": {
      const commissionId = parts[1];
      if (!commissionId) {
        say(player, "Usage: ::gallery accept <commissionId>");
        return;
      }
      const res = Galleries.acceptCommission(commissionId, username);
      say(player, res.ok
        ? `Accepted commission ${commissionId}. Create the ${res.commission.medium}, then ::gallery deliver ${commissionId} <artworkId>.`
        : `Could not accept: ${res.reason}.`);
      return;
    }
    case "deliver": {
      const commissionId = parts[1];
      const artworkId = parts[2];
      if (!commissionId || !artworkId) {
        say(player, "Usage: ::gallery deliver <commissionId> <artworkId>");
        return;
      }
      const res = Galleries.deliverCommission(commissionId, artworkId, payUsername);
      say(player, res.ok
        ? `Delivered! ${res.escrow} coins released from escrow.`
        : `Could not deliver: ${res.reason}.`);
      return;
    }
    case "cancel": {
      const commissionId = parts[1];
      if (!commissionId) {
        say(player, "Usage: ::gallery cancel <commissionId>");
        return;
      }
      const res = Galleries.cancelCommission(commissionId, payUsername);
      say(player, res.ok
        ? `Commission cancelled. ${res.refunded} coins refunded.`
        : `Could not cancel: ${res.reason}.`);
      return;
    }
    case "appraise": {
      const artworkId = parts[1];
      if (!artworkId) {
        say(player, "Usage: ::gallery appraise <artworkId>");
        return;
      }
      if (!kingdomId) {
        say(player, "I don't know which kingdom you're in.");
        return;
      }
      const curs = Galleries.curatorsIn(kingdomId);
      if (!curs.length) {
        say(player, "No curator in this kingdom to appraise your piece.");
        return;
      }
      const res = Galleries.appraise(artworkId, curs[0].username, player);
      say(player, res.ok
        ? `Appraised by ${res.appraisal.curator}: valued at ${res.appraisal.value} coins (fee ${res.appraisal.fee}c).`
        : `Could not appraise: ${res.reason}.`);
      return;
    }
    case "tour": {
      const dests = parts.slice(1);
      if (!dests.length) {
        say(player, "Usage: ::gallery tour <kingdom> [kingdom...]");
        return;
      }
      const res = Galleries.sendTour(username, dests);
      say(player, res.ok
        ? `"${res.tour.name}" departs with ${res.tour.pieces.length} pieces!`
        : `Could not tour: ${res.reason}. (Curators only.)`);
      return;
    }
    default:
      say(player, GALLERY_USAGE);
  }
}

module.exports = { onGalleryCommand, GALLERY_USAGE };
