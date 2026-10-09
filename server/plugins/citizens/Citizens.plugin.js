"use strict";

/**
 * Citizens — the CITIZEN SYSTEM for The Mortal Age.
 *
 * The AI population: believable agents that play the game for real
 * (skilling, trading, guarding, socializing) instead of looping bot tasks.
 * Scripted body (BotBrain activities) + LLM mouth (the llm-gateway plugin).
 *
 * Wiring (plugins talk through custom events, never new core hooks):
 *   in:  kingdom:war-declared / kingdom:war-ended  (kingdoms plugin)
 *   in:  kingdom:office-assigned / kingdom:office-vacated (kingdoms plugin;
 *        player office-holders, so citizens address them by title)
 *   in:  citizens:chat-heard                       (chat/CitizenChat.js — all nearby citizens hear; top-2 repliers may speak)
 *   out: llm:citizen-register                      (llm-gateway plugin)
 *   out: kingdom:rank-granted                       (kingdoms plugin)
 *
 * Boot is gated on CITIZENS_ENABLED=1 so the shipped wilderness population
 * is untouched until this is deliberately switched on.
 */

const { PlayerRights } = require("../../src/main/typescript/elvarg/game/model/rights/PlayerRights");
const { onWarDeclared, onWarEnded, onOfficeAssigned, onOfficeVacated } = require("./CitizenEvents");
const { onInsuranceCommand, onPlayerDeathInsured, USAGE: INSURANCE_USAGE } = require("./CitizenInsuranceEvents");
const { onContractCommand, onWillCommand, onDisputeCommand, onRepresentCommand, CONTRACT_USAGE, WILL_USAGE, DISPUTE_USAGE, REPRESENT_USAGE } = require("./CitizenCivilEvents");
const { onTreatyCommand, USAGE: TREATY_USAGE } = require("./CitizenTreatyEvents");
const { setEmitter: setTreatyEmitter } = require("./lib/CitizenTreatyLife");
const { onSpyCommand, USAGE: SPY_USAGE } = require("./CitizenSpyEvents");
const { onCharterCommand, CHARTER_USAGE } = require("./CitizenTradeCharterEvents");
const { onDigCommand, DIG_USAGE } = require("./CitizenArchaeologyEvents");
const { onStageCommand, STAGE_USAGE } = require("./CitizenTheaterEvents");
const { onRunwayCommand, RUNWAY_USAGE } = require("./CitizenRunwayEvents");
const { onAthleticsCommand, ATHLETICS_USAGE } = require("./CitizenAthleticsEvents");
const { onCookOffCommand, COOKOFF_USAGE } = require("./CitizenCookOffEvents");
const { onFestivalCommand, FESTIVAL_USAGE } = require("./CitizenMusicFestivalEvents");
const { onMapGuildCommand, MAPGUILD_USAGE } = require("./CitizenMapGuildEvents");
const { onPressGuildCommand, PRESSGUILD_USAGE } = require("./CitizenPressGuildEvents");
const { onBankGuildCommand, BANKGUILD_USAGE } = require("./CitizenBankGuildEvents");
const { onInsureGuildCommand, INSUREGUILD_USAGE } = require("./CitizenInsureGuildEvents");
const { onLawGuildCommand, LAWGUILD_USAGE } = require("./CitizenLawGuildEvents");
const { onDiploCorpsCommand, DIPLOCORPS_USAGE } = require("./CitizenDiploCorpsEvents");
const { onSpyGuildCommand, SPYGUILD_USAGE } = require("./CitizenSpyGuildEvents");
const { onTradeGuildCommand, TRADEGUILD_USAGE } = require("./CitizenTradeGuildEvents");
const { onDigGuildCommand, DIGGUILD_USAGE } = require("./CitizenDigGuildEvents");
const { onStageGuildCommand, STAGEGUILD_USAGE } = require("./CitizenStageGuildEvents");
const { onSportsGuildCommand, SPORTSGUILD_USAGE } = require("./CitizenSportsGuildEvents");
const { onCookGuildCommand, COOKGUILD_USAGE } = require("./CitizenCookGuildEvents");
const { onWeaverGuildCommand, WEAVERGUILD_USAGE } = require("./CitizenWeaverGuildEvents");
const { onMusicGuildCommand, MUSICGUILD_USAGE } = require("./CitizenMusicGuildEvents");
const { onArtGuildCommand, ARTGUILD_USAGE } = require("./CitizenArtGuildEvents");
const { onLibrarianGuildCommand, LIBGUILD_USAGE } = require("./CitizenLibrarianGuildEvents");
const { onObservatoryGuildCommand, OBSGUILD_USAGE } = require("./CitizenObservatoryGuildEvents");
const { onGalleryCommand, GALLERY_USAGE } = require("./CitizenGalleryEvents");
const { onLibraryCommand, LIBRARY_USAGE } = require("./CitizenLibraryEvents");
const { onObservatoryCommand, OBSERVATORY_USAGE } = require("./CitizenObservatoryEvents");
const { onOfferConfirmed: onCharterOfferConfirmed } = require("./lib/CitizenCharterToll");
const { onKingdomRumor, onPatrolOrdered, onWageDay, onPlayerArrived, onSkirmish, onWarDeclaredFear, onWarEndedRelief } = require("./RealmReactions");
const { initCitizenChat, onCitizenChatHeard, onSocialPacket } = require("./chat/CitizenChat");
const { initCitizenSocial, onSocialChatResponse } = require("./chat/CitizenSocial");
const { registerCitizenActionTypes } = require("./brain/CitizenActionTypes");
const { initCitizenDecisions } = require("./brain/CitizenDecisions");
const { ATTR_CITIZEN_PERSONALITY } = require("./constants");
const { voiceFor, voiceLine } = require("./lib/citizenVoice");
const { sayPublic } = require("./chat/CitizenSayPublic");

