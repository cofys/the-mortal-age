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
const { sayPublic, setNearbyResolver } = require("./chat/CitizenSayPublic");

const {
  registerCitizenActivities,
  getBaseRegistry,
} = require("./brain/CitizenActivityRegistry");
const { initDirector, getDirector } = require("./director/CitizenDirector");
const BossRuns = require("./lib/CitizenBossRuns");
const { initMerchantShops } = require("./shop/MerchantShops");
const { initPlayerShops } = require("./shop/PlayerShops");
const { initMarketBoard } = require("./shop/MarketBoard.Shops");
const { initMarketRegistrar } = require("./shop/MarketRegistrar.Shops");
const attachWarRefugees = require("./WarRefugees");
const { onPlayerLevelUpNotice, onCitizenLevelUpNotice, onPlayerDeathNotice } = require("./StreetNotices");
const { onCitizenDeath } = require("./lib/CitizenDeathRespawn");
const { onNpcKillWitnessed, onPlayerDropWitnessed } = require("./StreetSpectacle");
const { onLogoutFarewell } = require("./StreetFarewells");
const { onIdleSeen, clearIdleOnLogout } = require("./StreetIdle");
const { onGiftGiven } = require("./CitizenGifts");
const { initCitizenLoot, onCitizenDropsRolled } = require("./brain/actions/CitizenLoot");
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
const { initFollowOption } = require("./lib/CitizenFollowOption");
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

/**
 * Wire the World-aware asymmetric chat recipient resolver into
 * CitizenSayPublic. The citizen's own getLocalPlayers() is symmetric and can
 * be empty/stale for bots — overhead bubbles render (forceChat is direct)
 * but no chat-box packet reaches a real player the citizen doesn't list.
 * This mirrors ChatPacketListener.handleText: start from the speaker's local
 * list, then add real players from the spatial bucket index whose own local
 * list includes the speaker (they render the citizen even when the citizen
 * can't render them).
 */
function initCitizenChatResolver(api) {
  try {
    const World = api?.core?.World;
    if (!World || typeof World.getNearbyPlayersForUpdate !== "function") {
      return;
    }
    setNearbyResolver((citizen) => {
      const seen = new Set();
      const out = [];
      const push = (p) => {
        if (!p || seen.has(p)) return;
        seen.add(p);
        out.push(p);
      };
      try {
        for (const p of citizen.getLocalPlayers?.() ?? []) push(p);
      } catch {
        // Fall through to the bucket lookup.
      }
      try {
        for (const p of World.getNearbyPlayersForUpdate(citizen) ?? []) {
          if (seen.has(p)) continue;
          try {
            if (p.getLocalPlayers?.().includes(citizen)) push(p);
          } catch {
            // Skip unreadable players.
          }
        }
      } catch {
        // Bucket lookup failing doesn't break the symmetric path.
      }
      return out;
    });
  } catch {
    // Resolver wiring is best-effort; the symmetric default still works.
  }
}

