"use strict";

/**
 * The trawler docked at Port Khazard (Wiki: Fishing Trawler): its deck is the waiting area.
 * The first player aboard starts a one-minute countdown, with "Trawler will leave in 20 seconds."
 * and "... 10 seconds." to everyone aboard (captured); when it runs out the trawler sails with
 * everyone on deck. Only one trawler is at sea per world: while it is out, players wait
 * aboard and the countdown starts again when it is back. Sailing destroys any catch a player
 * left uncollected in the net, as the Wiki warns.
 */

const Shared = require("./Shared.FishingTrawler");
const Sea = require("./Sea.FishingTrawler");

const lobby = { area: null, departAt: null, task: null };

function waiting() {
  return lobby.area ? lobby.area.getPlayers().filter((player) => player.isRegistered?.() !== false) : [];
}

function now() {
  return Shared.core().World.getProcessCycle();
}

function startCountdown() {
  lobby.departAt = now() + Shared.DATA.timing.departTicks;
  ensureTicking();
}

/** Boarding while a trawler is out: the wait is for the next one. */
function tellCountdown(player) {
  if (Sea.atSea()) player.sendMessage(Shared.message("boardBusy"));
}

function ensureTicking() {
  if (lobby.task) return;
  lobby.task = Shared.everyTick(tickLobby);
}

/** Once a tick while anyone waits: sail when the countdown runs out and the sea is clear. */
function tickLobby() {
  const aboard = waiting();
  if (aboard.length === 0) {
    lobby.departAt = null;
    lobby.task = null;
    return false;
  }
  if (Sea.atSea()) return true;
  if (lobby.departAt === null) startCountdown();
  const left = lobby.departAt - now();
  for (const warning of Shared.DATA.timing.departWarnings) {
    if (left === warning.ticksLeft) for (const player of aboard) player.sendMessage(Shared.message("departIn", { seconds: warning.seconds }));
  }
  if (left > 0) return true;
  lobby.departAt = null;
  depart(aboard);
  return true;
}

function depart(players) {
  for (const player of players) {
    if (player.getAttribute(Shared.REWARD_ATTRIBUTE)) {
      player.setAttribute(Shared.REWARD_ATTRIBUTE, null);
      player.sendMessage(Shared.message("destroyedReward"));
    }
  }
  Sea.launch(players);
}

/** The sea is clear again: anyone still waiting gets a fresh countdown. */
function onVoyageOver() {
  if (waiting().length > 0) startCountdown();
}

function createArea() {
  const { Area, Boundary } = Shared.core();
  const [minX, maxX, minY, maxY, z] = Shared.DATA.lobby.bounds;
  class TrawlerDeck extends Area {
    constructor() {
      super([new Boundary(minX, maxX, minY, maxY, z)]);
    }

    getName() {
      return "Fishing Trawler (deck)";
    }

    postEnter(mobile) {
      if (!mobile.isPlayer?.()) return;
      // Boarding warns that sailing throws a waiting catch back (Wiki).
      if (mobile.getAttribute(Shared.REWARD_ATTRIBUTE)) mobile.sendMessage(Shared.message("rewardWaiting"));
      if (lobby.departAt === null && !Sea.atSea()) startCountdown();
      else tellCountdown(mobile);
      ensureTicking();
    }

    canAttack() {
      return false;
    }
  }
  return new TrawlerDeck();
}

function attachLobby(api) {
  Shared.bind(api);
  lobby.area = createArea();
  api.registerArea(lobby.area);
  Sea.onOver(onVoyageOver);
}

module.exports = { attachLobby, lobby, waiting, tickLobby, depart, onVoyageOver };
