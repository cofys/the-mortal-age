"use strict";

/**
 * Politics.Kingdoms — petitions, challenges, and trials of service.
 *
 * Offices change hands by politics, not command. A subject of a kingdom may
 * petition its court:
 *
 *   vacant office  -> the court appoints, if the petitioner's influence
 *                     clears PETITION_THRESHOLD (100). Service, not seniority.
 *   held office    -> the petitioner challenges the holder. The court weighs
 *                     the petitioner's influence against the holder's standing:
 *                       influence >= standing + 75  -> granted outright
 *                       influence >= standing - 25  -> trial of service
 *                       otherwise                   -> rejected + 7-day cooldown
 *
 * Holder standing: an AI holder's base (180) grows with tenure (+1/day,
 * capped +50) — the longer they serve, the harder they are to dislodge. A
 * player holder defends with their own influence plus an incumbency bonus
 * (+50): taking an office from a living rival means out-serving them.
 *
 * A trial of service is the court's compromise: deliver 5,000 coins to the
 * war effort within 7 days and the seals are yours. Fail or let it lapse
 * and the court will not hear you for 7 days.
 *
 * Safeguards: one office per player per kingdom; CHALLENGE_THRESHOLD (250)
 * to even be heard; 7-day cooldown after a lost challenge (also applied to
 * a deposed holder, so no instant rematch).
 *
 * Everything the court decides travels the event bus:
 *   kingdom:office-vacated / kingdom:office-assigned do the seating (the
 *     citizens director unbinds/rebinds on those — unbinding is clean because
 *     a challenge always vacates before it assigns).
 *   kingdom:challenge-decided { officeId, kingdomId, petitioner, holder,
 *     outcome: "granted"|"trial"|"rejected", influence, standing, reason }
 *     lets other systems (citizens, future LLM court flavor) observe.
 *
 * Player surface: ::office petition <officeId>, ::office influence [kingdom],
 * ::donate <kingdom> <amount>. ::office claim routes through petition for
 * vacant offices (see Commands.Kingdoms.js).
 */

const Offices = require("./Offices.Kingdoms");
const Store = require("./KingdomStore");
const Influence = require("./Influence.Kingdoms");
const Membership = require("./Membership.Kingdoms");

const DAY_MS = 24 * 60 * 60 * 1000;
const COINS_ID = 995;

/** Standing of an AI office-holder: base respect plus tenure, capped. */
const AI_HOLDER_BASE_STANDING = 180;
const AI_HOLDER_TENURE_PER_DAY = 1;
const AI_HOLDER_TENURE_CAP = 50;
/** A living holder defends with their own influence plus this. */
const INCUMBENCY_BONUS = 50;
/** Win outright when influence clears standing by this much. */
const DECISIVE_MARGIN = 75;
/** Earn a trial when influence lands within this much below standing. */
const TRIAL_BAND = 25;
/** The court's price for a trial: coins to the war effort, within the deadline. */
const TRIAL_TARGET_COINS = 5000;
const TRIAL_DURATION_MS = 7 * DAY_MS;

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

function officeLabel(office) {
  return `${office.title} of ${kingdomName(office.kingdomId)}`;
}

/** True when the player already holds any office in this kingdom. */
function holdsOfficeIn(username, kingdomId) {
  return Offices.getOffices(kingdomId).some(
    (o) => o.holder?.kind === "player" && o.holder.ref === username
  );
}

/** What the court weighs a holder at. */
function holderStanding(office) {
  const holder = office.holder;
  if (!holder) return 0;
  if (holder.kind === "player") {
    let influence = 0;
    try {
      const rival = pluginApi.core.World.getPlayerByName(holder.ref);
      if (rival) influence = Influence.effectiveInfluence(rival, office.kingdomId);
    } catch {
      influence = 0;
    }
    return influence + INCUMBENCY_BONUS;
  }
  const days = Math.max(0, (Date.now() - (office.holderSince ?? Date.now())) / DAY_MS);
  return (
    AI_HOLDER_BASE_STANDING +
    Math.min(AI_HOLDER_TENURE_CAP, Math.floor(days * AI_HOLDER_TENURE_PER_DAY))
  );
}

