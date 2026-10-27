/**
 * The ritual site after Desert Treasure II, one instance per player (rsprox 3285, 3344):
 * - Climbing over the rocks into it asks "Consume the awakener's orb to awaken Vardorvis?" when
 *   the player carries one (Yes. awakens him), then: "You enter the ritual site." over a fade
 *   out, the minimap off a tick later, the move in two ticks in (Vardorvis appears on his spot
 *   with his rise, the rocks behind become "Leave"), the fade back in at four with the message
 *   again to continue, and the fade gone at six.
 * - Leaving by the rocks (or a Tendril's Quick-escape while the rocks are sealed, Wiki) clears the
 *   boss HUD at once and runs the same fade, without a message, back to the rocks' far side.
 * - Leaving any other way - a teleport, death, logging out - ends the instance; a player saved
 *   inside logs in outside. A death's grave goes outside the rocks (Wiki: unprotected items go to
 *   a grave).
 */
const Common = require("./Common.Vardorvis");
const Scoreboard = require("./Scoreboard.Vardorvis");

const MINIMAP_STATE_VARBIT = 6719;
const MINIMAP_OFF = 2;
const OVERLAY_ATMOSPHERE_UID = (161 << 16) | 1;
const FADE_OVERLAY = 174;
const FADE_SCRIPT = 948;
const FADE_CYCLES = 50;
const LOC_SHAPE = 10;

/** Per player: their ritual site while they are in it. */
const sessions = new Map();

let AreaClass = null;

function areaClass() {
  if (AreaClass) return AreaClass;
  const { TemplatedInstanceArea } = Common.core;
  AreaClass = class VardorvisRitualSite extends TemplatedInstanceArea {
    constructor() {
      const { width, height } = Common.data.instance;
      super(width, height);
      this.session = null;
    }

    getName() {
      return "Vardorvis' ritual site";
    }

    allowSummonPet() {
      return false;
    }

    /** Vardorvis, the tendrils and their axes go with it. */
    destroy() {
      if (this.isDestroyed()) return;
      for (const entity of [...this.entities]) {
        if (!entity.isNpc?.()) continue;
        this.detach(entity);
        Common.api.removeNpc(entity);
      }
      super.destroy();
    }

    /** Leaving ends the site; logging out puts the player outside before they're saved. */
    postLeave(mobile, logout) {
      const session = this.session;
      const player = mobile.isPlayer?.() && session?.player === mobile.getAsPlayer() ? mobile.getAsPlayer() : null;
      if (player && logout) player.setLocation(Common.toWorld(Common.data.site.outside));
      if (player) session.end();
      super.postLeave(mobile, logout);
    }
  };
  return AreaClass;
}

class Session {
  constructor(player, awakened) {
    this.player = player;
    this.awakened = awakened;
    this.area = new (areaClass())();
    this.area.session = this;
    this.copySite();
    this.exit = null;
    this.fight = null;
    this.ended = false;
  }

  copySite() {
    const { sourceChunkX, sourceChunkY, width, height } = Common.data.instance;
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        this.area.setChunk(0, x, y, { sourceChunkX: sourceChunkX + x, sourceChunkY: sourceChunkY + y, sourcePlane: 0, rotation: 0 });
      }
    }
  }

  tile(tile) {
    return Common.tile(this.area, tile);
  }

  /** A loc of the site's own, gone with the instance. */
  placeLoc(id, tile, rotation = 0) {
    const { GameObject, ObjectManager } = Common.core;
    const object = new GameObject(id, this.tile(tile), LOC_SHAPE, rotation, this.area);
    ObjectManager.register(object, true);
    return object;
  }

  /** The rocks behind the player: "Leave", or sealed while the barrier is up. */
  setExit(sealed) {
    const { exitLoc, exitSealedLoc, exitTile } = Common.data.site;
    this.exit = this.placeLoc(sealed ? exitSealedLoc : exitLoc, exitTile);
  }

  /** An NPC of the site's, gone with the instance. */
  spawn(id, tile, face) {
    const at = tile.getX ? tile : this.tile(tile);
    const npc = Common.api.spawnNpc({
      id, x: at.getX(), y: at.getY(), z: at.getZ(), owner: this.player, wanderRadius: 0,
      face: face == null ? undefined : Common.facing(face),
    });
    if (!npc) return null;
    npc.__skipDefaultRespawn = true;
    npc.__vardorvisSession = this;
    this.area.add(npc);
    return npc;
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    sessions.delete(this.player);
    this.fight?.stop();
    this.player.setAttribute(Common.INSIDE_ATTRIBUTE, false);
    Common.api.emitCustomEvent("boss-hud:hide", { player: this.player, fade: false, afterTicks: 0 });
    if (!this.area.isDestroyed()) this.area.destroy();
  }
}

const sessionOf = (player) => sessions.get(player) ?? null;

function fade(player, out) {
  const args = out ? [0, 255, 0, 0, FADE_CYCLES] : [0, 0, 0, 255, FADE_CYCLES];
  player.getPacketSender().sendSubInterface(OVERLAY_ATMOSPHERE_UID, FADE_OVERLAY, 1, {
    postScripts: [{ scriptId: FADE_SCRIPT, args }],
  });
}

