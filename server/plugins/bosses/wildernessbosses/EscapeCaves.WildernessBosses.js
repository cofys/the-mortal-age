/**
 * The Escape Caves' air (https://oldschool.runescape.wiki/w/Escape_Caves): a player who comes in
 * from one of the four surface caves is slowly weakened, to keep player killers from camping
 * there; one who comes out of a boss lair is not.
 *
 * As captured (varbit 14692 wbr_decay_state): every 10 ticks in the caves the state goes up one;
 * from 6 each step drains 1 Prayer point and 2% run energy, and the first drain of a visit says
 * "You feel a chill down your spine...". The state carries over between visits; leaving a lair
 * into the caves resets it, and so does coming in from the surface after a long while away
 * (captured: 10 minutes reset it, 1 minute did not).
 */
const Common = require("./Common.WildernessBosses");

const DECAY_VARBIT = 14692; // wbr_decay_state
const CHILL_MESSAGE = "<col=ef1020>You feel a chill down your spine as the air in the cave weakens you, the air seems to be getting thicker over time.";

/** Persisted: the decay state, and when the player was last in the caves (epoch minutes). */
const STATE_ATTRIBUTE = "wilderness-bosses:escape-decay";
const LAST_SEEN_ATTRIBUTE = "wilderness-bosses:escape-last-seen";
/** Whether the air weakens the player this visit (persisted: a relog doesn't clear the air), the
 * next step's tick, and whether the visit's first drain was told. */
const DECAYING_ATTRIBUTE = "wilderness-bosses:escape-decaying";
const NEXT_STEP_ATTRIBUTE = "wilderness-bosses:escape-next-step";
const TOLD_ATTRIBUTE = "wilderness-bosses:escape-told";

let api = null;
let core = null;
let escapeArea = null;

function nowMinutes() {
  return Math.floor(Date.now() / 60000);
}

function setState(player, state) {
  player.setAttribute(STATE_ATTRIBUTE, state);
  player.getPacketSender().sendVarbit(DECAY_VARBIT, state);
}

function startVisit(player, decaying) {
  player.setAttribute(DECAYING_ATTRIBUTE, decaying);
  player.setAttribute(TOLD_ATTRIBUTE, false);
  player.setAttribute(NEXT_STEP_ATTRIBUTE, core.World.getProcessCycle() + Common.ESCAPE.decay.stepTicks);
  player.setAttribute(LAST_SEEN_ATTRIBUTE, nowMinutes());
}

/** From one of the four surface caves: the air weakens them, fresh after a long while away. */
function enteredFromSurface(player) {
  const last = Number(player.getAttribute(LAST_SEEN_ATTRIBUTE)) || 0;
  if (nowMinutes() - last >= Common.ESCAPE.decay.resetAfterMinutes) setState(player, 0);
  startVisit(player, true);
}

/** Out of a boss lair: the state resets and the air leaves them be. */
function enteredFromLair(player) {
  setState(player, 0);
  startVisit(player, false);
}

/** Per tick, players in the caves only: the next step of the decay. */
function step(player) {
  if (player.getAttribute(DECAYING_ATTRIBUTE) !== true) return;
  const now = core.World.getProcessCycle();
  const next = player.getAttribute(NEXT_STEP_ATTRIBUTE);
  if (!Number.isInteger(next)) {
    // Back from a logout: the steps go on from here.
    player.setAttribute(NEXT_STEP_ATTRIBUTE, now + Common.ESCAPE.decay.stepTicks);
    return;
  }
  if (now < next) return;
  const { decay } = Common.ESCAPE;
  player.setAttribute(NEXT_STEP_ATTRIBUTE, now + decay.stepTicks);
  player.setAttribute(LAST_SEEN_ATTRIBUTE, nowMinutes());
  const state = (Number(player.getAttribute(STATE_ATTRIBUTE)) || 0) + 1;
  setState(player, state);
  if (state < decay.drainFromState) return;
  if (player.getAttribute(TOLD_ATTRIBUTE) !== true) {
    player.setAttribute(TOLD_ATTRIBUTE, true);
    player.sendMessage(CHILL_MESSAGE);
  }
  const skills = player.getSkillManager();
  const prayer = skills.getCurrentLevel(core.Skill.PRAYER);
  if (prayer > 0) skills.setCurrentLevel(core.Skill.PRAYER, Math.max(0, prayer - decay.prayerDrain), true);
  player.setRunEnergy(player.getRunEnergy() - decay.runEnergyDrain / 100);
  player.getPacketSender().sendRunEnergy();
}

function sendState({ player }) {
  const state = Number(player.getAttribute(STATE_ATTRIBUTE)) || 0;
  if (state > 0) player.getPacketSender().sendVarbit(DECAY_VARBIT, state);
}

function createArea() {
  class EscapeCavesArea extends core.Area {
    constructor() {
      super([Common.boundary(Common.ESCAPE.box, Common.ESCAPE.plane)]);
    }

    process(mobile) {
      Common.rules()?.process(mobile);
      if (mobile.isPlayer()) step(mobile.getAsPlayer());
    }

    postEnter(mobile) {
      Common.rules()?.postEnter(mobile);
      if (mobile.isPlayer()) mobile.getAsPlayer().setAttribute(Common.VISITED_ATTRIBUTE, true);
    }

    postLeave(mobile, logout) {
      Common.rules()?.postLeave(mobile, logout);
      // Logging out keeps the visit going; walking or teleporting out ends it.
      if (mobile.isPlayer() && !logout) mobile.getAsPlayer().setAttribute(DECAYING_ATTRIBUTE, false);
    }

    canAttack(attacker, target) {
      return Common.rules()?.canAttack(attacker, target) ?? null;
    }

    canTeleport(player, wildernessLevelLimit) {
      return Common.rules()?.canTeleport(player, wildernessLevelLimit) ?? null;
    }

    npcAggressionTolerance(player, npc) {
      return Common.rules()?.npcAggressionTolerance(player, npc) ?? null;
    }

    isMulti() {
      return true;
    }
  }
  return new EscapeCavesArea();
}

function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  pluginApi.persistAttribute(STATE_ATTRIBUTE, 0);
  pluginApi.persistAttribute(LAST_SEEN_ATTRIBUTE, 0);
  pluginApi.persistAttribute(DECAYING_ATTRIBUTE, false);
  pluginApi.onPlayerLogin(sendState);
  escapeArea = createArea();
  pluginApi.registerArea(escapeArea);
}

module.exports = {
  attach,
  area: () => escapeArea,
  enteredFromSurface,
  enteredFromLair,
  _test: { step, STATE_ATTRIBUTE, LAST_SEEN_ATTRIBUTE, DECAYING_ATTRIBUTE, NEXT_STEP_ATTRIBUTE },
};