const {
  registerCitizenActivities,
  getBaseRegistry,
} = require("./brain/CitizenActivityRegistry");
const { initDirector, getDirector } = require("./director/CitizenDirector");
const { initMerchantShops } = require("./shop/MerchantShops");
const { initPlayerShops } = require("./shop/PlayerShops");
const { initMarketBoard } = require("./shop/MarketBoard.Shops");
const { initMarketRegistrar } = require("./shop/MarketRegistrar.Shops");
const attachWarRefugees = require("./WarRefugees");
const { onPlayerLevelUpNotice, onCitizenLevelUpNotice, onPlayerDeathNotice } = require("./StreetNotices");
const { onCitizenDeath } = require("./lib/CitizenDeathRespawn");
const { onNpcKillWitnessed } = require("./StreetSpectacle");
const { onLogoutFarewell } = require("./StreetFarewells");
const { onIdleSeen, clearIdleOnLogout } = require("./StreetIdle");
const { onGiftGiven } = require("./CitizenGifts");
const { tipPerformer } = require("./lib/CitizenStreetPerformers");
const { tipBard } = require("./lib/CitizenBards");
const { tipActor } = require("./lib/CitizenActors");
const { tipPainter } = require("./lib/CitizenPainters");
const { tipSculptor } = require("./lib/CitizenSculptors");
const { tipArchitect } = require("./lib/CitizenArchitects");
const { tipEngineer } = require("./lib/CitizenEngineers");
const { tipClockmaker } = require("./lib/CitizenClockmakers");
const { tipGlassblower } = require("./lib/CitizenGlassblowers");
const { tipPotter } = require("./lib/CitizenPotters");
const { tipBusker } = require("./lib/CitizenBards2");
const { initPartyPlay } = require("./lib/CitizenPartyPlay");
const { onMentorLevelUpNotice } = require("./lib/CitizenMentors");
const {
  getMemory,
  initCitizenMemory,
  GRUDGE_ATTACK,
  GRUDGE_THEFT,
  GOSSIP_ATTACK,
  GOSSIP_THEFT,
  GOSSIP_OFFICE,
} = require("./lib/CitizenMemory");
const { initCitizenJournal } = require("./lib/CitizenJournal");
const CitizenOffices = require("./lib/CitizenOffices");
const CitizenElection = require("./lib/CitizenElection");
const KingdomStore = require("../kingdoms/KingdomStore");
const {
  EVENT_WAR_DECLARED,
  EVENT_WAR_ENDED,
  EVENT_CITIZEN_CHAT_HEARD,
  EVENT_OFFICE_ASSIGNED,
  EVENT_OFFICE_VACATED,
  ATTR_CITIZEN_ROLE,
  ATTR_KINGDOM_ID,
  ROLE_GUARD,
  ROLE_MERCHANT,
  ROLE_COMMONER,
  ROLE_COURTIER,
} = require("./constants");

