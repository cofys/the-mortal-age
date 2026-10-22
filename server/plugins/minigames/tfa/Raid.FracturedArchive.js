"use strict";

/**
 * Raid-wide rules: the Archive Door into it, the Passageway out, deaths, spectating and coming
 * back after a logout.
 *
 * Captured: the door's warning and "Are you sure you wish to enter?" (Yes. / Yes, and don't ask
 * again. / No.), the abandon warning and "Abandon the raid?", the HUD's Spectate clicks (974:5,
 * [slot, 1], -1 for the room). Estimates (our wording): needing a party, the leader going first,
 * and a raid that ended while a player was logged out mid-challenge costing them their items.
 */

const Shared = require("./Shared.FracturedArchive");
const Parties = require("./Parties.FracturedArchive");
const Raid = require("./RaidState.FracturedArchive");

/** Saved: "Yes, and don't ask again." at the Archive Door. */
const ATTR_SKIP_WARNING = "fractured-archive:skip-entry-warning";

const ENTRY_WARNING = "You are about to enter the Fractured Archive which is not a safe area. In addition, be aware that the raid uses various flashing effects that may cause discomfort to some users. Are you sure you wish to enter?";
/** Estimate (not captured): a member arriving after the fight has started, or been won. */
const LATE_MESSAGE = "Your party has already started the challenge. You can't join them now.";
const ABANDON_WARNING = "You are about to <col=ad2800>abandon the raid</col>. If you do this, you <col=ad2800>will not</col> be able to return to your current run.";

function raidIn(player) {
  const raid = Raid.raidOf(player);
  return raid && Shared.inArchive(player.getLocation()) ? raid : null;
}

// ---------------------------------------------------------------- the Archive Door

function enterArchive({ player }) {
  const party = Parties.partyOf(player);
  if (!party) {
    Shared.mesbox(player, "You need to be in a party to enter the Archive. Inspect the Grouping Board to form or join one.");
    return true;
  }
  if (!party.raid && !party.isLeader(player)) {
    Shared.mesbox(player, `Your leader, ${Shared.displayName(party.leader)}, must enter first.`);
    return true;
  }
  if (party.raid && !party.raid.hasMember(player) && !party.raid.canJoin()) {
    Shared.mesbox(player, LATE_MESSAGE);
    return true;
  }
  if (player.getAttribute(ATTR_SKIP_WARNING) === true) {
    goIn(player);
    return true;
  }
  Shared.mesbox(player, ENTRY_WARNING, () => Shared.options(player, "Are you sure you wish to enter?",
    "Yes.", () => goIn(player),
    "Yes, and don't ask again.", () => {
      player.setAttribute(ATTR_SKIP_WARNING, true);
      goIn(player);
    },
    "No.", () => {}));
  return true;
}

function goIn(player) {
  const party = Parties.partyOf(player);
  if (!party) return;
  const raid = party.raid ?? (party.isLeader(player) ? Raid.begin(player) : null);
  if (!raid) return;
  if (!raid.enter(player) && !raid.hasMember(player)) Shared.mesbox(player, LATE_MESSAGE);
}

// ---------------------------------------------------------------- the Passageway out

function exitArchive({ player }) {
  const raid = raidIn(player);
  if (!raid) return false;
  Shared.mesbox(player, ABANDON_WARNING, () => Shared.options(player, "Abandon the raid?",
    "Yes, abandon the raid.", () => raid.abandon(player),
    "No, I want to stay.", () => {}));
  return true;
}

// ---------------------------------------------------------------- deaths

/** Items stay with the dead until the party wipes (then they go as a death takes them). */
function keepItemsOnDeath(event) {
  if (raidIn(event.player)) event.shouldDrop = false;
}

function dieInArchive(event) {
  const raid = raidIn(event.player);
  if (!raid) return;
  event.handled = true;
  raid.onPlayerDied(event.player);
}

/** The HUD's Spectate (974:5): [slot, 1], -1 for the whole room. */
function spectateClick(event) {
  if (!event.scriptTrigger || event.buttonId !== Shared.id("component", "HUD_NAMES")) return;
  const raid = raidIn(event.player);
  if (!raid) return;
  event.handled = true;
  const [slot] = Shared.triggerInts(event.argsData);
  raid.spectateSlot(event.player, Number.isInteger(slot) ? slot : -1);
}

// ---------------------------------------------------------------- logging in

/**
 * Back after a logout: into the party's room if the raid is still on. If it isn't, a logout
 * mid-challenge loses the items as the wipe would have; anyone in the Archive goes to the lobby.
 */
function returnAfterLogout({ player }) {
  const left = player.getAttribute(Raid.ATTR_LOGOUT);
  if (left) {
    // Nothing from spectating needs undoing here: untargetable, the blocked movement and the
    // closed tabs live on the old session's player; a login starts clean and sends every tab.
    const raid = Raid.byId(left.raid);
    if (raid?.rejoin(player)) return;
    player.setAttribute(Raid.ATTR_LOGOUT, null);
    if (left.fight) {
      player.moveTo(Shared.loc(Shared.TILE.WIPE_RETURN));
      Shared.core().PlayerDeathTask.loseItemsAsDeath(player, Shared.loc(Shared.TILE.WIPE_RETURN));
      player.sendMessage("Your party could not be found. You failed to survive the Fractured Archive.");
      return;
    }
  }
  if (Shared.inArchive(player.getLocation())) player.moveTo(Shared.loc(Shared.TILE.LEAVE));
}

// ---------------------------------------------------------------- room hooks

/** A room can change hits on its NPCs as they land (the Guardian's shield). */
function roomModifiesHit(event) {
  event.npc?.__tfaRoom?.modifyHit?.(event.npc, event.hit, event);
}

/** Some NPCs' hitpoints running out is the room's to handle (the Guardian's shield). */
function roomHoldsOn(event) {
  if (event.npc?.__tfaRoom?.holdsOn?.(event.npc)) event.preventDeath = true;
}

function roomNpcDied(event) {
  event.npc?.__tfaRoom?.onNpcDeath?.(event.npc, event);
}

module.exports = function registerRaid(api) {
  Shared.bind(api);
  api.persistAttribute(ATTR_SKIP_WARNING, false);
  api.persistAttribute(Raid.ATTR_LOGOUT);
  api.persistAttribute(Raid.ATTR_DEATHS, 0);
  api.onObjectInteraction("Archive Door", { Enter: enterArchive });
  api.onObjectInteraction("Passageway", { Exit: exitArchive });
  api.onShouldDropItemsOnDeath(keepItemsOnDeath);
  api.onPlayerDeath(dieInArchive);
  api.onInterfaceActionClick(spectateClick);
  api.onPlayerLogin(returnAfterLogout);
  api.onNpcHitModify(roomModifiesHit);
  api.onNpcBeforeDeath(roomHoldsOn);
  api.onNpcDeath(roomNpcDied);
};

Object.assign(module.exports, { ATTR_SKIP_WARNING, enterArchive, goIn, exitArchive, dieInArchive, spectateClick, returnAfterLogout });
