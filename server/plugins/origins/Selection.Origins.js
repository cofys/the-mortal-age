"use strict";

/**
 * Selection.Origins — the in-game home pick shown on first login.
 *
 * The client has no character-creation screen (it is the game UI; accounts
 * are created at login), and Tutorial Island is disabled in world.json, so a
 * brand-new account lands at the Edgeville world spawn with an empty
 * inventory. This module intercepts that moment: any login by a player with
 * no `origin:id` attribute is offered the six homes. The 5-option chatbox
 * dialogue is a hard engine limit (OptionDialogue's interface list), so the
 * pick is two pages: the four surface powers, then Keldagrim / Wanderer.
 *
 * Trigger timing: desktop logins land on the welcome screen first (the
 * gameframe bootstrap only arrives when Play is clicked), so starting a
 * chatbox dialogue at onPlayerLogin would be clobbered by the welcome screen's
 * root swap. Desktop players are therefore prompted from the welcome screen's
 * Play button (same pattern TutorialIsland uses); mobile clients skip the
 * welcome screen, so they are prompted from a login microtask instead.
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

let pluginApi;
let core;
let Items;
let Location;
let OptionDialogue;
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
    // The welcome-screen hook may have beaten us here; only fire if the
    // choice is still owed.
    if (pending.delete(player) && !hasOrigin(player)) {
      openChoice(player);
    }
  }, LOGIN_FALLBACK_DELAY_MS);
  timer.unref?.();
  fallbackTimers.set(player, timer);
}

function hasOrigin(player) {
  return Boolean(player?.getAttribute?.(ORIGIN_ID_ATTRIBUTE));
}

function openChoice(player) {
  if (!player || hasOrigin(player)) return;
  const intro =
    "Every life begins somewhere. The gods are silent, the great powers are stirring, and every " +
    "traveller on the road is asked the same question: where do you call home? Choose — or wander.";
  player
    .getDialogueManager()
    .startDialogues(
      new DialogueChainBuilder().add(new StatementDialogue(0, intro), pageOneDialogue(player, 1))
    );
}

function pageOneDialogue(player, index) {
  const labels = ["Asgarnia — Falador", "Misthalin — Varrock", "Kandarin — Ardougne", "Morytania — Darkmeyer"];
  return new OptionDialogue(
    index,
    {
      executeOption(option) {
        const i = Number(option);
        if (i >= 0 && i < labels.length) showLens(player, Data.ORIGINS[i].id);
        else if (i === labels.length) showPageTwo(player);
      },
    },
    ...labels,
    "More homes..."
  );
}

function showPageTwo(player) {
  if (!player || hasOrigin(player)) return;
  player.getDialogueManager().startDialogues(
    new DialogueChainBuilder().add(
      new OptionDialogue(
        0,
        {
          executeOption(option) {
            const i = Number(option);
            if (i === 0) showLens(player, "keldagrim");
            else if (i === 1) showLens(player, "wanderer");
            else showPageOne(player);
          },
        },
        "Keldagrim — city of the dwarves",
        "Wanderer — no home",
        "Go back"
      )
    )
  );
}

function showPageOne(player) {
  if (!player || hasOrigin(player)) return;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(pageOneDialogue(player, 0)));
}

/** Show the origin's lens, then let the player claim it or go back. */
function showLens(player, originId) {
  if (!player || hasOrigin(player)) return;
  const origin = Data.BY_ID.get(originId);
  if (!origin) {
    showPageOne(player);
    return;
  }
  player.getDialogueManager().startDialogues(
    new DialogueChainBuilder().add(
      new StatementDialogue(0, origin.lens),
      new OptionDialogue(
        1,
        {
          executeOption(option) {
            if (Number(option) === 0) claimOrigin(player, originId);
            else showPageOne(player);
          },
        },
        `Claim ${origin.name} as my home`,
        "Choose again"
      )
    )
  );
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
    if (!hasOrigin(player)) openChoice(player);
  });
  return false;
}

function clearPending({ player }) {
  cancelFallback(player);
  pending.delete(player);
}

// --- commands ---------------------------------------------------------------

function showOrigin({ player }) {
  const originId = player.getAttribute(ORIGIN_ID_ATTRIBUTE);
  if (!originId) {
    openChoice(player);
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
    OptionDialogue,
    StatementDialogue,
    DialogueChainBuilder,
    MOBILE_CLIENT_ATTRIBUTE,
  } = core);
  Data.validateItemKeys(Items);

  api.persistAttribute(ORIGIN_ID_ATTRIBUTE);
  api.onPlayerLogin(onPlayerLogin);
  api.onInterfaceActionButton(WELCOME_PLAY_BUTTON_UID, onWelcomePlay);
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