function holderDescription(office) {
  const holder = office.holder;
  if (!holder) return "vacant";
  if (holder.kind === "player") return holder.ref;
  return `the court's ${office.title.toLowerCase()} (${holder.ref})`;
}

/** Seat a player: always vacate first so bound citizens unbind cleanly. */
function seatPlayer(username, office) {
  pluginApi.emitCustomEvent("kingdom:office-vacated", {
    officeId: office.officeId,
    kingdomId: office.kingdomId,
  });
  pluginApi.emitCustomEvent("kingdom:office-assigned", {
    officeId: office.officeId,
    kingdomId: office.kingdomId,
    title: office.title,
    holder: { kind: "player", ref: username },
  });
}

function emitDecision({ office, petitioner, holder, outcome, influence, standing, reason }) {
  pluginApi.emitCustomEvent("kingdom:challenge-decided", {
    officeId: office.officeId,
    kingdomId: office.kingdomId,
    petitioner,
    holder: holder ? { ...holder } : null,
    outcome,
    influence,
    standing,
    reason: reason ?? null,
  });
}

/** A vacant office: the court appoints on proven service. */
function petitionVacant(player, username, office) {
  const influence = Influence.effectiveInfluence(player, office.kingdomId);
  if (influence < Influence.PETITION_THRESHOLD) {
    player.sendMessage(
      `[Court] The ${officeLabel(office)} stands vacant, but the court does not hand seals to strangers. ` +
        `Your influence with ${kingdomName(office.kingdomId)} is ${influence}; ` +
        `the court expects ${Influence.PETITION_THRESHOLD}. Serve the realm — donate to the war effort, earn promotion — and petition again.`
    );
    return;
  }
  seatPlayer(username, office);
  emitDecision({
    office,
    petitioner: username,
    holder: null,
    outcome: "granted",
    influence,
    standing: 0,
    reason: "vacant office; petitioner cleared the influence threshold",
  });
  player.sendMessage(
    `[Court] The court has weighed your service (${influence} influence) and finds it sufficient. ` +
      `You are named ${office.title} of ${kingdomName(office.kingdomId)}. Rule well.`
  );
}

/** A held office: the court hears the challenge and rules. */
function challenge(player, username, office) {
  const officeId = office.officeId;
  const remaining = Influence.challengeCooldownRemainingMs(player, officeId);
  if (remaining > 0) {
    const days = Math.ceil(remaining / DAY_MS);
    player.sendMessage(
      `[Court] The court will not hear you again so soon. Return in ${days} day${days === 1 ? "" : "s"}.`
    );
    return;
  }
  const influence = Influence.effectiveInfluence(player, office.kingdomId);
  if (influence < Influence.CHALLENGE_THRESHOLD) {
    player.sendMessage(
      `[Court] To challenge ${holderDescription(office)} for the ${officeLabel(office)}, ` +
        `the court expects ${Influence.CHALLENGE_THRESHOLD} influence. Yours is ${influence}. ` +
        `Serve the realm first — the court hears the proven, not the eager.`
    );
    return;
  }
  const standing = holderStanding(office);
  const holder = office.holder ? { ...office.holder } : null;
  // Describe the deposed holder BEFORE seating: seatPlayer mutates the live record.
  const deposedDesc = holderDescription(office);

  if (influence >= standing + DECISIVE_MARGIN) {
    seatPlayer(username, office);
    deposedCooldown(holder, office);
    emitDecision({ office, petitioner: username, holder, outcome: "granted", influence, standing,
      reason: "petitioner's influence decisively outweighed the holder's standing" });
    player.sendMessage(
      `[Court] The deliberation is short. Your service (${influence}) towers over ` +
        `${deposedDesc}'s standing (${standing}). ` +
        `The seals of ${office.title} are yours, ${username}.`
    );
    return;
  }
  if (influence >= standing - TRIAL_BAND) {
    Influence.setTrial(player, {
      officeId,
      kingdomId: office.kingdomId,
      holderKind: holder.kind,
      holderRef: holder.ref,
      target: TRIAL_TARGET_COINS,
      progress: 0,
      deadline: Date.now() + TRIAL_DURATION_MS,
    });
    emitDecision({ office, petitioner: username, holder, outcome: "trial", influence, standing,
      reason: `trial of service: donate ${TRIAL_TARGET_COINS} coins within 7 days` });
    player.sendMessage(
      `[Court] A divided court. Your influence (${influence}) presses hard against ` +
        `${holderDescription(office)}'s standing (${standing}), but not hard enough to take the seals outright. ` +
        `Prove yourself: deliver ${TRIAL_TARGET_COINS} coins to the ${kingdomName(office.kingdomId)} war effort ` +
        `within 7 days (::donate ${office.kingdomId} <amount>), and the office is yours.`
    );
    return;
  }
  Influence.setChallengeCooldown(player, officeId);
  emitDecision({ office, petitioner: username, holder, outcome: "rejected", influence, standing,
    reason: "petitioner's influence fell well short of the holder's standing" });
  player.sendMessage(
    `[Court] The court rules against you. Your influence (${influence}) does not threaten ` +
      `${holderDescription(office)}'s standing (${standing}). ` +
      `Serve the realm, grow your name, and return in 7 days.`
  );
}