function citizensEnabled() {
  // Check at runtime, not module load — the module may be cached from a
  // context where the env var wasn't set yet. Trim: batch `set VAR=1 &`
  // leaves a trailing space in the value.
  return (process.env.CITIZENS_ENABLED ?? "1").trim() === "1";
}

let pluginApi = null;

function initCitizens(api) {
  pluginApi = api;
  initCitizenChat(api);
  initCitizenSocial(api);
  initCitizenMemory();
  initCitizenJournal();
  registerCitizenActionTypes();
  const added = registerCitizenActivities();
  api.log?.("[citizens] activities registered", { added });
  // Decision layer: needs-driven activity picker + interrupt hook. Installed
  // even when the director is idle — it no-ops without citizens.
  initCitizenDecisions(getBaseRegistry());
  initMarketBoard(api);
  initMarketRegistrar(api);
  if (!citizensEnabled()) {
    api.log?.("[citizens] director idle — set CITIZENS_ENABLED=1 to spawn the population");
    return;
  }
  const director = initDirector(api, getBaseRegistry());
  director.boot();
  initMerchantShops(api);
  initPlayerShops(api);
  api.log?.("[citizens] director booted", director.status());
}

function onKingdomWarDeclared(event) {
  onWarDeclared(event);
}

function onKingdomWarEnded(event) {
  onWarEnded(event);
}

function onKingdomOfficeAssigned(event) {
  onOfficeAssigned(event);
  // Office wins travel: "Did you hear? X took the Steward's seals!"
  const holder = event?.holder;
  const kingdomId = event?.kingdomId;
  if (holder?.kind !== "player" || !holder.ref || !kingdomId) {
    return;
  }
  const memory = getMemory();
  const title =
    event.title ?? String(event.officeId ?? "office").split(":").pop();
  const kingdomName = KingdomStore.getKingdom(kingdomId)?.name ?? kingdomId;
  const seed = kingdomGossipSeed(kingdomId);
  memory.seedGossip({
    kingdomId,
    kind: GOSSIP_OFFICE,
    subject: holder.ref,
    text: `took the ${title} of ${kingdomName}!`,
    holder: seed,
  });
  pluginApi?.emitCustomEvent("kingdom:rumor", {
    kingdomId,
    text: `Did you hear? ${holder.ref} took the ${title} of ${kingdomName}!`,
  });
}

/** Any citizen username of the kingdom to seed a rumor with (online first). */
function kingdomGossipSeed(kingdomId) {
  const director = getDirector();
  if (!director) {
    return "";
  }
  const online = director.onlineBotsForKingdom(kingdomId);
  if (online.length > 0) {
    return online[0].getUsername?.() ?? "";
  }
  for (const record of director.roster.values()) {
    if (record.kingdomId === kingdomId) {
      return record.username;
    }
  }
  return "";
}

function isCitizenBot(player) {
  return player?.getAttribute?.(ATTR_CITIZEN_ROLE) != null;
}

/** Citizen bots in the player's local players (excluding `exclude`). */
function nearbyCitizens(player, exclude = null) {
  const out = [];
  for (const local of player.getLocalPlayers?.() ?? []) {
    if (local === exclude || !isCitizenBot(local)) {
      continue;
    }
    out.push(local);
  }
  return out;
}

const ATTACK_OUTCRY = [
  "Guards! I'm attacked!",
  "Help! Murder in the street!",
  "You'll pay for that, villain!",
];

