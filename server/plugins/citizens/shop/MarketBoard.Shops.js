"use strict";

/**
 * MarketBoard — DIEGETIC ::shop replacement.
 *
 * Jon's directive: no ::commands for players. Everything through the world.
 * The Market Board is a physical board in each capital's market. Click
 * "Read" and it opens a TMA-styled interface (the Mortal Age UI template
 * from the origin GUI — same palette, typography, frames):
 *
 *   MARKET BOARD
 *   [ Lease a stall ]   — buyStall in this market's kingdom
 *   [ Manage my stall ] — openStall (the existing stall interface)
 *   [ Browse stalls ]   — listStalls
 *
 * The ::shop command stays registered until the board is verified in-game,
 * then it goes. Migration rule: build the world path, verify it works,
 * remove the command. Never the reverse.
 *
 * Group 30014. (30010 citizen stall, 30011 DuelArena, 30012 origin GUI,
 * 30013 player stall.)
 */

const {
  FLAG_OP1,
  TYPE_RECTANGLE,
  TYPE_TEXT,
  createWidgetGroup,
} = require("../../interface/widgetGroup");
const PlayerShops = require("./PlayerShops");
const KingdomStore = require("../../kingdoms/KingdomStore");

const GROUP_ID = 30014;
const MODAL_TARGET_UID = (161 << 16) | 16;

// --- TMA UI template (from Gui.Origins.js) --------------------------------
const TMA = {
  PANEL: 0x14100b,
  PANEL_INNER: 0x1e1812,
  GOLD_DIM: 0x6b5a3a,
  GOLD: 0xc9a227,
  GOLD_TEXT: 0xd9b45b,
  PARCHMENT: 0xe8ded0,
  MUTED: 0x9a8f7d,
  BUTTON: 0x3a2c1a,
  BUTTON_HOVER: 0x4a3a22,
  BUTTON_TEXT: 0xffd27f,
};
const FONT_BODY = 494;
const FONT_LABEL = 496;
const FONT_DISPLAY = 497;

const MODAL_W = 400;
const MODAL_H = 300;

const C = {
  ROOT: 0,
  BORDER: 1,
  BG: 2,
  TITLE: 3,
  SUBTITLE: 4,
  TITLE_RULE: 5,
  BTN_LEASE_BORDER: 10,
  BTN_LEASE_BG: 11,
  BTN_LEASE_TEXT: 12,
  BTN_MANAGE_BORDER: 20,
  BTN_MANAGE_BG: 21,
  BTN_MANAGE_TEXT: 22,
  BTN_BROWSE_BORDER: 30,
  BTN_BROWSE_BG: 31,
  BTN_BROWSE_TEXT: 32,
  FOOTNOTE: 40,
};
const uid = (component) => (GROUP_ID << 16) | component;

let pluginApi = null;

function buildBoardInterface() {
  const { widgets, add } = createWidgetGroup(GROUP_ID);
  const cx = MODAL_W / 2;

  // Root + border + background (nested panels = depth, per the template).
  add(C.ROOT, MODAL_TARGET_UID, {
    type: 0, x: cx - MODAL_W / 2, y: 60, width: MODAL_W, height: MODAL_H,
  });
  add(C.BORDER, uid(C.ROOT), {
    type: TYPE_RECTANGLE, x: 0, y: 0, width: MODAL_W, height: MODAL_H,
    color: TMA.GOLD_DIM,
  });
  add(C.BG, uid(C.ROOT), {
    type: TYPE_RECTANGLE, x: 2, y: 2, width: MODAL_W - 4, height: MODAL_H - 4,
    color: TMA.PANEL,
  });

  // Title.
  add(C.TITLE, uid(C.ROOT), {
    type: TYPE_TEXT, x: cx - MODAL_W / 2, y: 78, width: MODAL_W, height: 30,
    text: "MARKET BOARD", font: FONT_DISPLAY, color: TMA.GOLD_TEXT,
    centered: true, shadowed: true,
  });
  add(C.SUBTITLE, uid(C.ROOT), {
    type: TYPE_TEXT, x: cx - MODAL_W / 2, y: 104, width: MODAL_W, height: 20,
    text: "The market's business, writ plain.", font: FONT_BODY, color: TMA.MUTED,
    centered: true, shadowed: true,
  });
  add(C.TITLE_RULE, uid(C.ROOT), {
    type: TYPE_RECTANGLE, x: 40, y: 128, width: MODAL_W - 80, height: 1,
    color: TMA.GOLD_DIM,
  });

  // Buttons.
  const buttons = [
    { base: C.BTN_LEASE_BORDER, label: "Lease a stall" },
    { base: C.BTN_MANAGE_BORDER, label: "Manage my stall" },
    { base: C.BTN_BROWSE_BORDER, label: "Browse the market" },
  ];
  buttons.forEach(({ base, label }, i) => {
    const y = 150 + i * 44;
    const bw = 220;
    const bx = cx - bw / 2;
    add(base, uid(C.ROOT), {
      type: TYPE_RECTANGLE, x: bx, y, width: bw, height: 32, color: TMA.GOLD_DIM,
    });
    add(base + 1, uid(C.ROOT), {
      type: TYPE_RECTANGLE, x: bx + 1, y: y + 1, width: bw - 2, height: 30,
      color: TMA.BUTTON, flags: FLAG_OP1, op1: "Choose",
    });
    add(base + 2, uid(C.ROOT), {
      type: TYPE_TEXT, x: bx, y: y + 8, width: bw, height: 20,
      text: label, font: FONT_LABEL, color: TMA.BUTTON_TEXT,
      centered: true, shadowed: true,
    });
  });

  add(C.FOOTNOTE, uid(C.ROOT), {
    type: TYPE_TEXT, x: cx - MODAL_W / 2, y: 288, width: MODAL_W, height: 20,
    text: "One stall per trader. The crown takes its due.",
    font: FONT_BODY, color: TMA.MUTED, centered: true, shadowed: true,
  });

  return { groupId: GROUP_ID, widgets, scroll: [] };
}

