"use strict";

/**
 * Being allowed to be Zulrah's sacrifice (rsprox 234/03276, varbit snakeboss_info):
 * - 0: the priestess turns the player away from the boat ("The sacrificial boat is not for you!");
 * - 1: the High Priestess has told them of the periodic sacrifice ("All he asks in return is a
 *   periodic sacrifice at his sacred shrine.");
 * - 2: she has accepted them in the gnome's place ("... and I accept. You shall be our next
 *   sacrifice.");
 * - 3: the priestess has explained the ritual and rowed them out the first time ("I shall now
 *   transport you to Zulrah's shrine and offer your life on behalf of our tribe.").
 * The cache's boat (Board, Quick-Board) and priestess (Collect) forms follow the varbit. The stage
 * is saved; a player who has already killed Zulrah is past it.
 *
 * Wiki (/w/Zulrah): Regicide must be played as far as Port Tyras (the only way to Zul-Andra), not
 * completed; the QuestRuntime answers quest:get-stage for it.
 */

const Shared = require("./Shared.Zulrah");

const ACCESS_ATTRIBUTE = "zulrah:access";
/** The player is to be rowed out (the ritual's last line, or "Yes." to going back): Shrine sails. */
const SAIL_EVENT = "zulrah:sail";
const STAGE = Object.freeze({ NONE: 0, TOLD: 1, ACCEPTED: 2, SACRIFICED: 3 });
/**
 * Regicide's stage when the dense forest first opens the way to Tyras camp (STAGE_ENTERED_CAMP in
 * Regicide.Quest.js). The Wiki requires progress to Port Tyras, not the finished quest.
 */
const REGICIDE_PORT_TYRAS_STAGE = 10;
const HIGH_PRIESTESS = "High Priestess Zul-Harcinqa";
const PRIESTESS = "Priestess Zul-Gwenwynig";

/** The transcript variants for each stage (the generated npc-dialogues export). */
const VARIANT = Object.freeze({
  highPriestess: {
    /** Recorded first meeting: "Why do you bother the High Priestess of Zulrah, human?" (the Wiki's former dialogue). */
    first: "standard-dialogue-talking-to-her-before-offering-yourself-as-a-sacrifice-former-dialogue",
    /** Once told of the sacrifice: the menu with "How do people get chosen as a sacrifice to Zulrah?" (recorded next). */
    before: "standard-dialogue-talking-to-her-before-offering-yourself-as-a-sacrifice-current-dialogue",
    accepted: "standard-dialogue-talking-to-her-after-offering-yourself-as-a-sacrifice-but-before-having-encountered-zulrah",
    after: "standard-dialogue",
  },
  priestess: {
    before: "standard-dialogue-talking-to-her-before-offering-yourself-as-a-sacrifice",
    board: "standard-dialogue-attempting-to-board-the-boat-before-offering-yourself-as-a-sacrifice",
    accepted: "standard-dialogue-talking-to-her-after-offering-yourself-as-a-sacrifice",
    after: "standard-dialogue-talking-to-her-before-after-offering-yourself-as-a-sacrifice-but-before-killing-zulrah",
    /** With a kill: her default, with "I killed Zulrah.". */
    killed: "standard-dialogue",
  },
});

/** The recorded line each stage begins on (start of the line, as shown). */
const STAGE_LINES = Object.freeze([
  [HIGH_PRIESTESS, "All he asks in return is a periodic sacrifice", STAGE.TOLD],
  [HIGH_PRIESTESS, "... and I accept. You shall be our next sacrifice", STAGE.ACCEPTED],
  [PRIESTESS, "I shall now transport you to Zulrah's shrine", STAGE.SACRIFICED],
]);

/** Waiting on "Yes." after "I've been there, but I left." (that menu's options carry no ids). */
const askedToReturn = new WeakSet();

const killed = (player) => (Number(player.getAttribute(Shared.ATTR.KILLS)) || 0) > 0;
const holdsItems = (player) => Array.isArray(player.getAttribute(Shared.ATTR.RETRIEVAL)?.items);

/** Past the High Priestess once Zulrah is killed, or once the priestess holds items from the shrine. */
function stageOf(player) {
  const stage = Number(player.getAttribute(ACCESS_ATTRIBUTE)) || 0;
  return killed(player) || holdsItems(player) ? STAGE.SACRIFICED : stage;
}

function setStage(player, stage) {
  if (stage <= stageOf(player)) return;
  player.setAttribute(ACCESS_ATTRIBUTE, stage);
  sendStage(player);
}

function sendStage(player) {
  player.getPacketSender().sendVarbit(Shared.ACCESS_VARBIT, stageOf(player));
}

function nameOf(event) {
  return event.definition?.getName?.() ?? "";
}

/** Each priestess's transcript for the player's stage. */
function chooseVariant(event) {
  const stage = stageOf(event.player);
  const name = nameOf(event);
  if (name === HIGH_PRIESTESS) {
    if (stage === STAGE.NONE) return VARIANT.highPriestess.first;
    if (stage < STAGE.ACCEPTED) return VARIANT.highPriestess.before;
    return stage === STAGE.ACCEPTED ? VARIANT.highPriestess.accepted : VARIANT.highPriestess.after;
  }
  if (name === PRIESTESS) {
    if (stage < STAGE.ACCEPTED) return VARIANT.priestess.before;
    if (stage === STAGE.ACCEPTED) return VARIANT.priestess.accepted;
    return killed(event.player) ? VARIANT.priestess.killed : VARIANT.priestess.after;
  }
  return null;
}