/** A real player attacked a citizen: grudge, outcry, witnesses, gossip. */
function onCitizenAttackedByPlayer({ player, target }) {
  if (!player || !target) {
    return;
  }
  if (player.isPlayerBot?.() === true) {
    return; // citizen-on-citizen scraps don't make grudges
  }
  if (!isCitizenBot(target)) {
    return;
  }
  const memory = getMemory();
  const attackerName = player.getUsername?.() ?? "?";
  const victimName = target.getUsername?.() ?? "?";
  memory.addGrudge(victimName, attackerName, GRUDGE_ATTACK, "attack");
  try {
    { const _cvp = target.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(target, voiceLine(voiceFor(_cvp), { plain: [ATTACK_OUTCRY[Math.floor(Math.random() * ATTACK_OUTCRY.length)]] })); }
  } catch (error) {
    // Cosmetic.
  }
  const kingdomId = target.getAttribute?.(ATTR_KINGDOM_ID);
  for (const witness of nearbyCitizens(player, target)) {
    memory.heardAbout(
      witness.getUsername?.() ?? "?",
      attackerName,
      GOSSIP_ATTACK,
      1
    );
  }
  memory.seedGossip({
    kingdomId,
    kind: GOSSIP_ATTACK,
    subject: attackerName,
    text: `attacked ${victimName} in the street!`,
    holder: victimName,
  });
  // Guard intervention: nearby guard citizens converge on the attacker.
  // They follow to intervene; if the attacker keeps fighting, combat engages.
  try {
    guardIntervention(player, target, kingdomId);
  } catch {
    // Non-fatal — the grudge above is the important part.
  }
  pluginApi?.log?.("[citizens] citizen attacked", {
    victim: victimName,
    attacker: attackerName,
    kingdom: kingdomId,
  });
  // The victim warns their own friends: "I don't trust them, and neither
  // should you." Personal-channel shunning on top of street gossip.
  try {
    const { warnFriends } = require("./lib/CitizenRelationships");
    warnFriends(victimName, attackerName, "attack", 3);
  } catch {
    // Warnings must never break the attack path.
  }
}

/**
 * When a player attacks a citizen, nearby guards respond. They converge on
 * the attacker (follow), shout a warning, and engage in combat. This makes
 * attacking citizens have real consequences — the city fights back.
 */
const GUARD_INTERVENE_WARNINGS = [
  "Stand down! The guard is here!",
  "You dare draw steel in these streets?!",
  "Drop your weapon, criminal!",
  "The city does not tolerate violence!",
];

function guardIntervention(attacker, victim, kingdomId) {
  if (!attacker || !victim) return;
  const { getDirector } = require("./director/CitizenDirector");
  const director = getDirector?.();
  if (!director?.roster) return;
  const attackerPos = attacker.getPosition?.();
  let intervened = 0;
  for (const record of director.roster.values()) {
    if (intervened >= 3) break; // max 3 guards respond
    if (record.role !== "guard") continue;
    if (record.kingdomId !== kingdomId) continue;
    const guardBot = director.getBot?.(record);
    if (!guardBot) continue; // guard is offline
    // Only guards reasonably nearby intervene.
    try {
      const guardPos = guardBot.getPosition?.();
      if (!guardPos || !attackerPos) continue;
      const dx = Math.abs((guardPos.getX?.() ?? guardPos.x ?? 0) - (attackerPos.getX?.() ?? attackerPos.x ?? 0));
      const dy = Math.abs((guardPos.getY?.() ?? guardPos.y ?? 0) - (attackerPos.getY?.() ?? attackerPos.y ?? 0));
      if (dx > 20 || dy > 20) continue;
    } catch {
      continue;
    }
    // Converge on the attacker.
    try {
      guardBot.setFollowing?.(attacker);
    } catch { /* non-fatal */ }
    // Shout a warning.
    try {
      { const _cvp = guardBot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(guardBot, voiceLine(voiceFor(_cvp), { plain: [GUARD_INTERVENE_WARNINGS[Math.floor(Math.random() * GUARD_INTERVENE_WARNINGS.length)]] })); }
    } catch { /* non-fatal */ }
    // Engage in combat — the guard defends the city.
    try {
      guardBot.getCombat?.().attack?.(attacker);
    } catch { /* non-fatal: follow + warning still happened */ }
    // Guards remember the criminal.
    try {
      const { getMemory } = require("./lib/CitizenMemory");
      getMemory().addGrudge?.(record.username, attacker.getUsername?.() ?? "?", 3, "attack");
    } catch { /* non-fatal */ }
    intervened++;
  }
  if (intervened > 0) {
    try {
      const { getJournal } = require("./lib/CitizenJournal");
      getJournal().log?.(victim.getUsername?.() ?? "?", "combat",
        `Guards intervened against ${attacker.getUsername?.() ?? "?"} (${intervened} responded).`);
    } catch { /* non-fatal */ }
  }
}

