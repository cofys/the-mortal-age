"use strict";

/**
 * WarTable — DIEGETIC ::kingdom / ::war / ::alliances replacement (Phase 3).
 *
 * Jon's directive: no ::commands for players. Everything through the world.
 * A "War table" object stands in each capital's war room. Click "Study" and
 * it opens a TMA-styled interface (the Mortal Age UI template from the
 * origin GUI — same palette, typography, frames):
 *
 *   WAR TABLE
 *   YOUR KINGDOM           — name, your rank, your titles (Membership)
 *   THE REALM              — treasury, stockpile, offices, wars (::kingdom status)
 *   OPEN WARS              — attacker vs defender, hottest borders (::war)
 *   ALLIANCES & ROYAL NEWS — pacts and recent royal events (::alliances)
 *
 * The interface reuses the refactored data functions in Commands.Kingdoms
 * (realmStatusLines, warSummary, allianceSummary) and Membership.Kingdoms
 * (membershipLines) — no logic is reimplemented here. The ::kingdom, ::war
 * and ::alliances commands stay registered until the table is verified
 * in-game, then they go. Migration rule: build the world path, verify it
 * works, remove the command. Never the reverse.
 *
 * Group 30015. (30010 citizen stall, 30011 DuelArena, 30012 origin GUI,
 * 30013 player stall, 30014 market board.)
 */

const {
  TYPE_RECTANGLE,
  TYPE_TEXT,
  createWidgetGroup,
} = require("../interface/widgetGroup");
const Commands = require("./Commands.Kingdoms");
const Membership = require("./Membership.Kingdoms");

const GROUP_ID = 30015;
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
};
const FONT_BODY = 494;
const FONT_LABEL = 496;
const FONT_DISPLAY = 497;

const MODAL_W = 620;
const MODAL_H = 460;

const C = {
  ROOT: 0,
  BORDER: 1,
  BG: 2,
  TITLE: 3,
  SUBTITLE: 4,
  TITLE_RULE: 5,
  SEC1_HEAD: 10,
  SEC1_PANEL: 11,
  SEC1_BODY: 12,
  SEC2_HEAD: 20,
  SEC2_PANEL: 21,
  SEC2_BODY: 22,
  SEC3_HEAD: 30,
  SEC3_PANEL: 31,
  SEC3_BODY: 32,
  SEC4_HEAD: 40,
  SEC4_PANEL: 41,
  SEC4_BODY: 42,
  FOOTNOTE: 50,
};
const uid = (component) => (GROUP_ID << 16) | component;

// --- text ------------------------------------------------------------------

/** Latin-1 bitmap fonts choke on em/en dashes; normalise to hyphens. */
function latin1Safe(value) {
  return String(value ?? "").replace(/[—–]/g, "-");
}

