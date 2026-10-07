"use strict";

/**
 * Backgrounds.Origins — the second half of character creation.
 *
 * Origin ("where do you call home?") picks the home; this picks the PAST and
 * the NAME. Flow, kept under a minute: background (two chatbox pages) ->
 * lens -> claim -> first name (text input) -> last name (text input) -> done.
 *
 * Trigger: the `origins:selected` custom event Selection.Origins emits when a
 * home is claimed — so this works for the desktop GUI path, the mobile
 * chatbox path, and the web-overlay claim path alike. Resume: a player who
 * logs out mid-flow (has origin, no background / no name) is re-prompted on
 * the next login — desktop via the welcome-screen Play button (same trigger
 * Selection uses; Selection returns false so this handler still fires),
 * mobile via a login microtask.
 *
 * A background grants: modest starting skill boosts, a small thematic kit,
 * a named citizen contact in the home city (a real roster citizen of a
 * fitting role, picked deterministically per player), and a story hook.
 *
 * Names: `character:first-name` + `character:last-name`, surfaced as
 * `character:display-name` ("First Last"). Public chat is re-broadcast with
 * the display name via the social-packet hook — but ONLY for players who
 * have one; everyone else keeps the engine path untouched, so a bug here
 * cannot break chat globally. Other systems (examine box, citizens) should
 * use displayName(player).
 *
 * Reset: `origins:reset` (emitted by ::originreset) clears background and
 * name attributes so creation restarts cleanly.
 */

const Data = require("./Data.Backgrounds");
const OriginData = require("./Data.Origins");
const Selection = require("./Selection.Origins");

const BACKGROUND_ID_ATTRIBUTE = "background:id";
const BACKGROUND_CONTACT_ATTRIBUTE = "background:contact-name";
const CHARACTER_FIRST_ATTRIBUTE = "character:first-name";
const CHARACTER_LAST_ATTRIBUTE = "character:last-name";
const CHARACTER_DISPLAY_ATTRIBUTE = "character:display-name";

// Selection.Origins' welcome-screen Play button (same trigger it uses).
const WELCOME_PLAY_BUTTON_UID = (378 << 16) | 72;

let pluginApi;
let core;
let Items;
let Skill;
let World;
let ActionDialogue;
let StatementDialogue;
let DialogueChainBuilder;
let MOBILE_CLIENT_ATTRIBUTE;

/** Players mid-name-entry: player -> first name (validated, awaiting last). */
const pendingFirst = new Set();
const pendingFirstName = new Map();

function hasBackground(player) {
  return Boolean(player?.getAttribute?.(BACKGROUND_ID_ATTRIBUTE));
}

function hasFullName(player) {
  const p = player;
  return Boolean(p?.getAttribute?.(CHARACTER_FIRST_ATTRIBUTE) && p?.getAttribute?.(CHARACTER_LAST_ATTRIBUTE));
}

function hasCharacter(player) {
  return hasBackground(player) && hasFullName(player);
}

/** The name the world sees. Falls back to the login username pre-creation. */
function displayName(player) {
  const name = player?.getAttribute?.(CHARACTER_DISPLAY_ATTRIBUTE);
  if (name) return name;
  return player?.getUsername?.() ?? "Someone";
}

function getBackground(player) {
  const id = player?.getAttribute?.(BACKGROUND_ID_ATTRIBUTE);
  return (id && Data.BY_ID.get(id)) || null;
}

// --- text helpers ------------------------------------------------------------

