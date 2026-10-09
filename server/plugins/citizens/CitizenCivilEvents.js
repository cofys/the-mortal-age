"use strict";

/**
 * CitizenCivilEvents — player-facing civil law: the ::contract, ::will,
 * ::dispute, and ::represent commands.
 *
 * Mirrors the PlayerShops command pattern (PlayerRights.NONE so every
 * player can use it). All coin movement is real: witness fees, filing
 * fees, and advocate fees leave the player's real inventory. Contracts
 * between players are witnessed the same as citizen contracts.
 */

const CivilLaw = require("./lib/CitizenCivilLaw");

const CONTRACT_USAGE =
  "Contracts: ::contract [make <type> <party> <amount> <days> <description>|list|fulfill <id>]";
const WILL_USAGE =
  "Wills: ::will [make <heir1:share> [heir2:share] ...|show]";
const DISPUTE_USAGE =
  "Disputes: ::dispute [file <type> <defendant> <claim>|list|represent <id>]";
const REPRESENT_USAGE =
  "Represent: ::represent <dispute-id> — act as advocate in a civil dispute.";

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function kingdomOf(player) {
  try {
    return player?.getAttribute?.("kingdom:id") ?? player?.getAttribute?.("kingdomId") ?? null;
  } catch {
    return null;
  }
}

function onContractCommand({ player, parts }) {
  if (!player || player.isPlayerBot?.() === true) return true;
  const username = usernameOf(player);
  const sub = String(parts[1] ?? "help").toLowerCase();
  try {
    switch (sub) {
      case "help":
        player.sendMessage("Contracts are witnessed agreements — service, trade, or lease.");
        player.sendMessage("::contract make <service|trade|lease> <party> <amount> <days> <description>");
        player.sendMessage("::contract list — your contracts. ::contract fulfill <id> — mark one done.");
        player.sendMessage(`Witness fee: ${CivilLaw.CONTRACT_WITNESS_FEE} coins, paid honestly.`);
        return true;
      case "list": {
        const mine = CivilLaw.contractsOf(username);
        if (mine.length === 0) {
          player.sendMessage("You have no contracts on record.");
          return true;
        }
        for (const c of mine.slice(0, 10)) {
          player.sendMessage(`${c.id}: ${c.type} with ${c.partyA === username.toLowerCase() ? c.displayB : c.displayA} — ${c.amount} coins, ${c.status}.`);
        }
        return true;
      }
      case "make": {
        const type = String(parts[2] ?? "").toLowerCase();
        const party = String(parts[3] ?? "");
        const amount = Math.floor(Number(parts[4]) || 0);
        const days = Math.max(1, Math.floor(Number(parts[5]) || 7));
        const description = parts.slice(6).join(" ") || `${type} agreement`;
        if (!CivilLaw.CONTRACT_TYPES[type] || !party || amount <= 0) {
          player.sendMessage("Usage: ::contract make <service|trade|lease> <party> <amount> <days> <description>");
          return true;
        }
        const res = CivilLaw.createContract({
          type, partyA: username, partyB: party, amount,
          deadlineMs: Date.now() + days * 24 * 3600 * 1000,
          description, kingdomId: kingdomOf(player), proposerPlayer: player,
        });
        if (!res.ok) {
          player.sendMessage(`Could not witness the contract: ${res.reason}. (Fee: ${CivilLaw.CONTRACT_WITNESS_FEE} coins.)`);
          return true;
        }
        player.sendMessage(`Contract ${res.contract.id} witnessed: ${type} with ${party} for ${amount} coins, due in ${days} days.`);
        return true;
      }
      case "fulfill": {
        const id = String(parts[2] ?? "");
        const c = CivilLaw.contractById(id);
        if (!c || c.status !== "active") {
          player.sendMessage("No such active contract.");
          return true;
        }
        const norm = username.toLowerCase();
        if (c.partyA !== norm && c.partyB !== norm) {
          player.sendMessage("You are not a party to that contract.");
          return true;
        }
        // The paying party: service → partyA (hirer); trade/lease → partyB.
        const payerNorm = c.type === "service" ? c.partyA : c.partyB;
        if (payerNorm !== norm) {
          player.sendMessage("Only the paying party can fulfill — the court watches the deadline.");
          return true;
        }
        // Resolve only the actual player; the counterparty may be offline
        // (their share goes to their bank account, honestly).
        const playerFor = (name) => String(name || "").toLowerCase() === norm ? player : null;
        const res = CivilLaw.fulfillContract(id, playerFor);
        if (!res.ok) {
          player.sendMessage(`Could not fulfill: ${res.reason}.`);
          return true;
        }
        player.sendMessage(`Contract ${id} fulfilled — ${res.paid} coins paid.`);
        return true;
      }
      default:
        player.sendMessage(CONTRACT_USAGE);
        return true;
    }
  } catch {
    return true;
  }
}