/**
 * The captured trip over the rocks: the fade out (with `message`, no continue, going in), the
 * minimap off a tick later, `move` two ticks in, the fade back in at four (the message again, to
 * continue), and the fade overlay closed at six.
 */
function travel(player, message, move) {
  const { minimapTicks, moveTicks, inTicks, closeTicks } = Common.data.site.fade;
  const { StatementDialogue } = Common.core;
  const sender = player.getPacketSender();
  fade(player, true);
  if (message) StatementDialogue.send(player, message, false);
  Common.later(minimapTicks, () => player.isRegistered() && sender.sendVarbit(MINIMAP_STATE_VARBIT, MINIMAP_OFF));
  Common.later(moveTicks, () => player.isRegistered() && move());
  Common.later(inTicks, () => {
    if (!player.isRegistered()) return;
    sender.sendVarbit(MINIMAP_STATE_VARBIT, 0);
    fade(player, false);
    if (message) StatementDialogue.send(player, message, true);
  });
  Common.later(closeTicks, () => player.isRegistered() && sender.closeSubInterface(OVERLAY_ATMOSPHERE_UID));
}

/** Builds the player's ritual site and moves them in behind the captured fade. */
function enter(player, awakened) {
  if (sessionOf(player)) return;
  const session = new Session(player, awakened);
  sessions.set(player, session);
  const { site } = Common.data;
  player.getMovementQueue().reset();
  travel(player, site.enterMessage, () => {
    if (session.ended) return;
    session.area.enter(player);
    player.moveTo(session.tile(site.arrival));
    player.setAttribute(Common.INSIDE_ATTRIBUTE, true);
    session.setExit(false);
    require("./Fight.Vardorvis").spawnBoss(session);
  });
}

/** Back over the rocks; the area's postLeave ends the site. */
function leave(player) {
  const session = sessionOf(player);
  if (!session) return false;
  player.getMovementQueue().reset();
  Common.api.emitCustomEvent("boss-hud:hide", { player, fade: false, afterTicks: 0 });
  travel(player, null, () => {
    player.moveTo(Common.toWorld(Common.data.site.outside));
    session.end();
  });
  return true;
}

function questComplete(player) {
  const request = { player, key: Common.data.quest, complete: false };
  Common.api.emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

/** The rocks into the ritual site (the quest's own fight runs until the quest is done). */
function climbOver({ player }) {
  if (sessionOf(player) || !questComplete(player)) return false;
  const { site } = Common.data;
  if (!player.getInventory().contains(site.awakenerOrb)) {
    enter(player, false);
    return true;
  }
  Common.api.sendMultiChatboxPrompt(player, site.awakenQuestion, "Yes.", () => {
    player.getPacketSender().sendInterfaceRemoval();
    if (!player.getInventory().contains(site.awakenerOrb)) return;
    player.getInventory().delete(site.awakenerOrb, 1);
    enter(player, true);
  }, "No.", () => {
    player.getPacketSender().sendInterfaceRemoval();
    enter(player, false);
  });
  return true;
}

const leaveByRocks = ({ player }) => leave(player);
const quickEscape = ({ player }) => leave(player);

/** A player saved inside (the server stopped) comes back outside the rocks. */
function recoverOnLogin({ player }) {
  if (!player.getAttribute(Common.INSIDE_ATTRIBUTE) || sessionOf(player)) return;
  player.setAttribute(Common.INSIDE_ATTRIBUTE, false);
  player.moveTo(Common.toWorld(Common.data.site.outside));
}

/** A death here leaves its grave outside the rocks. */
function graveOutside(request) {
  if (!sessionOf(request.player)) return;
  const [x, y, z] = Common.data.site.outside;
  request.tile = { x, y, z };
}

/**
 * A death in the ritual site while his fight is on counts on the tablet, for that fight (as
 * Site.Leviathan.js counts its deaths). It hears every death (onPlayerDefeated): onPlayerDeath
 * stops at the first plugin that handles the respawn, as Death's Office does for a first grave.
 */
function diedAtSite({ victim: player }) {
  const session = sessionOf(player);
  const fight = session?.fight;
  if (!fight || fight.over || fight.stopped || player.getPrivateArea() !== session.area) return;
  Scoreboard.died(player, fight.awakened);
}

function attachSite(api) {
  const { site } = Common.data;
  api.persistAttribute(Common.INSIDE_ATTRIBUTE, false);
  api.onPlayerLogin(recoverOnLogin);
  api.onObjectFirstClick([site.entryLoc], climbOver);
  api.onObjectSecondClick([site.exitLoc], leaveByRocks);
  api.onObjectInteraction("Tendril", { "Quick-escape": quickEscape });
  api.onCustomEvent("gravestones:grave-location", graveOutside);
  api.onPlayerDefeated(diedAtSite);
}

module.exports = { attachSite, enter, leave, sessionOf, diedAtSite, LOC_SHAPE };