/** Normalize a name part: letters/apostrophe/hyphen/space, 2-16 chars, capitalized. */
function cleanNamePart(input) {
  let s = String(input ?? "")
    .replace(/[^A-Za-z'\- ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (s.length < 2 || s.length > 16) return null;
  if (s.replace(/[^a-z]/g, "").length < 2) return null;
  return s.replace(/(^|[\s'\-])[a-z]/g, (m) => m.toUpperCase());
}

/** Free-text prompt ("enter name") that resumes into onInput. Same pattern as the market registrar. */
function promptText(player, title, onInput) {
  try {
    player.setEnteredSyntaxAction({
      execute: (input) => {
        try {
          player.setEnteredSyntaxAction(null);
        } catch {
          // Clearing is cosmetic.
        }
        onInput(input);
      },
    });
    player.getPacketSender().sendEnterInputPrompt(title);
  } catch {
    onInput(null);
  }
}

/** Option prompt mirroring Selection.Origins' showPrompt. */
function showPrompt(player, title, pairs) {
  if (!player || hasCharacter(player)) return false;
  player.getDialogueManager().reset();
  if (!pluginApi.sendMultiChatboxPrompt(player, title, ...pairs)) {
    console.warn(`[backgrounds] sendMultiChatboxPrompt failed for ${player.getUsername?.() ?? "unknown"}`);
    return false;
  }
  return true;
}

// --- the background pick -----------------------------------------------------

function promptBackgroundPageOne(player) {
  if (!player || hasBackground(player)) return;
  const pairs = [];
  for (const bg of Data.BACKGROUNDS.slice(0, 4)) {
    pairs.push(`${bg.name} — ${bg.epithet}`, (p) => {
      if (!hasBackground(p)) showBackgroundLens(p, bg.id);
    });
  }
  pairs.push("More pasts...", (p) => {
    if (!hasBackground(p)) promptBackgroundPageTwo(p);
  });
  showPrompt(player, "What was your life before?", pairs);
}

function promptBackgroundPageTwo(player) {
  if (!player || hasBackground(player)) return;
  const pairs = [];
  for (const bg of Data.BACKGROUNDS.slice(4)) {
    pairs.push(`${bg.name} — ${bg.epithet}`, (p) => {
      if (!hasBackground(p)) showBackgroundLens(p, bg.id);
    });
  }
  pairs.push("Go back", (p) => {
    if (!hasBackground(p)) promptBackgroundPageOne(p);
  });
  showPrompt(player, "What was your life before?", pairs);
}

function showBackgroundLens(player, bgId) {
  const bg = Data.BY_ID.get(bgId);
  if (!bg) {
    promptBackgroundPageOne(player);
    return;
  }
  player
    .getDialogueManager()
    .startDialogues(
      new DialogueChainBuilder().add(
        new StatementDialogue(0, bg.lens),
        new ActionDialogue(1, { execute: () => showClaimPrompt(player, bg) })
      )
    );
}

function showClaimPrompt(player, bg) {
  if (!player || hasBackground(player)) return;
  showPrompt(player, `Take up the ${bg.name} life?`, [
    `Yes — I was a ${bg.name.toLowerCase()}`,
    (p) => claimBackground(p, bg.id),
    "Choose again",
    (p) => {
      if (!hasBackground(p)) promptBackgroundPageOne(p);
    },
  ]);
}

/** Apply the choice: attributes, skills, kit, contact, hook — no UI prompts.
 * Returns the background object on success, null if invalid/already set. */
function applyBackground(player, bgId) {
  const bg = Data.BY_ID.get(bgId);
  if (!player || !bg || hasBackground(player)) return null;
  player.setAttribute(BACKGROUND_ID_ATTRIBUTE, bg.id);
  applySkills(player, bg);
  grantKit(player, bg);
  const contact = findContact(player, bg);
  if (contact) {
    player.setAttribute(BACKGROUND_CONTACT_ATTRIBUTE, contact);
    player.sendMessage(`You know ${contact} in the city — ${bg.contactBlurb}. Look them up.`);
  }
  player.sendMessage(bg.hook);
  return bg;
}

/** Apply the choice: attributes, skills, kit, contact, hook — then names. */
function claimBackground(player, bgId) {
  const bg = applyBackground(player, bgId);
  if (!bg) return;
  player.getPacketSender().sendInterfaceRemoval();
  promptFirstName(player);
}

function applySkills(player, bg) {
  const sm = player.getSkillManager?.();
  if (!sm) return;
  for (const [key, level] of bg.skills) {
    try {
      sm.setLevel(Skill[key], level);
    } catch (err) {
      console.warn(`[backgrounds] setLevel ${key}=${level} failed: ${err?.message ?? err}`);
    }
  }
}

/** Best-effort: adds() silently skips what a full inventory cannot hold. */
function grantKit(player, bg) {
  const inv = player.getInventory?.();
  if (!inv) return;
  for (const [key, amount] of bg.kit) inv.adds(Items[key], amount);
}

/**
 * A real citizen of the fitting role in the player's home kingdom, picked
 * deterministically per player so the contact is stable. Roster records are
 * data-only (proximity lifecycle), so this works with zero spawned bots.
 */
function findContact(player, bg) {
  try {
    const { getDirector } = require("../citizens/director/CitizenDirector");
    const director = getDirector?.();
    const originId = player.getAttribute?.("origin:id");
    const kingdomId = originId && OriginData.BY_ID.get(originId)?.kingdomId;
    if (!director?.roster || !kingdomId) return null;
    const candidates = [];
    for (const record of director.roster.values()) {
      if (record.kingdomId === kingdomId && record.role === bg.contactRole) {
        candidates.push(record.displayName || record.username);
      }
    }
    if (!candidates.length) return null;
    const username = player.getUsername?.() ?? "";
    let hash = 0;
    for (let i = 0; i < username.length; i++) hash = (hash * 31 + username.charCodeAt(i)) | 0;
    return candidates[Math.abs(hash) % candidates.length];
  } catch {
    return null;
  }
}

// --- the naming --------------------------------------------------------------

function promptFirstName(player) {
  if (!player || hasFullName(player)) return;
  pendingFirst.add(player);
  promptText(player, "What is your first name?", (input) => {
    const first = cleanNamePart(input);
    if (!first) {
      player.sendMessage("That name won't do — letters only, 2 to 16 characters.");
      pendingFirst.delete(player);
      pendingFirstName.delete(player);
      promptFirstName(player);
      return;
    }
    pendingFirstName.set(player, first);
    promptLastName(player);
  });
}

function promptLastName(player) {
  if (!player || hasFullName(player)) return;
  const first = pendingFirstName.get(player);
  if (!first) {
    promptFirstName(player);
    return;
  }
  promptText(player, "And your family name?", (input) => {
    const last = cleanNamePart(input);
    if (!last) {
      player.sendMessage("That name won't do — letters only, 2 to 16 characters.");
      promptLastName(player);
      return;
    }
    finishCharacter(player, first, last);
  });
}

/** Validate and set names without UI prompts. Returns { first, last } or { error }.
 * Does NOT emit character:created — the caller does that after origin is set. */
function setNames(player, firstInput, lastInput) {
  if (!player || hasFullName(player)) return { error: "Names already set." };
  const first = cleanNamePart(firstInput);
  const last = cleanNamePart(lastInput);
  if (!first || !last) {
    return { error: "That name won't do — letters only, 2 to 16 characters each." };
  }
  player.setAttribute(CHARACTER_FIRST_ATTRIBUTE, first);
  player.setAttribute(CHARACTER_LAST_ATTRIBUTE, last);
  player.setAttribute(CHARACTER_DISPLAY_ATTRIBUTE, `${first} ${last}`);
  return { first, last };
}

function finishCharacter(player, first, last) {
  pendingFirst.delete(player);
  pendingFirstName.delete(player);
  const result = setNames(player, first, last);
  if (result.error) return;
  player.sendMessage(`From this day, you are ${result.first} ${result.last}. Make the name mean something.`);
  pluginApi.emitCustomEvent("character:created", {
    player,
    firstName: result.first,
    lastName: result.last,
    backgroundId: player.getAttribute(BACKGROUND_ID_ATTRIBUTE),
  });
}

/** Resume an interrupted creation: background first, then names. */
function resumeFlow(player) {
  if (!player || player.isPlayerBot?.() === true || hasCharacter(player)) return;
  if (!hasBackground(player)) promptBackgroundPageOne(player);
  else if (pendingFirstName.has(player)) promptLastName(player);
  else promptFirstName(player);
}

// --- public chat display names -----------------------------------------------

/**
 * Re-broadcast a public chat message with the speaker's display name.
 * Mirrors the engine's ChatPacketListener broadcast exactly (overhead text,
 * local-player recipients, chat-mode filtering) — only the shown name
 * differs. Only used when the speaker HAS a display name; everyone else
 * keeps the engine path untouched.
 */
function rebroadcastPublicChat(player, text, name) {
  const iconPrefix = (player.getChatIcons?.() ?? []).map((icon) => `<img=${icon}>`).join("");
  player.forceChat(`${iconPrefix}${text}`);
  const recipients = [
    player,
    ...(player.getLocalPlayers?.() ?? []),
    ...World.getNearbyPlayersForUpdate(player).filter((recipient) =>
      recipient.getLocalPlayers().includes(player)
    ),
  ];
  const sent = new Set();
  for (const recipient of recipients) {
    if (
      !recipient ||
      sent.has(recipient.getIndex()) ||
      (recipient !== player && !recipient.getRelations?.().canReceivePublicChatFrom?.(player))
    )
      continue;
    sent.add(recipient.getIndex());
    recipient.getPacketSender().sendPublicChat(text, `${iconPrefix}${name}`, player.getIndex());
  }
}

function onSocialPacket(event) {
  const { player, packet } = event || {};
  if (!packet || packet.type !== "public_chat") return;
  if (!player || player.isPlayerBot?.() === true) return;
  const name = player.getAttribute?.(CHARACTER_DISPLAY_ATTRIBUTE);
  if (!name) return; // No display name yet — engine path handles it.
  event.handled = true;
  try {
    rebroadcastPublicChat(player, packet.text, name);
  } catch (err) {
    console.warn(`[backgrounds] display-name rebroadcast failed: ${err?.message ?? err}`);
  }
}

// --- triggers ----------------------------------------------------------------

function onOriginSelected({ player }) {
  if (!player || player.isPlayerBot?.() === true) return;
  // The origin claim just closed its interface; the chatbox is free.
  queueMicrotask(() => {
    if (!hasBackground(player)) promptBackgroundPageOne(player);
    else if (!hasFullName(player)) resumeFlow(player);
  });
}

function onPlayerLogin({ player }) {
  if (!player || player.isPlayerBot?.() === true) return;
  if (!Selection.hasOrigin(player)) return; // The origin flow owns choiceless players.
  if (hasCharacter(player)) return;
  if (player.getAttribute(MOBILE_CLIENT_ATTRIBUTE) === true) {
    // No welcome screen on mobile: the gameframe is already up.
    queueMicrotask(() => resumeFlow(player));
  }
  // Desktop resume happens from the welcome-screen Play button (below) so the
  // prompt isn't clobbered by the welcome screen's root swap.
}

function onWelcomePlay({ player }) {
  if (!player || player.isPlayerBot?.() === true) return false;
  if (!Selection.hasOrigin(player)) return false; // Origin flow owns it.
  if (hasCharacter(player)) return false;
  queueMicrotask(() => resumeFlow(player));
  return false; // Never consume the click for other handlers.
}

/** ::originreset restarts creation cleanly: background and names go too. */
function onOriginsReset({ player }) {
  if (!player) return;
  for (const attr of [
    BACKGROUND_ID_ATTRIBUTE,
    BACKGROUND_CONTACT_ATTRIBUTE,
    CHARACTER_FIRST_ATTRIBUTE,
    CHARACTER_LAST_ATTRIBUTE,
    CHARACTER_DISPLAY_ATTRIBUTE,
  ]) {
    try {
      player.setAttribute(attr, null);
    } catch {
      // Best-effort.
    }
  }
  pendingFirst.delete(player);
  pendingFirstName.delete(player);
}

function clearPending({ player }) {
  pendingFirst.delete(player);
  pendingFirstName.delete(player);
}

// --- commands ----------------------------------------------------------------

function showBackground({ player }) {
  const bg = getBackground(player);
  if (!bg) {
    player.sendMessage("Your past is unwritten — the road is still deciding.");
    return;
  }
  const contact = player.getAttribute(BACKGROUND_CONTACT_ATTRIBUTE);
  player.sendMessage(
    `${displayName(player)}, formerly a ${bg.name.toLowerCase()}.${contact ? ` You know ${contact}.` : ""}`
  );
}

// --- register ----------------------------------------------------------------

function register(api) {
  pluginApi = api;
  core = api.core;
  ({ ItemIdentifiers: Items, Skill, World, ActionDialogue, StatementDialogue, DialogueChainBuilder, MOBILE_CLIENT_ATTRIBUTE } = core);
  Data.validateItemKeys(Items);
  Data.validateSkillKeys(Skill);

  api.persistAttribute(BACKGROUND_ID_ATTRIBUTE);
  api.persistAttribute(BACKGROUND_CONTACT_ATTRIBUTE);
  api.persistAttribute(CHARACTER_FIRST_ATTRIBUTE);
  api.persistAttribute(CHARACTER_LAST_ATTRIBUTE);
  api.persistAttribute(CHARACTER_DISPLAY_ATTRIBUTE);
  api.onCustomEvent("origins:selected", onOriginSelected);
  api.onCustomEvent("origins:reset", onOriginsReset);
  api.onPlayerLogin(onPlayerLogin);
  api.onInterfaceActionButton(WELCOME_PLAY_BUTTON_UID, onWelcomePlay);
  api.onPlayerLogout(clearPending);
  api.onPlayerDisconnect(clearPending);
  api.onSocialPacket(onSocialPacket);
  api.registerCommand("background", showBackground, undefined, "Show your past life");
}

module.exports = register;
module.exports.displayName = displayName;
module.exports.getBackground = getBackground;
module.exports.hasCharacter = hasCharacter;
module.exports.hasBackground = hasBackground;
module.exports.hasFullName = hasFullName;
module.exports.applyBackground = applyBackground;
module.exports.setNames = setNames;
module.exports.cleanNamePart = cleanNamePart;
module.exports.BACKGROUND_ID_ATTRIBUTE = BACKGROUND_ID_ATTRIBUTE;
module.exports.CHARACTER_DISPLAY_ATTRIBUTE = CHARACTER_DISPLAY_ATTRIBUTE;