/**
 * A player stole something with citizens watching (market stalls,
 * pickpocketing): witnesses remember the thief — cold shoulders, gossip.
 */
function onThievingWitnessed(event) {
  const player = event?.player;
  if (!player || player.isPlayerBot?.() === true) {
    return;
  }
  const witnesses = nearbyCitizens(player);
  if (witnesses.length === 0) {
    return;
  }
  const memory = getMemory();
  const thiefName = player.getUsername?.() ?? "?";
  let kingdomId = null;
  for (const witness of witnesses) {
    const witnessName = witness.getUsername?.() ?? "?";
    kingdomId = kingdomId ?? witness.getAttribute?.(ATTR_KINGDOM_ID);
    memory.recordTone(witnessName, thiefName, -2);
    memory.addGrudge(witnessName, thiefName, GRUDGE_THEFT, "theft-witnessed");
  }
  memory.seedGossip({
    kingdomId,
    kind: GOSSIP_THEFT,
    subject: thiefName,
    text: "caught stealing, bold as brass!",
    holder: witnesses[0].getUsername?.() ?? "",
  });
  pluginApi?.emitCustomEvent("kingdom:rumor", {
    kingdomId,
    text: `Did you hear what ${thiefName} did? Caught stealing at the market!`,
  });
  pluginApi?.log?.("[citizens] theft witnessed", {
    thief: thiefName,
    witnesses: witnesses.length,
    kingdom: kingdomId,
  });
}

function onKingdomOfficeVacated(event) {
  onOfficeVacated(event);
  // Release the seated citizen so the vacancy is filled fresh.
  CitizenOffices.unbindOffice(event?.officeId);
}

/**
 * A player endorses a candidate in a town election. Endorsements add
 * weight to the candidate's tally on voting day.
 */
function onElectionEndorse(event) {
  const director = getDirector();
  if (!director) {
    return;
  }
  CitizenElection.handleEndorsement(director, event);
}

/**
 * The realm calls for an office-holder: seat a living citizen of the
 * kingdom and answer with an AI holder (kind "ai", ref the office
 * identity — the contract Politics.Kingdoms challenges resolve against).
 */
function onKingdomOfficeSeeksHolder(event) {
  const director = getDirector();
  if (!director) {
    return;
  }
  const binding = CitizenOffices.fillVacancy(director, {
    officeId: event?.officeId,
    kingdomId: event?.kingdomId,
    title: event?.title,
  });
  if (!binding) {
    return;
  }
  pluginApi?.emitCustomEvent("kingdom:office-assigned", {
    officeId: event.officeId,
    kingdomId: event.kingdomId,
    title: binding.title,
    holder: { kind: "ai", ref: event.officeId },
  });
}

function onCitizenSocialPacket(event) {
  onSocialPacket(event);
}

function onSocialThreadResponse(payload) {
  onSocialChatResponse(payload);
}

function onCitizenCommand({ player, parts }) {
  const director = getDirector();
  const sub = (parts[1] ?? "status").toLowerCase();
  if (sub === "status") {
    if (!director) {
      player.sendMessage("Citizen director is not running (CITIZENS_ENABLED=0).");
      return true;
    }
    const status = director.status();
    player.sendMessage(
      `Citizens: ${status.online}/${status.total} online. ` +
        `Roles: ${JSON.stringify(status.byRole)}`
    );
    return true;
  }
  if (sub === "spawn") {
    if (!director) {
      player.sendMessage("Citizen director is not running (CITIZENS_ENABLED=0).");
      return true;
    }
    const role = (parts[2] ?? "").toLowerCase();
    const kingdomId = (parts[3] ?? "").toLowerCase();
    if (![ROLE_GUARD, ROLE_MERCHANT, ROLE_COMMONER, ROLE_COURTIER].includes(role)) {
      player.sendMessage("Usage: ::citizen spawn <guard|merchant|commoner|courtier> <kingdom>");
      return true;
    }
    const record = director.addCitizen(kingdomId, role);
    const ok = director.spawnCitizen(record);
    player.sendMessage(
      ok ? `Spawned ${record.username} (${role}, ${kingdomId}).` : "Spawn failed."
    );
    return true;
  }
  if (sub === "memory") {
    const target = (parts[2] ?? "").trim();
    if (!target) {
      player.sendMessage("Usage: ::citizen memory <player>");
      return true;
    }
    const memory = getMemory();
    const rows = [];
    for (const [key, record] of memory.citizens) {
      const held = record.players.get(target.toLowerCase());
      if (!held) {
        continue;
      }
      const standing = memory.standing(record.display, target);
      const mult = memory.priceMultiplier(record.display, target);
      rows.push(
        `${record.display}: ${standing} (met ${held.entry.met}x, spent ${held.entry.spent}, x${mult})`
      );
      if (rows.length >= 8) {
        break;
      }
    }
    player.sendMessage(
      rows.length > 0
        ? `Memory of ${target}: ${rows.join(" | ")}`
        : `No citizen remembers ${target} yet.`
    );
    return true;
  }
  player.sendMessage("Usage: ::citizen [status|spawn|memory <player>]");
  return true;
}

