"use strict";

/**
 * Selection.Origins — the in-game home pick shown on first login.
 *
 * The client has no character-creation screen (it is the game UI; accounts
 * are created at login), and Tutorial Island is disabled in world.json, so a
 * brand-new account lands at the Edgeville world spawn with an empty
 * inventory. This module intercepts that moment: any login by a player with
 * no `origin:id` attribute is offered the six homes. The prompt caps at 5
 * options per page (a sendMultiChatboxPrompt engine limit), so the pick is
 * two pages: the four surface powers, then Keldagrim / Wanderer.
 *
 * Trigger timing: desktop logins land on the welcome screen first (the
 * gameframe bootstrap only arrives when Play is clicked), so starting a
 * chatbox dialogue at onPlayerLogin would be clobbered by the welcome screen's
 * root swap. Desktop players are therefore prompted from the welcome screen's
 * Play button (same pattern TutorialIsland uses); mobile clients skip the
 * welcome screen, so they are prompted from a login microtask instead.
 *
 * Choice UI: the graphical creation screen (Gui.Origins, custom interface
 * 30016) is the primary UI on desktop. The chatbox flow below stays as the
 * fallback: mobile clients use it, dismissing the GUI without choosing falls
 * back to it, and any GUI open failure falls back to it — until the GUI is
 * verified in-game. The intro and lens text render as StatementDialogue, but
 * option lists go through api.sendMultiChatboxPrompt (the same mechanism NPC
 * dialogue menus use) — OptionDialogue is dead engine code whose interface
 * hangs the client on "Please wait...". The prompt caps at 5 options, so the
 * pick stays two pages: the four surface powers, then Keldagrim / Wanderer.
 *
 * Skip behaviour: the Wanderer option IS the skip — "no home, just let me
 * go". Closing the dialogue by other means leaves the choice unmade and the
 * prompt returns on the next login.
 *
 * Claiming a home: persists `origin:id`, joins the kingdom at the base rank
 * through the kingdoms plugin's own helper (sets `kingdom:id` +
 * `kingdom:rank`), grants the modest origin kit, moves the player to the
 * origin's spawn, and emits `origins:selected` for the starting-experience
 * system to hook.
 */

const Data = require("./Data.Origins");
const Membership = require("../kingdoms/Membership.Kingdoms");

const ORIGIN_ID_ATTRIBUTE = "origin:id";

// The welcome screen's Play button (plugins/interface/WelcomeScreen.plugin.js).
const WELCOME_PLAY_BUTTON_UID = (378 << 16) | 72;
// The appearance customizer (plugins/npcs/MakeOverMage.plugin.js). New
// accounts go Play -> 679 -> creation GUI; the GUI opens when 679 closes.
const MAKEOVER_INTERFACE_ID = 679;

let pluginApi;
let core;
let Items;
let Location;
let ActionDialogue;
let StatementDialogue;
let DialogueChainBuilder;
let MOBILE_CLIENT_ATTRIBUTE;

/** Players who still owe the choice a click (cleared on choose/logout). */
const pending = new Set();

/**
 * Backstop timers for players whose login never reaches the welcome screen
 * (brand-new accounts go through the appearance customizer instead, so
 * onWelcomePlay never fires). Each timer opens the choice after a short
 * delay unless the player already chose, logged out, or was prompted.
 */
const fallbackTimers = new Map();
const LOGIN_FALLBACK_DELAY_MS = 8000;

/**
 * Creation-GUI coordination, wired by Origins.plugin.js (Gui.Origins owns the
 * screen; this module owns the triggers). Null until wired.
 */
let guiHooks = null;
function setGuiHooks(hooks) {
  guiHooks = hooks;
}

/** Desktop -> graphical creation screen; mobile and failures -> chatbox. */
function openCreationGui(player) {
  if (!guiHooks || !player || player.getAttribute(MOBILE_CLIENT_ATTRIBUTE) === true) return false;
  try {
    return guiHooks.open(player) === true;
  } catch {
    return false;
  }
}

function cancelFallback(player) {
  const timer = fallbackTimers.get(player);
  if (timer !== undefined) {
    clearTimeout(timer);
    fallbackTimers.delete(player);
  }
}

function scheduleFallback(player) {
  cancelFallback(player);
  const timer = setTimeout(() => {
    fallbackTimers.delete(player);
    pending.delete(player);
    if (hasOrigin(player)) return;
    if (
      (player.getInterfaceId?.() | 0) === MAKEOVER_INTERFACE_ID ||
      (guiHooks && guiHooks.isOpen(player))
    ) {
      // Appearance customizer or creation GUI still open — their close hands
      // off to the GUI, so wait instead of opening the chatbox underneath.
      scheduleFallback(player);
      return;
    }
    // Backstop: whatever should have opened the GUI didn't — try it, then the
    // chatbox fallback (mobile always lands here).
    if (!openCreationGui(player)) openChoice(player);
  }, LOGIN_FALLBACK_DELAY_MS);
  timer.unref?.();
  fallbackTimers.set(player, timer);
}

