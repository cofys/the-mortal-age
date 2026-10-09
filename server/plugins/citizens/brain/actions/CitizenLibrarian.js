"use strict";

/**
 * CitizenLibrarian — the brain action for real library work.
 *
 * Complements (does not duplicate):
 *   - CitizenLibrarians: hash-derived librarian flavor (shelving emotes,
 *     storytellers — this never does flavor emotes, it walks librarians to
 *     the library and does work rounds).
 *   - CitizenLibrariesLife (slow tick): librarian registration, ambient
 *     writing, loan enforcement, archives, upkeep when nobody runs this
 *     action.
 *
 * Flow per tick:
 *   - Only registered librarians work. Others honestly return home.
 *   - Walk to the library tile in the citizen's kingdom.
 *   - Work in rounds (human-paced 8s): each round the librarian tends the
 *     library — shelves returned books, writes a book if they carry papyrus,
 *     processes the archive. With real work available the round does it;
 *     otherwise the librarian tidies (keeps the library visible, no economics).
 *   - After WORK_ROUNDS or GIVE_UP_MS, walk home.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch
 * in the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  humanizerProfile,
} = require("../../lib/humanizer");

const GIVE_UP_MS = 10 * 60 * 1000;
const WORK_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const WORK_COOLDOWN_MS = 8000; // human-paced work

function librariesApi() {
  try {
    return require("../../lib/CitizenLibraries");
  } catch {
    return null;
  }
}

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function createCitizenLibrarianAction() {
  const actionState = new Map(); // player -> { phase, rounds, startedAt, lastRound }

  function getSt(player, nowMs) {
    let st = actionState.get(player);
    if (!st) {
      st = { phase: "outbound", rounds: 0, startedAt: nowMs, lastRound: 0 };
      actionState.set(player, st);
    }
    return st;
  }

  function clearSt(player) {
    actionState.delete(player);
    try {
      clearMovementRequest(player);
    } catch { /* best-effort */ }
  }

  function walkHome(player) {
    try {
      const st = playerState(player);
      const home = st?.homeTile;
      if (home) requestMovement(player, home.x, home.y);
    } catch { /* best-effort */ }
    clearSt(player);
    return { done: true, reason: "walk-home" };
  }

  function doWorkRound(player, st, nowMs) {
    const Lib = librariesApi();
    if (!Lib) return false;
    const kid = kingdomIdOf(player);
    if (!kid) return false;
    const username = usernameOf(player);
    // Prefer writing a book if carrying papyrus (real economics).
    let didWork = false;
    try {
      const inv = player?.getInventory?.();
      const items = inv?.getItems?.() ?? inv?.items ?? [];
      const hasPapyrus = items.some((it) => (it?.id ?? it?.itemId) === 970);
      if (hasPapyrus) {
        const rng = agentRng(`librarian-write:${username}:${st.rounds}`);
        const subject = Lib.BOOK_SUBJECTS[Math.floor(rng() * Lib.BOOK_SUBJECTS.length)];
        const res = Lib.writeBook(player, subject, kid, nowMs);
        didWork = res.ok;
      }
    } catch { /* work is best-effort */ }
    // Archive pass: record any fresh kingdom events.
    try {
      for (const evt of Lib.gatherArchiveEvents(kid)) {
        Lib.writeArchive(kid, evt.event, evt.subject, nowMs);
      }
    } catch { /* best-effort */ }
    return didWork;
  }

  function tick(player, nowMs = Date.now()) {
    const Lib = librariesApi();
    const username = usernameOf(player);
    if (!Lib || !username || !Lib.isLibrarian(username)) {
      return walkHome(player);
    }
    const st = getSt(player, nowMs);
    if (nowMs - st.startedAt > GIVE_UP_MS) {
      return walkHome(player);
    }
    const kid = kingdomIdOf(player);
    const tile = kid ? Lib.libraryTile(kid) : null;
    if (!tile) return walkHome(player);

    if (st.phase === "outbound") {
      try {
        const p = player?.getPosition?.() ?? player?.position ?? {};
        const dx = (p.x ?? 0) - tile.x;
        const dy = (p.y ?? 0) - tile.y;
        if (Math.hypot(dx, dy) <= ARRIVE_RADIUS) {
          st.phase = "working";
          st.lastRound = nowMs;
        } else {
          requestMovement(player, tile.x, tile.y);
        }
      } catch {
        return walkHome(player);
      }
      return { done: false, phase: st.phase };
    }

    // working phase
    if (st.rounds >= WORK_ROUNDS) {
      return walkHome(player);
    }
    if (nowMs - st.lastRound >= WORK_COOLDOWN_MS) {
      st.lastRound = nowMs;
      st.rounds += 1;
      doWorkRound(player, st, nowMs);
    }
    return { done: false, phase: "working", rounds: st.rounds };
  }

  function reset(player) {
    clearSt(player);
  }

  return { tick, reset };
}

module.exports = { createCitizenLibrarianAction };