function onKingdomRumorHeard(event) {
  onKingdomRumor(event);
}

function onKingdomPatrolOrdered(event) {
  onPatrolOrdered(event);
}

function onKingdomWageDay(event) {
  const total = onWageDay(event) ?? 0;
  // The steward's ledger records real wages paid (kingdom:wages-paid).
  if (total > 0) {
    pluginApi?.emitCustomEvent("kingdom:wages-paid", {
      kingdomId: event?.kingdomId,
      total,
    });
  }
}

function onArrivalPlayerArrived(event) {
  onPlayerArrived(event);
}

function onKingdomSkirmish(event) {
  onSkirmish(event);
}

function onKingdomWarDeclaredFear(event) {
  onWarDeclaredFear(event);
}

function onKingdomWarEndedRelief(event) {
  onWarEndedRelief(event);
}

function onLevelUpHeard(event) {
  onPlayerLevelUpNotice(event);
  onCitizenLevelUpNotice(event);
  onMentorLevelUpNotice(event);
}

function onDeathSeen(event) {
  onPlayerDeathNotice(event);
  recordCitizenDeathSeen(event);
}

/**
 * A citizen bot died: record it in the persistent death ledger (identity,
 * kin, office, hearth respawn) via CitizenDeathRespawn.onCitizenDeath.
 * Real players pass through untouched (the isCitizenBot filter).
 */
function recordCitizenDeathSeen(event) {
  try {
    const player = event?.player;
    if (!isCitizenBot(player)) return;
    const director = getDirector();
    if (!director?.roster) return;
    onCitizenDeath(director, player, event);
  } catch {
    // Non-fatal: death recording must never break the death path.
  }
}

/** A monster died in view of the street: citizens react to the fight. */
function onKillWitnessed(event) {
  onNpcKillWitnessed(event);
}

/** A player logged out within earshot: the street bids them farewell. */
function onFarewellSeen(event) {
  onLogoutFarewell(event);
}

/** A player tick passed: the street notices players standing idle nearby. */
function onIdlePlayerSeen(event) {
  onIdleSeen(event);
}

/** A player used an item on a citizen bot: the gift moment. */
function onGiftSeen(event) {
  onGiftGiven(event);
}

/** A player used coins on a citizen bot: a tip for a street performer, bard, actor, painter, sculptor, architect, engineer, clockmaker, glassblower, potter or campfire busker. */
function onTipSeen(event) {
  tipPerformer(event);
  if (!event.handled) tipBard(event);
  if (!event.handled) tipActor(event);
  if (!event.handled) tipPainter(event);
  if (!event.handled) tipSculptor(event);
  if (!event.handled) tipArchitect(event);
  if (!event.handled) tipEngineer(event);
  if (!event.handled) tipClockmaker(event);
  if (!event.handled) tipGlassblower(event);
  if (!event.handled) tipPotter(event);
  if (!event.handled) tipBusker(event);
}

/** A player logged out: drop their idle-tracking state. */
function onIdleLogoutCleared(event) {
  clearIdleOnLogout(event);
}

/** A friend logged in: citizen friends light up and say they missed them. */
function onFriendLoggedIn(event) {
  try {
    const { getDirector } = require("./director/CitizenDirector");
    const { onFriendLogin } = require("./lib/CitizenRelationships");
    const director = getDirector?.();
    if (director) onFriendLogin(director, event?.player ?? event);
  } catch {
    // Greetings must never break login.
  }
}

