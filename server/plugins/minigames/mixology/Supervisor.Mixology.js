"use strict";

/**
 * Supervisor Lalo (multinpc 14099: 13920 with Talk-to until varbit 11336, then 13921 with
 * Talk-to and Rewards).
 *
 * - Talk-to plays the Wiki's "Transcript:Supervisor Lalo": the first-time variant until he has
 *   explained the lab, then the after-the-first-interaction one.
 * - The Wiki's first-time transcript skips two lines live says before the run-through choice
 *   (it marks the gap with a blank message step); they are played here, and varbit 11336
 *   (mm_met_supervisor) is set on the first of them, as captured (recording 4184).
 * - "Can I have some rewards?" and Rewards (op3) open his omnishop, Mixology Rewards.
 * - Using a machine before meeting him plays his "Hey! I haven't given you permission to do
 *   that!" (Shared.permitted).
 */

const Shared = require("./Shared.Mixology");
const RewardShop = require("./RewardShop.Mixology");

const VARIANT = {
  FIRST: "standard-dialogue-the-first-time-the-player-talks-to-supervisor-lalo",
  AFTER: "standard-dialogue-talking-to-supervisor-lalo-after-the-first-interaction",
};
/** "Transcript:Supervisor Lalo" steps, by id. */
const STEP = { MISSING_LINES: "SVaEy2", OPEN_SHOP: "jXyMMt" };
/** What live says where the Wiki transcript has its blank message step (recording 4184). */
const MISSING_LINES = [
  "Now, as you produce these potions, you'll collect resin from each of the three reagents. This resin will demonstrate how well you've worked and can be traded in for some rewards.",
  "Right, that covers the basics. You can head in and get started now if you want, but first I'd suggest we do a quick run through of the step-by-step process you'll need to follow.",
];
const SUPERVISOR_IDS = new Set([Shared.NPC.SUPERVISOR, Shared.NPC.SUPERVISOR_FIRST, Shared.NPC.SUPERVISOR_MET]);
const LINE_WIDTH = 53;

function isSupervisor(npcId) {
  return SUPERVISOR_IDS.has(npcId);
}

function chooseVariant({ npcId, player }) {
  if (!isSupervisor(npcId)) return null;
  return Shared.get(player, Shared.VARBIT.MET_SUPERVISOR) === 1 ? VARIANT.AFTER : VARIANT.FIRST;
}

/** The first-time transcript from its run-through choice on. */
function fromChoice(steps) {
  const gap = steps.findIndex((step) => step.id === STEP.MISSING_LINES);
  return gap >= 0 ? steps.slice(gap + 1) : steps;
}

function playMissingLines(player, npcId) {
  const { DialogueChainBuilder, NpcDialogue, ActionDialogue, Misc } = Shared.core();
  const chain = new DialogueChainBuilder();
  let index = 0;
  for (const line of MISSING_LINES) {
    const lines = Misc.wrapText(line, LINE_WIDTH);
    for (let start = 0; start < lines.length; start += 4) {
      chain.add(new NpcDialogue(index++, npcId, lines.slice(start, start + 4).join(" ")));
    }
  }
  chain.add(new ActionDialogue(index, {
    execute: () => Shared.api().emitCustomEvent("npc-dialogue:start", { player, npcId, variant: VARIANT.FIRST, select: fromChoice }),
  }));
  return chain;
}

/** Plays the two lines, then the rest of the first-time transcript. */
function fillGap(request) {
  if (!isSupervisor(request.npcId) || request.stepId !== STEP.MISSING_LINES) return;
  const { player, npcId } = request;
  Shared.set(player, Shared.VARBIT.MET_SUPERVISOR, 1);
  request.handled = true;
  const chain = playMissingLines(player, npcId);
  player.getDialogueManager().startDialogues(chain);
}

function openFromDialogue(request) {
  if (!isSupervisor(request.npcId) || request.stepId !== STEP.OPEN_SHOP) return;
  request.handled = true;
  request.end = true;
  const { player } = request;
  Shared.later(1, () => RewardShop.open(player));
}

function rewards({ player }) {
  RewardShop.open(player);
}

module.exports = function attachSupervisor(api) {
  api.onNpcInteraction(Shared.NPC.SUPERVISOR_NAME, { Rewards: rewards });
  api.onNpcDialogueVariant(chooseVariant);
  api.onCustomEvent("npc-dialogue:action", fillGap);
  api.onCustomEvent("npc-dialogue:action", openFromDialogue);
};

Object.assign(module.exports, { fromChoice, VARIANT });
