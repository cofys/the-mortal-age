"use strict";

/**
 * MyKingdom.Kingdoms — the "My Kingdom" panel triggers.
 *
 * The origins pick is the signature moment; this makes it land. When a
 * player chooses their home kingdom, the panel opens once: "welcome home,
 * here's your realm." After that, talking to any Town crier offers
 * "Ask about the realm", which reopens it. No ::commands — the panel is
 * the interface.
 *
 * NOTE: NPC clicks dispatch on the NPC definition's cache actions
 * (definition.getActions()[clickType-1]), so a custom "Ask-about-realm"
 * action key can never match — the crier's cache action is "Talk-to".
 * We hook Talk-to and offer the realm as a chatbox choice instead.
 */

const { MYKINGDOM_OPEN_ATTRIBUTE } = require("./MyKingdomApi");

let pluginApi = null;

function openPanel(player) {
  if (!player || player.isPlayerBot?.() === true) return;
  try {
    player.setAttribute(MYKINGDOM_OPEN_ATTRIBUTE, "1");
  } catch (error) {
    console.warn("[my-kingdom] open failed", error?.message ?? error);
  }
}

/** Talk-to the Town crier: realm panel or his usual news. */
function talkToCrier(event) {
  const player = event?.player;
  if (!player || player.isPlayerBot?.() === true) return false;
  try {
    const shown = pluginApi.sendMultiChatboxPrompt(
      player,
      "The Town crier rings his bell.",
      "Ask about the realm.",
      () => openPanel(player),
      "Hear his news.",
      () => {
        try {
          pluginApi.emitCustomEvent("npc-dialogue:start", {
            player,
            npc: event.npc,
            npcId: event.npcId,
          });
        } catch {
          // The crier's news is courtesy; the panel already worked.
        }
      },
      "Leave.",
      () => {}
    );
    if (shown) return true;
  } catch {
    // Fall through to the crier's normal dialogue.
  }
  return false;
}

function attachMyKingdom(api) {
  pluginApi = api;
  // Diegetic reopen: the Town crier knows the realm's business. The cache
  // name is "Town crier" (npc-dialogues.json keys "Town Crier"); the engine
  // matches definition.getName() strictly, so register both casings.
  api.onNpcInteraction("Town crier", { "Talk-to": talkToCrier });
  api.onNpcInteraction("Town Crier", { "Talk-to": talkToCrier });

  // Welcome moment: origins grants kingdom:id; open the panel once so the
  // choice lands with real information about the realm they just joined.
  api.onCustomEvent("kingdom:rank-granted", ({ player } = {}) => {
    if (!player) return;
    try {
      const already = String(player.getAttribute("mykingdom:welcomed") || "").trim();
      if (already) return;
      player.setAttribute("mykingdom:welcomed", "1");
    } catch {
      return;
    }
    openPanel(player);
  });

  console.info("[my-kingdom] Town crier + origins welcome triggers ready");
}

module.exports = attachMyKingdom;
module.exports._test = { openPanel, talkToCrier };