function initCitizens(api) {
  pluginApi = api;
  initCitizenChatResolver(api);
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

function onBossRunDropsGenerated(event) {
  try {
    const director = getDirector();
    if (!director) return;
    BossRuns.handleNpcDropsGenerated(director, event);
  } catch {
    // Non-fatal — the engine drops spawn as usual.
  }
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

/**
 * ::citizens — admin diagnostic: what are citizens doing RIGHT NOW?
 * Jon (2026-10-12): needs immediate visibility into brain activity without
 * the worldmap overlay. Outputs to chatbox:
 * - Total materialized citizens
 * - Breakdown by current activity
 * - For idle: avg/max seconds since brain last ticked
 */
function onCitizensDiagCommand({ player }) {
  const director = getDirector();
  if (!director?.roster) {
    player.sendMessage("Citizen director is not running.");
    return true;
  }
  const now = Date.now();
  let materialized = 0;
  const byActivity = {};
  const idleStaleSecs = [];
  for (const record of director.roster.values()) {
    let bot = null;
    try {
      bot = director.getBot?.(record);
    } catch {
      bot = null;
    }
    if (!bot) continue;
    materialized++;
    const activity = record.currentActivityId || "none";
    byActivity[activity] = (byActivity[activity] ?? 0) + 1;
    // Track staleness for idle/standing citizens
    const act = String(activity).toLowerCase();
    if (act === "none" || act.includes("idle") || act.includes("stand") || act.includes("rest")) {
      const lastTick = record.lastTickAt || 0;
      const staleSec = lastTick > 0 ? Math.round((now - lastTick) / 1000) : -1;
      if (staleSec >= 0) idleStaleSecs.push(staleSec);
    }
  }
  player.sendMessage(`Citizens materialized: ${materialized}/${director.roster.size}`);
  const breakdown = Object.entries(byActivity)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([act, n]) => `${act}: ${n}`)
    .join(", ");
  player.sendMessage(`Activities: ${breakdown || "none"}`);
  if (idleStaleSecs.length > 0) {
    const avg = Math.round(idleStaleSecs.reduce((a, b) => a + b, 0) / idleStaleSecs.length);
    const max = Math.max(...idleStaleSecs);
    player.sendMessage(`Idle brains (n=${idleStaleSecs.length}): last tick avg ${avg}s ago, max ${max}s ago`);
  } else {
    player.sendMessage("No idle citizens detected.");
  }
  return true;
}

/** Jon 2026-10-13: owner-only ::run — reset run energy to 100. */
function onRunCommand({ player }) {
  try {
    player?.setRunEnergy?.(100);
    player?.getPacketSender?.()?.sendRunEnergy?.();
    player?.sendMessage?.("Run energy restored to 100%.");
  } catch {
    // best-effort
  }
  return true;
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
  if (onMilitiaDeathSeen(event)) return; // war dead get funerals, not respawns
  recordCitizenDeathSeen(event);
}

/**
 * A militia citizen fell in battle: permanent death with full funeral rites.
 * War has real casualties — the fallen don't respawn at the hearth. The
 * funeral system (CitizenFunerals.recordDeath) handles mourning, burial,
 * obituaries, and roster removal. Returns true if handled.
 */
function onMilitiaDeathSeen(event) {
  try {
    const player = event?.player;
    if (!isCitizenBot(player)) return false;
    const username = player?.getUsername?.();
    if (!username) return false;
    const Militia = require("../kingdoms/Militia.Kingdoms");
    if (!Militia.isMilitia(username)) return false;
    const director = getDirector();
    if (!director?.roster) return false;
    const record = director.roster.get(username.toLowerCase().trim());
    if (!record) return false;
    const rec = Militia.militiaOf(username);
    const kingdomId = rec?.kingdomId ?? record.kingdomId;
    let kingdomName = String(kingdomId);
    try {
      const k = require("../kingdoms/KingdomStore").getKingdom(kingdomId);
      if (k?.name) kingdomName = k.name;
    } catch {
      // Name is cosmetic.
    }
    const cause =
      rec?.side === "attacker"
        ? `fell in battle attacking for ${kingdomName}`
        : `fell in battle defending ${kingdomName}`;
    const { recordDeath } = require("./lib/CitizenFunerals");
    recordDeath(director, record, cause, Date.now());
    Militia.discharge(username, kingdomId);
    Militia.recordDeath(kingdomId);
    return true;
  } catch {
    return false; // fall through to normal death handling
  }
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
  onMilitiaKillSeen(event);
}

/** A player rolled a notable drop in view of the street: the street gzs. */
function onDropWitnessed(event) {
  onPlayerDropWitnessed(event);
}

/**
 * A militia citizen killed an enemy: record it for the war tally.
 * Militia kills feed siege power (every 10 kills = +1 power).
 */
function onMilitiaKillSeen(event) {
  try {
    const killer = event?.killer;
    const npc = event?.npc;
    if (!killer || !npc) return;
    if (!isCitizenBot(killer)) return;
    const username = killer.getUsername?.();
    if (!username) return;
    const Militia = require("../kingdoms/Militia.Kingdoms");
    const rec = Militia.militiaOf(username);
    if (!rec) return;
    // Field-battle kills count toward the battle as well as the tally.
    const battleTag = npc.warBattle;
    if (battleTag?.battleId) {
      try {
        const Battles = require("../kingdoms/Battles.Kingdoms");
        const Store = require("../kingdoms/KingdomStore");
        Battles.recordBattleKill(battleTag.battleId, rec.kingdomId, Store);
      } catch {
        // Battle bookkeeping never breaks the kill path.
      }
      Militia.recordKill(rec.kingdomId);
      return;
    }
    // Only count war raiders and enemy-tagged NPCs.
    const raider = npc.warRaider;
    const npcKingdom = npc.getAttribute?.("kingdom:id");
    if (!raider && !npcKingdom) return;
    Militia.recordKill(rec.kingdomId);
  } catch {
    // Non-fatal.
  }
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
  // Slot-capacity lifecycle: a logged-out citizen frees their spot claim.
  try {
    require("./brain/CitizenSlotCapacity").releaseFor(event?.player ?? event);
  } catch {
    // Missing them must never break logout.
  }
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
    initFollowOption(api);
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
    // Boss-run loot: when a citizen party's member lands a boss kill,
    // capture the engine's real drop roll for the party split so the kill
    // pays out exactly once (CitizenBossRuns.handleNpcDropsGenerated).
    api.onCustomEvent("npc-drops:generated", onBossRunDropsGenerated);
    // A player's drop roll contained a collection-log item: the street gzs.
    api.onCustomEvent("npc-drops:roll", onDropWitnessed);
    api.onCustomEvent("kingdom:patrol-ordered", onKingdomPatrolOrdered);
    api.onCustomEvent("kingdom:wage-day", onKingdomWageDay);
    api.onCustomEvent("arrival:player-arrived", onArrivalPlayerArrived);
    api.onPlayerAttack(onCitizenAttackedByPlayer);
    api.onPlayerLevelUp(onLevelUpHeard);
    api.onPlayerDeath(onDeathSeen);
    api.onPlayerDeath(onPlayerDeathInsured);
    api.onNpcDeath(onKillWitnessed);
    // Jon 2026-10-13: citizens loot what they kill, like a player.
    initCitizenLoot(api);
    api.onCustomEvent("npc-drops:roll", onCitizenDropsRolled);
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
    // Jon 2026-10-13: owner-only run-energy reset. Real engine path —
    // setRunEnergy clamps 0..100 and sendRunEnergy refreshes the client orb.
    api.registerCommand("run", onRunCommand, PlayerRights.OWNER, "Reset your run energy to 100");
    api.registerCommand(
      "citizens",
      onCitizensDiagCommand,
      PlayerRights.NONE,
      "Diagnostic: what citizens are doing right now"
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