function hasOrigin(player) {
  const val = player?.getAttribute?.(ORIGIN_ID_ATTRIBUTE);
  // TEMP DEBUG - remove after diagnosing relog issue
  if (player && !player.isPlayerBot?.()) {
    console.info(`[origins-debug] hasOrigin check for ${player.getUsername?.()}: ${val}`);
  }
  return Boolean(val);
}

function openChoice(player) {
  if (!player || hasOrigin(player)) return;
  const intro =
    "Every life begins somewhere. The gods are silent, the great powers are stirring, and every " +
    "traveller on the road is asked the same question: where do you call home? Choose — or wander.";
  player
    .getDialogueManager()
    .startDialogues(
      new DialogueChainBuilder().add(
        new StatementDialogue(0, intro),
        new ActionDialogue(1, { execute: () => showPageOnePrompt(player) })
      )
    );
}

/**
 * Show an option prompt. Mirrors the NPC dialogue menu pattern
 * (manager.reset() first, then sendMultiChatboxPrompt). If the client can't
 * render it, the choice is re-queued so the prompt returns on next login.
 */
function showPrompt(player, title, pairs) {
  if (!player || hasOrigin(player)) return false;
  player.getDialogueManager().reset();
  if (!pluginApi.sendMultiChatboxPrompt(player, title, ...pairs)) {
    console.warn(
      `[origins] sendMultiChatboxPrompt failed for ${player.getUsername?.() ?? "unknown"} — re-queuing choice`
    );
    pending.add(player);
    return false;
  }
  return true;
}

function showPageOnePrompt(player) {
  if (!player || hasOrigin(player)) return;
  const labels = ["Asgarnia — Falador", "Misthalin — Varrock", "Kandarin — Ardougne", "Morytania — Darkmeyer"];
  const pairs = [];
  labels.forEach((label, i) => {
    pairs.push(label, (p) => {
      if (!hasOrigin(p)) showLens(p, Data.ORIGINS[i].id);
    });
  });
  pairs.push("More homes...", (p) => {
    if (!hasOrigin(p)) showPageTwoPrompt(p);
  });
  showPrompt(player, "Where do you call home?", pairs);
}

function showPageTwoPrompt(player) {
  if (!player || hasOrigin(player)) return;
  showPrompt(player, "More homes…", [
    "Keldagrim — city of the dwarves",
    (p) => {
      if (!hasOrigin(p)) showLens(p, "keldagrim");
    },
    "Wanderer — no home",
    (p) => {
      if (!hasOrigin(p)) showLens(p, "wanderer");
    },
    "Go back",
    (p) => {
      if (!hasOrigin(p)) showPageOnePrompt(p);
    },
  ]);
}

/** Show the origin's lens, then let the player claim it or go back. */
function showLens(player, originId) {
  if (!player || hasOrigin(player)) return;
  const origin = Data.BY_ID.get(originId);
  if (!origin) {
    showPageOnePrompt(player);
    return;
  }
  player.getDialogueManager().startDialogues(
    new DialogueChainBuilder().add(
      new StatementDialogue(0, origin.lens),
      new ActionDialogue(1, { execute: () => showClaimPrompt(player, origin) })
    )
  );
}

function showClaimPrompt(player, origin) {
  if (!player || hasOrigin(player)) return;
  showPrompt(player, `Claim ${origin.name}?`, [
    `Claim ${origin.name} as my home`,
    (p) => claimOrigin(p, origin.id),
    "Choose again",
    (p) => {
      if (!hasOrigin(p)) showPageOnePrompt(p);
    },
  ]);
}

/** Apply the choice: attributes, kingdom membership, kit, spawn, event. */
function claimOrigin(player, originId) {
  const origin = Data.BY_ID.get(originId);
  if (!player || !origin || hasOrigin(player)) return;
  player.setAttribute(ORIGIN_ID_ATTRIBUTE, origin.id);
  if (origin.kingdomId) {
    // Home is initial citizenship: the kingdoms plugin's own join helper
    // writes kingdom:id + kingdom:rank ("Subject") via kingdom:rank-granted.
    Membership.joinKingdom(player, origin.kingdomId);
  }
  grantKit(player, origin);
  player.moveTo(new Location(origin.spawn.x, origin.spawn.y, origin.spawn.z));
  player.getPacketSender().sendInterfaceRemoval();
  pluginApi.emitCustomEvent("origins:selected", { player, originId: origin.id });
  player.sendMessage(origin.welcome);
  cancelFallback(player);
  pending.delete(player);
}

/** Best-effort: adds() silently skips what a full inventory cannot hold. */
function grantKit(player, origin) {
  const inv = player.getInventory();
  for (const [key, amount] of origin.kit) inv.adds(Items[key], amount);
}

// --- triggers ---------------------------------------------------------------

function onPlayerLogin(event) {
  const player = event?.player;
  if (!player || player.isPlayerBot?.() === true || hasOrigin(player)) return;
  pending.add(player);
  // Backstop: new accounts skip the welcome screen (appearance customizer),
  // so guarantee the choice opens even if onWelcomePlay never fires.
  scheduleFallback(player);
  if (player.getAttribute(MOBILE_CLIENT_ATTRIBUTE) === true) {
    // No welcome screen on mobile: the gameframe is already up.
    queueMicrotask(() => {
      if (pending.delete(player) && !hasOrigin(player)) openChoice(player);
    });
  }
}