/** A deposed player holder may not instantly re-challenge. */
function deposedCooldown(holder, office) {
  if (!holder || holder.kind !== "player") return;
  try {
    const rival = pluginApi.core.World.getPlayerByName(holder.ref);
    if (rival) Influence.setChallengeCooldown(rival, office.officeId);
  } catch {
    // Offline rival: their influence decays while they're gone anyway.
  }
}

/**
 * ::office petition <officeId> — petition for a vacant office or challenge
 * a held one. (Also the backing for ::office claim on vacant offices.)
 */
function petition(player, args) {
  const officeId = args[0];
  const office = Offices.getOffice(officeId);
  if (!office) {
    player.sendMessage("[Offices] No such office. Try ::office list");
    return;
  }
  const username = usernameOf(player);
  if (!username) return;
  if ((player.getAttribute?.(Membership.KINGDOM_ID_ATTRIBUTE) ?? null) !== office.kingdomId) {
    player.sendMessage(
      `[Court] You swear fealty to no ${kingdomName(office.kingdomId)} court. ` +
        `Serve the kingdom first — then petition.`
    );
    return;
  }
  if (holdsOfficeIn(username, office.kingdomId)) {
    player.sendMessage("[Court] One office per subject — you already hold seals in this kingdom.");
    return;
  }
  const holder = office.holder;
  if (!holder) return petitionVacant(player, username, office);
  if (holder.kind === "player" && holder.ref === username) {
    player.sendMessage(`[Offices] You already hold the office of ${office.title}.`);
    return;
  }
  return challenge(player, username, office);
}

/** kingdom:donation-made — influence for the gift, progress for an active trial. */
function onDonationMade(event) {
  const player = event?.player;
  const kingdomId = event?.kingdomId;
  const amount = Math.floor(event?.amount ?? 0);
  if (!player?.sendMessage || !kingdomId || !(amount > 0)) return;
  const gained = Influence.addInfluence(player, kingdomId, Math.floor(amount * Influence.INFLUENCE_PER_COIN));
  if (gained > 0) {
    player.sendMessage(
      `[Influence] +${gained} influence with ${kingdomName(kingdomId)} for your war-effort donation.`
    );
  }
  advanceTrial(player, kingdomId, amount);
}

function advanceTrial(player, kingdomId, amount) {
  const trial = Influence.getTrial(player);
  if (!trial || trial.kingdomId !== kingdomId) return;
  const username = usernameOf(player);
  if (Date.now() > trial.deadline) {
    Influence.clearTrial(player);
    Influence.setChallengeCooldown(player, trial.officeId);
    player.sendMessage(
      "[Court] Your seven days are spent and the coffers are still short. " +
        "The court withdraws its offer — it will not hear you again for 7 days."
    );
    return;
  }
  const progress = (trial.progress ?? 0) + amount;
  if (progress >= trial.target) {
    completeTrial(player, username, trial);
    return;
  }
  Influence.setTrial(player, { ...trial, progress });
  player.sendMessage(
    `[Court] The court notes your gift: ${progress}/${trial.target} coins toward your trial of service.`
  );
}