/** The High Priestess's "visited the shrine" and "killed Zulrah" branches. */
function answerCondition(event) {
  if (nameOf(event) !== HIGH_PRIESTESS) return undefined;
  if (/killed Zulrah/i.test(event.text) && !/not killed/i.test(event.text)) return killed(event.player);
  if (/visited the shrine but not killed/i.test(event.text)) return stageOf(event.player) >= STAGE.SACRIFICED && !killed(event.player);
  return undefined;
}

/**
 * A recorded stage line moves the player on once its page is reached (`before`: lines are emitted
 * while the dialogue is built); the ritual's last one has them rowed out.
 */
function advanceOnLine(event) {
  const name = nameOf(event);
  for (const [speaker, start, stage] of STAGE_LINES) {
    if (speaker !== name || !String(event.text ?? "").startsWith(start)) continue;
    const { player } = event;
    event.before = () => {
      const first = stageOf(player) < stage;
      setStage(player, stage);
      if (stage === STAGE.SACRIFICED && first) Shared.api().emitCustomEvent(SAIL_EVENT, { player });
    };
    return;
  }
}

/**
 * Talk-to plays each priestess's transcript for the player's stage. The dialogue index doesn't list
 * them, so the variant is asked for by name ("npc-dialogue:start").
 */
function startTranscript(player, npc, name, npcId) {
  const variant = chooseVariant({ player, definition: { getName: () => name } });
  const request = { player, npc, npcId, variant, exact: true, handled: false };
  Shared.api().emitCustomEvent("npc-dialogue:start", request);
  return request.handled;
}

function talkToHighPriestess({ player, npc }) {
  return startTranscript(player, npc, HIGH_PRIESTESS, Shared.core().NpcIdentifiers.HIGH_PRIESTESS_ZUL_HARCINQA);
}

/** Zul-Gwenwynig's Talk-to when she holds nothing for the player (Shrine handles that case). */
function talkToPriestess(player, npc) {
  // Her multinpc's base id has no name; ask by a named form so the transcript resolves.
  return startTranscript(player, npc, PRIESTESS, Shared.core().NpcIdentifiers.PRIESTESS_ZUL_GWENWYNIG);
}

/**
 * "Tell me about Zulrah." is where the recorded story (and varbit 1) comes; the Wiki's former
 * dialogue, played at the first meeting, has the option without the story lines.
 */
function advanceOnChoice(event) {
  const { player } = event;
  if (nameOf(event) === HIGH_PRIESTESS && event.option === "Tell me about Zulrah.") return void setStage(player, STAGE.TOLD);
  if (nameOf(event) !== PRIESTESS) return;
  // Her "Return to Zulrah's shrine?" after "I've been there, but I left." has no steps of its own.
  if (event.option === "I've been there, but I left.") return void askedToReturn.add(player);
  const asked = askedToReturn.has(player);
  askedToReturn.delete(player);
  if (asked && event.option === "Yes." && stageOf(player) >= STAGE.SACRIFICED) Shared.api().emitCustomEvent(SAIL_EVENT, { player });
}

/** Wiki: the boat needs Regicide played as far as Port Tyras, not completed. */
function reachedPortTyras(player) {
  const request = { player, key: "regicide", stage: 0 };
  Shared.api().emitCustomEvent("quest:get-stage", request);
  return request.stage >= REGICIDE_PORT_TYRAS_STAGE;
}

/**
 * Boarding before the High Priestess's leave, or before Port Tyras: the priestess's own
 * transcript for it.
 */
function refuseBoarding(player) {
  const stage = stageOf(player);
  const portTyras = reachedPortTyras(player);
  if (stage >= STAGE.SACRIFICED && portTyras) return false;
  // Before Port Tyras even her accepted transcript would row them out, so refuse as the boat's.
  const variant = portTyras && stage === STAGE.ACCEPTED ? VARIANT.priestess.accepted : VARIANT.priestess.board;
  Shared.api().emitCustomEvent("npc-dialogue:start", { player, npcId: Shared.core().NpcIdentifiers.PRIESTESS_ZUL_GWENWYNIG, variant, exact: true, handled: false });
  return true;
}

/** Logged in on the shrine (it ended at a logout): they had been rowed out, so they are past her. */
function sendStageOnLogin({ player }) {
  if (Shared.inShrine(player.getLocation())) setStage(player, STAGE.SACRIFICED);
  sendStage(player);
}

function attach(api) {
  api.persistAttribute(ACCESS_ATTRIBUTE, 0);
  api.onPlayerLogin(sendStageOnLogin);
  api.onNpcInteraction(HIGH_PRIESTESS, { "Talk-to": talkToHighPriestess });
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:line", advanceOnLine);
  api.onCustomEvent("npc-dialogue:choice", advanceOnChoice);
}

module.exports = { attach, stageOf, refuseBoarding, reachedPortTyras, REGICIDE_PORT_TYRAS_STAGE, talkToPriestess, chooseVariant, STAGE, ACCESS_ATTRIBUTE, SAIL_EVENT, VARIANT };