/** Greedy word wrap for the bitmap fonts; lines joined with <br>. */
function wrap(text, maxChars) {
  const words = latin1Safe(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.join("<br>");
}

/** Fit a line list into a body slot: wrap, cap, join with <br>. */
function bodyText(lines, maxLines = 4, maxChars = 52) {
  const out = [];
  for (const line of lines) {
    for (const wrapped of wrap(line, maxChars).split("<br>")) {
      if (out.length >= maxLines) break;
      out.push(wrapped);
    }
    if (out.length >= maxLines) break;
  }
  return out.join("<br>");
}

// --- interface definition --------------------------------------------------

function buildTableInterface() {
  const { widgets, add } = createWidgetGroup(GROUP_ID);

  const rect = (component, parent, x, y, w, h, color) =>
    add(component, parent, {
      type: TYPE_RECTANGLE,
      rawX: x, rawY: y, rawWidth: w, rawHeight: h,
      width: w, height: h,
      filled: true, color,
    });

  const label = (component, parent, x, y, w, h, text, fontId, color, center = false) =>
    add(component, parent, {
      type: TYPE_TEXT,
      rawX: x, rawY: y, rawWidth: w, rawHeight: h,
      width: w, height: h,
      text, fontId, textColor: color, textShadowed: true,
      xTextAlignment: center ? 1 : 0,
    });

  // Root: fixed-size centered modal, parented to the modal target.
  const root = add(C.ROOT, -1, {
    rawWidth: MODAL_W, rawHeight: MODAL_H,
    width: MODAL_W, height: MODAL_H,
    xPositionMode: 1, yPositionMode: 1,
  });

  // Double-rule frame: dim-gold border, panel inset by 2.
  rect(C.BORDER, root, 0, 0, MODAL_W, MODAL_H, TMA.GOLD_DIM);
  rect(C.BG, root, 2, 2, MODAL_W - 4, MODAL_H - 4, TMA.PANEL);

  label(C.TITLE, root, 0, 14, MODAL_W, 26, "WAR TABLE", FONT_DISPLAY, TMA.GOLD_TEXT, true);
  label(
    C.SUBTITLE, root, 0, 42, MODAL_W, 16,
    "The realm at a glance, writ on the campaign map.",
    FONT_BODY, TMA.MUTED, true
  );
  rect(C.TITLE_RULE, root, 60, 64, MODAL_W - 120, 1, TMA.GOLD_DIM);

  // Four sections: gold header, inner panel, parchment body.
  const sections = [
    { head: C.SEC1_HEAD, panel: C.SEC1_PANEL, body: C.SEC1_BODY, title: "YOUR KINGDOM", y: 76 },
    { head: C.SEC2_HEAD, panel: C.SEC2_PANEL, body: C.SEC2_BODY, title: "THE REALM", y: 168 },
    { head: C.SEC3_HEAD, panel: C.SEC3_PANEL, body: C.SEC3_BODY, title: "OPEN WARS", y: 260 },
    { head: C.SEC4_HEAD, panel: C.SEC4_PANEL, body: C.SEC4_BODY, title: "ALLIANCES & ROYAL NEWS", y: 352 },
  ];
  for (const s of sections) {
    label(s.head, root, 28, s.y, MODAL_W - 56, 18, s.title, FONT_LABEL, TMA.GOLD_TEXT);
    rect(s.panel, root, 24, s.y + 20, MODAL_W - 48, 64, TMA.PANEL_INNER);
    label(s.body, root, 34, s.y + 24, MODAL_W - 68, 56, "", FONT_BODY, TMA.PARCHMENT);
  }

  label(
    C.FOOTNOTE, root, 0, 441, MODAL_W, 14,
    "Study often — crowns move while you sleep.",
    FONT_BODY, TMA.MUTED, true
  );

  return { groupId: GROUP_ID, widgets };
}

// --- server-driven rendering -----------------------------------------------

function sectionLines(getter, fallback) {
  const lines = getter() ?? [];
  return lines.length > 0 ? lines : [fallback];
}

function render(player) {
  const sender = player.getPacketSender();

  // YOUR KINGDOM: name, rank, titles (from Membership attributes).
  sender.sendString(
    bodyText(sectionLines(() => Membership.membershipLines(player), "You swear fealty to no kingdom.")),
    uid(C.SEC1_BODY)
  );

  // THE REALM: treasury, stockpile, offices, wars (::kingdom status).
  sender.sendString(
    bodyText(sectionLines(() => Commands.realmStatusLines(3), "No kingdoms yet.")),
    uid(C.SEC2_BODY)
  );

  // OPEN WARS: attacker vs defender, hottest borders (::war).
  const { wars, hot } = Commands.warSummary({ maxWars: 2, maxHot: 1, maxLevies: 0 });
  const warLines = [...wars, ...hot];
  sender.sendString(
    bodyText(sectionLines(() => warLines, "No open wars — an uneasy peace.")),
    uid(C.SEC3_BODY)
  );

  // ALLIANCES & ROYAL NEWS: pacts and recent royal events (::alliances).
  const { pacts, news } = Commands.allianceSummary({ maxPacts: 2, maxNews: 1 });
  const allianceLines = [...pacts, ...news];
  sender.sendString(
    bodyText(sectionLines(() => allianceLines, "No pacts sealed — every crown stands alone.")),
    uid(C.SEC4_BODY)
  );
}

function openTable(player) {
  if (!player || player.isPlayerBot?.() === true) return;
  try {
    const sender = player.getPacketSender();
    sender.sendInterfaceRemoval();
    player.setInterfaceId?.(GROUP_ID);
    sender.sendSubInterface(MODAL_TARGET_UID, GROUP_ID, 0);
    render(player);
  } catch (error) {
    console.warn("[war-table] open failed", error?.message ?? error);
  }
}

function studyTable({ player }) {
  openTable(player);
}

module.exports = function attachWarTable(api) {
  api.registerCustomInterface(buildTableInterface());
  api.onObjectInteraction("War table", { "Study": studyTable });
  console.info("[war-table] diegetic ::kingdom/::war/::alliances replacement ready (group 30015)");
};