function buttonIds() {
  return [uid(C.BTN_LEASE_BG), uid(C.BTN_MANAGE_BG), uid(C.BTN_BROWSE_BG)];
}

/** Which kingdom's market is this board in? Inferred from the reader's position. */
function kingdomAt(player) {
  try {
    const pos = player.getLocation?.();
    const x = pos.getX?.() ?? 0;
    const y = pos.getY?.() ?? 0;
    // Market squares (v1): near each capital's trade hub.
    const markets = [
      { id: "asgarnia", x: 2964, y: 3378 },
      { id: "misthalin", x: 3165, y: 3485 },
      { id: "kandarin", x: 2660, y: 3290 },
      { id: "morytania", x: 3495, y: 3235 },
      { id: "keldagrim", x: 2855, y: 10200 },
    ];
    let best = null;
    let bestD = 60; // must be within 60 tiles of a market
    for (const m of markets) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < bestD) {
        bestD = d;
        best = m.id;
      }
    }
    return best;
  } catch {
    return null;
  }
}

function openBoard(player) {
  if (!player || player.isPlayerBot?.() === true) return;
  try {
    player.getPacketSender().sendSubInterface(MODAL_TARGET_UID, GROUP_ID, 0);
  } catch (error) {
    console.warn("[market-board] open failed", error?.message ?? error);
  }
}

function closeBoard(player) {
  try {
    player.getPacketSender()?.closeInterface(GROUP_ID);
  } catch {
    // Already closed.
  }
}

function onBoardButton(event) {
  const { player, button } = event ?? {};
  if (!player || player.isPlayerBot?.() === true) return;
  const api = pluginApi;
  try {
    if (button === uid(C.BTN_LEASE_BG)) {
      closeBoard(player);
      const kingdomId = kingdomAt(player);
      if (!kingdomId) {
        player.sendMessage("This board serves no market I know. Try a capital's trade hub.");
        return;
      }
      PlayerShops.buyStall(api, player, kingdomId);
    } else if (button === uid(C.BTN_MANAGE_BG)) {
      closeBoard(player);
      const stall = PlayerShops.requireStall(player);
      if (stall) PlayerShops.openStall(api, player, stall);
    } else if (button === uid(C.BTN_BROWSE_BG)) {
      closeBoard(player);
      const kingdomId = kingdomAt(player);
      PlayerShops.listStalls(api, player, kingdomId ?? "");
    }
  } catch (error) {
    console.warn("[market-board] button failed", error?.message ?? error);
    player.sendMessage("The board's ink smudges. Try again.");
  }
}

function readBoard({ player }) {
  if (!player || player.isPlayerBot?.() === true) return;
  openBoard(player);
}

function initMarketBoard(api) {
  pluginApi = api;
  api.registerCustomInterface(buildBoardInterface());
  api.onInterfaceActionButton(buttonIds(), onBoardButton);
  api.onObjectInteraction("Market board", { "Read": readBoard });
  console.info("[market-board] diegetic ::shop replacement ready (group 30014)");
}

module.exports = { initMarketBoard };