function completeTrial(player, username, trial) {
  const office = Offices.getOffice(trial.officeId);
  const holder = office?.holder;
  const holderChanged =
    !holder || holder.kind !== trial.holderKind || holder.ref !== trial.holderRef;
  Influence.clearTrial(player);
  if (holderChanged || !office) {
    player.sendMessage(
      "[Court] The seals have changed hands while you proved yourself — your trial is void. " +
        "Petition anew if you still want the office."
    );
    return;
  }
  if (holdsOfficeIn(username, office.kingdomId)) {
    player.sendMessage("[Court] You have taken other seals since — one office per subject. The trial is void.");
    return;
  }
  seatPlayer(username, office);
  deposedCooldown({ ...holder }, office);
  emitDecision({ office, petitioner: username, holder: { ...holder }, outcome: "granted",
    influence: Influence.effectiveInfluence(player, office.kingdomId),
    standing: holderStanding(office),
    reason: "trial of service completed" });
  player.sendMessage(
    `[Court] ${trial.target} coins. Seven days. Done. The court keeps its word — ` +
      `you are named ${office.title} of ${kingdomName(office.kingdomId)}.`
  );
}

/** ::donate <kingdom> <amount> — coins from your purse to the war effort. */
function donateCommand(player, args) {
  const kingdomId = (args[0] ?? "").toLowerCase();
  const amount = Math.floor(Number(args[1] ?? 0));
  const kingdom = Store.getKingdom(kingdomId);
  if (!kingdom) {
    player.sendMessage("Usage: ::donate <kingdom> <amount>  (e.g. ::donate asgarnia 1000)");
    return;
  }
  if ((player.getAttribute?.(Membership.KINGDOM_ID_ATTRIBUTE) ?? null) !== kingdomId) {
    player.sendMessage(`[War effort] You must serve ${kingdom.name} to fund its war.`);
    return;
  }
  if (!(amount > 0)) {
    player.sendMessage("Usage: ::donate <kingdom> <amount>  (e.g. ::donate asgarnia 1000)");
    return;
  }
  const inventory = player.getInventory?.();
  const have = inventory?.getAmount?.(COINS_ID) ?? 0;
  if (have < amount) {
    player.sendMessage(`[War effort] You carry ${have} coins — the realm asks for ${amount}.`);
    return;
  }
  inventory.delete(COINS_ID, amount);
  inventory.refreshItems?.();
  Store.grantTax(kingdomId, amount);
  Store.save();
  pluginApi.emitCustomEvent("kingdom:donation-made", { player, kingdomId, amount });
  player.sendMessage(
    `[War effort] You deliver ${amount} coins to the ${kingdom.name} war chest. The court notes your generosity.`
  );
}

/** ::office influence [kingdom] — where you stand with a court. */
function showInfluence(player, args) {
  const kingdomId =
    (args[0] ?? "").toLowerCase() ||
    player.getAttribute?.(Membership.KINGDOM_ID_ATTRIBUTE) ||
    null;
  if (!kingdomId || !Store.getKingdom(kingdomId)) {
    player.sendMessage("Usage: ::office influence <kingdom>");
    return;
  }
  const influence = Influence.effectiveInfluence(player, kingdomId);
  const trial = Influence.getTrial(player);
  player.sendMessage(
    `[Influence] ${kingdomName(kingdomId)}: ${influence} influence ` +
      `(petition: ${Influence.PETITION_THRESHOLD}, challenge: ${Influence.CHALLENGE_THRESHOLD}). ` +
      `Raw service decays ${Influence.INFLUENCE_DECAY_PER_DAY}/day idle; long membership is never forgotten.`
  );
  if (trial && trial.kingdomId === kingdomId) {
    const days = Math.max(0, Math.ceil((trial.deadline - Date.now()) / DAY_MS));
    player.sendMessage(
      `[Trial] ${trial.progress ?? 0}/${trial.target} coins delivered — ${days} day${days === 1 ? "" : "s"} remain.`
    );
  }
}

function attachPolitics(api) {
  pluginApi = api;
  api.registerCommand(
    "donate",
    donateCommand,
    api.core.PlayerRights.NONE,
    "Donate coins to your kingdom's war effort: ::donate <kingdom> <amount>"
  );
}

module.exports = attachPolitics;
module.exports.petition = petition;
module.exports.showInfluence = showInfluence;
module.exports.onDonationMade = onDonationMade;
module.exports.holderStanding = holderStanding;
module.exports.TRIAL_TARGET_COINS = TRIAL_TARGET_COINS;