/** A friend logged out: citizen friends notice the absence and miss them. */
function onFriendLoggedOut(event) {
  try {
    const { getDirector } = require("./director/CitizenDirector");
    const { onFriendLogout } = require("./lib/CitizenRelationships");
    const director = getDirector?.();
    if (director) onFriendLogout(director, event?.player ?? event);
  } catch {
    // Missing them must never break logout.
  }
}

module.exports = {
  name: "Citizens",
  register(api) {
    initCitizens(api);
    initPartyPlay(api);
    attachWarRefugees(api);
    // Treaty ratifications emit kingdom:alliance-formed through the plugin
    // api — the kingdoms layer persists the pact (complement, not duplicate).
    setTreatyEmitter((eventName, payload) => api.emitCustomEvent(eventName, payload));
    api.onCustomEvent(EVENT_WAR_DECLARED, onKingdomWarDeclared);
    api.onCustomEvent(EVENT_WAR_ENDED, onKingdomWarEnded);
    api.onCustomEvent(EVENT_WAR_DECLARED, onKingdomWarDeclaredFear);
    api.onCustomEvent(EVENT_WAR_ENDED, onKingdomWarEndedRelief);
    api.onCustomEvent("kingdom:skirmish", onKingdomSkirmish);
    api.onCustomEvent(EVENT_OFFICE_ASSIGNED, onKingdomOfficeAssigned);
    api.onCustomEvent(EVENT_OFFICE_VACATED, onKingdomOfficeVacated);
    api.onCustomEvent("kingdom:office-seeks-holder", onKingdomOfficeSeeksHolder);
    api.onCustomEvent("election:endorse", onElectionEndorse);
    // Guild charter tolls on GE sell offers (chartered goods, non-members).
    api.onCustomEvent("ge:offer-confirmed", onCharterOfferConfirmed);
    api.onCustomEvent(EVENT_CITIZEN_CHAT_HEARD, onCitizenChatHeard);
    api.onCustomEvent("llm:chat-response", onSocialThreadResponse);
    api.onCustomEvent("kingdom:rumor", onKingdomRumorHeard);
    api.onCustomEvent("kingdom:patrol-ordered", onKingdomPatrolOrdered);
    api.onCustomEvent("kingdom:wage-day", onKingdomWageDay);
    api.onCustomEvent("arrival:player-arrived", onArrivalPlayerArrived);
    api.onPlayerAttack(onCitizenAttackedByPlayer);
    api.onPlayerLevelUp(onLevelUpHeard);
    api.onPlayerDeath(onDeathSeen);
    api.onPlayerDeath(onPlayerDeathInsured);
    api.onNpcDeath(onKillWitnessed);
    api.onPlayerLogin(onFriendLoggedIn);
    api.onPlayerLogout(onFriendLoggedOut);
    api.onPlayerLogout(onFarewellSeen);
    api.onPlayerProcess(onIdlePlayerSeen);
    api.onPlayerLogout(onIdleLogoutCleared);
    api.onCustomEvent("thieving:success", onThievingWitnessed);
    api.onItemOnPlayer(onTipSeen);
    api.onItemOnPlayer(onGiftSeen);
    api.onSocialPacket(onCitizenSocialPacket);
    // Web overlay data layer for the newspaper (see interface/NewspaperApi.js).
    require("../interface/NewspaperApi").attach(api);
    api.registerCommand(
      "citizen",
      onCitizenCommand,
      PlayerRights.ADMINISTRATOR,
      "Manage AI citizens: ::citizen [status|spawn]"
    );
    api.registerCommand(
      "insurance",
      onInsuranceCommand,
      PlayerRights.NONE,
      INSURANCE_USAGE
    );
    api.registerCommand(
      "contract",
      onContractCommand,
      PlayerRights.NONE,
      CONTRACT_USAGE
    );
    api.registerCommand(
      "will",
      onWillCommand,
      PlayerRights.NONE,
      WILL_USAGE
    );
    api.registerCommand(
      "dispute",
      onDisputeCommand,
      PlayerRights.NONE,
      DISPUTE_USAGE
    );
    api.registerCommand(
      "represent",
      onRepresentCommand,
      PlayerRights.NONE,
      REPRESENT_USAGE
    );
    api.registerCommand(
      "treaty",
      onTreatyCommand,
      PlayerRights.NONE,
      TREATY_USAGE
    );
    api.registerCommand(
      "spy",
      onSpyCommand,
      PlayerRights.NONE,
      SPY_USAGE
    );
    api.registerCommand(
      "charter",
      onCharterCommand,
      PlayerRights.NONE,
      CHARTER_USAGE
    );
    api.registerCommand(
      "dig",
      onDigCommand,
      PlayerRights.NONE,
      DIG_USAGE
    );
    api.registerCommand(
      "stage",
      onStageCommand,
      PlayerRights.NONE,
      STAGE_USAGE
    );
    api.registerCommand(
      "runway",
      onRunwayCommand,
      PlayerRights.NONE,
      RUNWAY_USAGE
    );
    api.registerCommand(
      "athletics",
      onAthleticsCommand,
      PlayerRights.NONE,
      ATHLETICS_USAGE
    );
    api.registerCommand(
      "cookoff",
      onCookOffCommand,
      PlayerRights.NONE,
      COOKOFF_USAGE
    );
    api.registerCommand(
      "festival",
      onFestivalCommand,
      PlayerRights.NONE,
      FESTIVAL_USAGE
    );
    api.registerCommand(
      "gallery",
      onGalleryCommand,
      PlayerRights.NONE,
      GALLERY_USAGE
    );
    api.registerCommand(
      "library",
      onLibraryCommand,
      PlayerRights.NONE,
      LIBRARY_USAGE
    );
    api.registerCommand(
      "observatory",
      onObservatoryCommand,
      PlayerRights.NONE,
      OBSERVATORY_USAGE
    );
    api.registerCommand(
      "mapguild",
      onMapGuildCommand,
      PlayerRights.NONE,
      MAPGUILD_USAGE
    );
    api.registerCommand(
      "pressguild",
      onPressGuildCommand,
      PlayerRights.NONE,
      PRESSGUILD_USAGE
    );
    api.registerCommand(
      "bankguild",
      onBankGuildCommand,
      PlayerRights.NONE,
      BANKGUILD_USAGE
    );
    api.registerCommand(
      "insureguild",
      onInsureGuildCommand,
      PlayerRights.NONE,
      INSUREGUILD_USAGE
    );
    api.registerCommand(
      "lawguild",
      onLawGuildCommand,
      PlayerRights.NONE,
      LAWGUILD_USAGE
    );
    api.registerCommand(
      "diploguild",
      onDiploCorpsCommand,
      PlayerRights.NONE,
      DIPLOCORPS_USAGE
    );
    api.registerCommand(
      "spyguild",
      onSpyGuildCommand,
      PlayerRights.NONE,
      SPYGUILD_USAGE
    );
    api.registerCommand(
      "tradeguild",
      onTradeGuildCommand,
      PlayerRights.NONE,
      TRADEGUILD_USAGE
    );
    api.registerCommand(
      "digguild",
      onDigGuildCommand,
      PlayerRights.NONE,
      DIGGUILD_USAGE
    );
    api.registerCommand(
      "stageguild",
      onStageGuildCommand,
      PlayerRights.NONE,
      STAGEGUILD_USAGE
    );
    api.registerCommand(
      "sportsguild",
      onSportsGuildCommand,
      PlayerRights.NONE,
      SPORTSGUILD_USAGE
    );
    api.registerCommand(
      "cookguild",
      onCookGuildCommand,
      PlayerRights.NONE,
      COOKGUILD_USAGE
    );
    api.registerCommand(
      "weaverguild",
      onWeaverGuildCommand,
      PlayerRights.NONE,
      WEAVERGUILD_USAGE
    );
    api.registerCommand(
      "musicguild",
      onMusicGuildCommand,
      PlayerRights.NONE,
      MUSICGUILD_USAGE
    );
    api.registerCommand(
      "artguild",
      onArtGuildCommand,
      PlayerRights.NONE,
      ARTGUILD_USAGE
    );
    api.registerCommand(
      "libguild",
      onLibrarianGuildCommand,
      PlayerRights.NONE,
      LIBGUILD_USAGE
    );
    api.registerCommand(
      "obsguild",
      onObservatoryGuildCommand,
      PlayerRights.NONE,
      OBSGUILD_USAGE
    );
  },
};