function onWelcomePlay({ player }) {
  cancelFallback(player);
  if (!pending.delete(player)) return false;
  queueMicrotask(() => {
    if (hasOrigin(player)) return;
    if (!openCreationGui(player)) openChoice(player);
  });
  return false;
}

/**
 * Interface-close handoff (core "interface:closed" event, which fires for
 * every close route: confirm packets, ESC, sendInterfaceRemoval).
 *  - 679 closing with no home  -> the new-account ceremony: open the GUI.
 *  - GUI closing with no home  -> dismissed without choosing: chatbox fallback
 *    keeps the choice reachable so nobody is ever stuck choiceless.
 */
function onInterfaceClosed({ player, interfaceId }) {
  if (!player || player.isPlayerBot?.() === true || hasOrigin(player)) return;
  const id = interfaceId | 0;
  if (id === MAKEOVER_INTERFACE_ID) {
    if (guiHooks && !guiHooks.isOpen(player) && !openCreationGui(player)) {
      openChoice(player);
    }
    return;
  }
  if (guiHooks && id === guiHooks.groupId && guiHooks.isOpen(player)) {
    guiHooks.noteClosed({ player });
    openChoice(player);
  }
}

function clearPending({ player }) {
  cancelFallback(player);
  pending.delete(player);
}

// --- commands ---------------------------------------------------------------

function showOrigin({ player }) {
  const originId = player.getAttribute(ORIGIN_ID_ATTRIBUTE);
  if (!originId) {
    if (!openCreationGui(player)) openChoice(player);
    return;
  }
  const origin = Data.BY_ID.get(originId);
  if (!origin) {
    player.sendMessage("Your home is recorded as something the world no longer knows.");
    return;
  }
  const kingdom = origin.kingdomId
    ? ` Your kingdom: ${player.getAttribute(Membership.KINGDOM_ID_ATTRIBUTE) ?? origin.kingdomId}.`
    : " You answer to no crown.";
  player.sendMessage(`You are ${origin.demonym}, of ${origin.city}.${kingdom}`);
}

/**
 * Your home as war-table lines: name, epithet, lens, fealty.
 * The ::origin command's content, refactored for reuse — the war table's
 * YOUR HOME section renders these in-interface. The fealty line matches
 * ::origin's phrasing exactly. Nothing here reimplements origin data; it all
 * reads Data.BY_ID, the same source the command uses.
 */
function originLines(player) {
  const originId = player?.getAttribute?.(ORIGIN_ID_ATTRIBUTE);
  const origin = originId ? Data.BY_ID.get(originId) : null;
  if (!origin) return ["You have no home yet — the road is still deciding."];
  const fealty = origin.kingdomId
    ? `Your kingdom: ${player.getAttribute(Membership.KINGDOM_ID_ATTRIBUTE) ?? origin.kingdomId}.`
    : "You answer to no crown.";
  return [`${origin.name} — ${origin.epithet}`, origin.lens, fealty];
}

/** Owner tool: clear a player's origin so the choice prompt returns on next login. */
function resetOrigin({ player, parts }) {
  const targetName = parts[1];
  if (!targetName) {
    player.sendMessage("Usage: ::originreset <player>");
    return;
  }
  const target = pluginApi.core.World.getPlayerByName(targetName);
  if (!target) {
    player.sendMessage(`No online player named '${targetName}'.`);
    return;
  }
  target.setAttribute(ORIGIN_ID_ATTRIBUTE, null);
  cancelFallback(target);
  pending.delete(target);
  player.sendMessage(`${target.getUsername?.() ?? targetName} will choose a home on next login.`);
}

function attachSelection(api) {
  pluginApi = api;
  core = api.core;
  ({
    ItemIdentifiers: Items,
    Location,
    ActionDialogue,
    StatementDialogue,
    DialogueChainBuilder,
    MOBILE_CLIENT_ATTRIBUTE,
  } = core);
  Data.validateItemKeys(Items);

  api.persistAttribute(ORIGIN_ID_ATTRIBUTE);
  api.onPlayerLogin(onPlayerLogin);
  api.onInterfaceActionButton(WELCOME_PLAY_BUTTON_UID, onWelcomePlay);
  api.onCustomEvent("interface:closed", onInterfaceClosed);
  api.onPlayerLogout(clearPending);
  api.onPlayerDisconnect(clearPending);
  api.registerCommand("origin", showOrigin, undefined, "Show your home, or choose one if you have none");
  api.registerCommand(
    "originreset",
    resetOrigin,
    api.core.PlayerRights.OWNER,
    "Clear a player's origin choice: ::originreset <player>"
  );
}

module.exports = attachSelection;
module.exports.ORIGIN_ID_ATTRIBUTE = ORIGIN_ID_ATTRIBUTE;
module.exports.hasOrigin = hasOrigin;
module.exports.originLines = originLines;
module.exports.claimOrigin = claimOrigin;
module.exports.openChatboxChoice = openChoice;
module.exports.setGuiHooks = setGuiHooks;
