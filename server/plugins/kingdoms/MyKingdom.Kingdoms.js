"use strict";

/**
 * MyKingdom.Kingdoms — the "My Kingdom" panel triggers.
 *
 * The origins pick is the signature moment; this makes it land. When a
 * player chooses their home kingdom, the panel opens once: "welcome home,
 * here's your realm." After that, any Town crier ("Ask about the realm")
 * reopens it. No ::commands — the panel is the interface.
 */

const { MYKINGDOM_OPEN_ATTRIBUTE } = require("./MyKingdomApi");

function openPanel(player) {
  if (!player || player.isPlayerBot?.() === true) return;
  try {
    player.setAttribute(MYKINGDOM_OPEN_ATTRIBUTE, "1");
  } catch (error) {
    console.warn("[my-kingdom] open failed", error?.message ?? error);
  }
}

function askAboutRealm({ player }) {
  openPanel(player);
}

function attachMyKingdom(api) {
  // Diegetic reopen: the Town crier knows the realm's business.
  api.onNpcInteraction("Town crier", { "Ask-about-realm": askAboutRealm });

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
module.exports._test = { openPanel };