function onWillCommand({ player, parts }) {
  if (!player || player.isPlayerBot?.() === true) return true;
  const username = usernameOf(player);
  const sub = String(parts[1] ?? "help").toLowerCase();
  try {
    switch (sub) {
      case "help":
        player.sendMessage("A will decides who inherits your coins when you die.");
        player.sendMessage("::will make <heir1:share> [heir2:share] ... — shares must sum to 1 (e.g. Bob:0.6 Carol:0.4).");
        player.sendMessage("::will show — read your registered will.");
        player.sendMessage("No will? The court divides your estate: 20% to the crown, the rest to your close associates.");
        return true;
      case "show": {
        const w = CivilLaw.willFor(username);
        if (!w) {
          player.sendMessage("You have no registered will.");
          return true;
        }
        player.sendMessage("Your will: " + w.heirs.map((h) => `${h.display} (${Math.round(h.share * 100)}%)`).join(", "));
        return true;
      }
      case "make": {
        const heirs = [];
        for (let i = 2; i < parts.length; i++) {
          const [name, shareStr] = String(parts[i]).split(":");
          const share = Number(shareStr);
          if (!name || !(share > 0)) {
            player.sendMessage("Usage: ::will make <heir1:share> [heir2:share] ... (e.g. Bob:0.6 Carol:0.4)");
            return true;
          }
          heirs.push({ username: name, share });
        }
        const res = CivilLaw.registerWill(username, heirs, null);
        if (!res.ok) {
          player.sendMessage(`Could not register the will: ${res.reason}. Shares must sum to 1.`);
          return true;
        }
        player.sendMessage("Your will is registered with the court.");
        return true;
      }
      default:
        player.sendMessage(WILL_USAGE);
        return true;
    }
  } catch {
    return true;
  }
}

function onDisputeCommand({ player, parts }) {
  if (!player || player.isPlayerBot?.() === true) return true;
  const username = usernameOf(player);
  const sub = String(parts[1] ?? "help").toLowerCase();
  try {
    switch (sub) {
      case "help":
        player.sendMessage("Disputes: breach (broken contract), debt (unpaid), defamation (false statements).");
        player.sendMessage("::dispute file <breach|debt|defamation> <defendant> <claim>");
        player.sendMessage("::dispute list — your disputes. Mediation first, then a hearing before the judge.");
        player.sendMessage(`Filing fee: ${CivilLaw.DISPUTE_FILING_FEE} coins, paid honestly.`);
        return true;
      case "list": {
        const mine = CivilLaw.disputesOf(username);
        if (mine.length === 0) {
          player.sendMessage("You have no disputes on record.");
          return true;
        }
        for (const d of mine.slice(0, 10)) {
          const other = d.plaintiff === username.toLowerCase() ? d.displayDefendant : d.displayPlaintiff;
          player.sendMessage(`${d.id}: ${d.type} vs ${other} — claim ${d.claim}, ${d.status}.`);
        }
        return true;
      }
      case "file": {
        const type = String(parts[2] ?? "").toLowerCase();
        const defendant = String(parts[3] ?? "");
        const claim = Math.floor(Number(parts[4]) || 0);
        if (!CivilLaw.DISPUTE_TYPES[type] || !defendant || claim <= 0) {
          player.sendMessage("Usage: ::dispute file <breach|debt|defamation> <defendant> <claim>");
          return true;
        }
        const res = CivilLaw.fileDispute({
          type, plaintiff: username, defendant, claim,
          kingdomId: kingdomOf(player), plaintiffPlayer: player,
        });
        if (!res.ok) {
          player.sendMessage(`Could not file: ${res.reason}. (Fee: ${CivilLaw.DISPUTE_FILING_FEE} coins.)`);
          return true;
        }
        player.sendMessage(`Dispute ${res.dispute.id} filed. The court will attempt mediation, then a hearing.`);
        return true;
      }
      case "represent":
        return onRepresentCommand({ player, parts });
      default:
        player.sendMessage(DISPUTE_USAGE);
        return true;
    }
  } catch {
    return true;
  }
}

function onRepresentCommand({ player, parts }) {
  if (!player || player.isPlayerBot?.() === true) return true;
  const username = usernameOf(player);
  const id = String(parts[1] ?? parts[2] ?? "");
  try {
    if (!id) {
      player.sendMessage(REPRESENT_USAGE);
      return true;
    }
    const d = CivilLaw.disputeById(id);
    if (!d) {
      player.sendMessage("No such dispute.");
      return true;
    }
    const norm = username.toLowerCase();
    if (d.plaintiff === norm || d.defendant === norm) {
      player.sendMessage("You cannot represent yourself — the court requires independent counsel.");
      return true;
    }
    // Represent whichever party lacks an advocate (plaintiff first).
    const party = !CivilLaw.advocateFor(id, d.plaintiff) ? d.plaintiff : d.defendant;
    if (CivilLaw.advocateFor(id, party)) {
      player.sendMessage("Both parties already have advocates.");
      return true;
    }
    // The advocate's presence is what matters at the hearing; players
    // advocate pro bono (no fee collection from citizens here).
    const res = CivilLaw.hireAdvocate(id, party, username, false);
    if (!res.ok) {
      player.sendMessage(`Could not take the case: ${res.reason}.`);
      return true;
    }
    const partyDisplay = party === d.plaintiff ? d.displayPlaintiff : d.displayDefendant;
    player.sendMessage(`You now represent ${partyDisplay} in dispute ${id} (${d.type}). Argue well at the hearing.`);
    return true;
  } catch {
    return true;
  }
}

module.exports = {
  onContractCommand,
  onWillCommand,
  onDisputeCommand,
  onRepresentCommand,
  CONTRACT_USAGE,
  WILL_USAGE,
  DISPUTE_USAGE,
  REPRESENT_USAGE,
};
