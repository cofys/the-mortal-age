"use strict";

/**
 * Gui.Origins — the graphical character-creation screen for The Mortal Age.
 *
 * "Where do you call home?" — the player's first impression of the world, and
 * the seed of the Mortal Age UI template (palette, typography, borders,
 * buttons — documented in DESIGN.md under "The Mortal Age UI template").
 *
 * Implementation: a server-defined custom interface (group 30012) in the
 * established registerCustomInterface pattern (see
 * plugins/interface/Commands.plugin.js). The client fetches the definition
 * from /api/interfaces/30012 on first open; everything after that is the
 * usual socket traffic — clicks arrive as widget button presses
 * (api.onInterfaceActionButton), text/highlights are pushed with sendString /
 * sendInterfaceDisplayState. No client change, no new packets, no new hooks.
 *
 * Ceremony: the existing appearance customizer (interface 679) still runs
 * first for new accounts; Selection.Origins opens this screen when 679
 * closes, from the welcome-screen Play button for existing players without a
 * home, and from ::origin. Claiming goes through Selection.claimOrigin, so
 * attributes, kingdom, kit, spawn and the origins:selected event are unchanged.
 *
 * The chatbox flow (Selection.openChatboxChoice) stays the fallback: mobile
 * clients keep it, and dismissing this screen without choosing falls back to
 * it, until the GUI is verified in-game.
 */

const {
  FLAG_OP1,
  TYPE_RECTANGLE,
  TYPE_TEXT,
  TYPE_GRAPHIC,
  createWidgetGroup,
} = require("../interface/widgetGroup");
const Data = require("./Data.Origins");
const Selection = require("./Selection.Origins");

const GROUP_ID = 30012;
// NOTE: 30010 is the citizen merchant stall (MerchantShops.js), 30011 the
// player stall (PlayerShops.js). CustomInterfaceRegistry silently lets the
// last registration win, so every custom group ID must be unique — a
// collision serves one plugin's widgets to the other's interface.
// The main modal layer, same target the makeover mage and ::commands use.
const MODAL_TARGET_UID = (161 << 16) | 16;

// --- The Mortal Age UI template: palette -----------------------------------
// Somber, mythic, grounded. Warm near-blacks, dim bronze-gold, parchment text.
// Depth comes from nested panels (void -> panel -> inner -> card), never from
// drop shadows; canvas widgets are flat fills, so layering IS the texture.
const TMA = {
  PANEL: 0x14100b, // panel background
  PANEL_INNER: 0x1e1812, // inset panels (detail pane)
  CARD: 0x241c13, // realm card background
  CARD_HOVER: 0x2e2417, // realm card hover
  GOLD_DIM: 0x6b5a3a, // borders, hairline rules
  GOLD: 0xc9a227, // selection glow, bright borders
  GOLD_TEXT: 0xd9b45b, // headings
  PARCHMENT: 0xe8ded0, // body text
  MUTED: 0x9a8f7d, // secondary text
  BUTTON: 0x3a2c1a, // button fill
  BUTTON_HOVER: 0x4a3a22, // button hover
  BUTTON_TEXT: 0xffd27f, // button label
};

// Typography: q8_full (497) is the display face — the "fancy" quest font, the
// mythic register. b12_full (496) for labels, p11_full (494) for body. All
// text shadowed; headings gold, body parchment, secondary muted.
const FONT_BODY = 494;
const FONT_LABEL = 496;
const FONT_DISPLAY = 497;

// --- layout ----------------------------------------------------------------
const MODAL_W = 700;
const MODAL_H = 460;

const C = {
  ROOT: 0,
  BORDER: 1,
  BG: 2,
  TITLE: 3,
  SUBTITLE: 4,
  TITLE_RULE: 5,
  // Realm cards: CARD_BASE + i * CARD_STRIDE + offset, i = 0..5.
  // Offsets: 0 highlight, 1 border, 2 face (clickable), 3 icon, 4 name, 5 city, 6 epithet.
  CARD_BASE: 10,
  CARD_STRIDE: 10,
  DETAIL_BORDER: 70,
  DETAIL_BG: 71,
  DETAIL_NAME: 72,
  DETAIL_SUB: 73,
  DETAIL_RULE: 74,
  DETAIL_LENS: 75,
  DETAIL_KINGDOM: 76,
  BTN_BORDER: 80,
  BTN_BG: 81,
  BTN_TEXT: 82,
  FOOTNOTE: 83,
};
const CARD_FACE_OFFSETS = [0, 1, 2, 3, 4, 5, 6]; // every visible card part is clickable

const CARD_W = 138;
const CARD_H = 132;
const GRID_X = 24;
const GRID_Y = 84;
const COL_GAP = 8;
const ROW_GAP = 8;

const DETAIL_X = 466;
const DETAIL_Y = 84;
const DETAIL_W = 210;
const DETAIL_H = 272;

const BTN_X = 210;
const BTN_Y = 376;
const BTN_W = 280;
const BTN_H = 36;

const uid = (component) => (GROUP_ID << 16) | component;
const CARD_CLICK_UIDS = Data.ORIGINS.flatMap((_, i) =>
  CARD_FACE_OFFSETS.map((off) => uid(C.CARD_BASE + i * C.CARD_STRIDE + off))
);
const CLAIM_UIDS = [uid(C.BTN_BG), uid(C.BTN_TEXT)];

/** Players with the creation screen open right now. */
const openPlayers = new Set();
/** Per-player selected origin id (transient; the claim persists origin:id). */
const selectedByPlayer = new Map();

function noteClosed({ player }) {
  openPlayers.delete(player);
  selectedByPlayer.delete(player);
}

function isOpen(player) {
  return openPlayers.has(player);
}

// --- text ------------------------------------------------------------------
// Widget strings travel as latin1: normalize anything outside it (the lens
// copy uses em dashes) so the screen reads cleanly instead of showing "?".
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

function capitalize(value) {
  const s = String(value ?? "");
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function claimLabel(origin) {
  return origin.id === "wanderer" ? "TAKE TO THE ROAD" : `CLAIM ${origin.name.toUpperCase()} AS MY HOME`;
}

function fealtyLine(origin) {
  return origin.kingdomId ? `Sworn to ${capitalize(origin.kingdomId)}` : "You answer to no crown.";
}

// --- interface definition ---------------------------------------------------

function buildInterface(Items) {
  const { widgets, add } = createWidgetGroup(GROUP_ID);

  const rect = (component, parent, x, y, w, h, color, extra = {}) =>
    add(component, parent, {
      type: TYPE_RECTANGLE,
      rawX: x, rawY: y, rawWidth: w, rawHeight: h,
      width: w, height: h,
      filled: true, color,
      ...extra,
    });

  const label = (component, parent, x, y, w, h, text, fontId, color, { center = false, vcenter = false, ...widgetExtra } = {}) =>
    add(component, parent, {
      type: TYPE_TEXT,
      rawX: x, rawY: y, rawWidth: w, rawHeight: h,
      width: w, height: h,
      text, fontId, textColor: color, textShadowed: true,
      xTextAlignment: center ? 1 : 0,
      yTextAlignment: vcenter ? 1 : 0,
      ...widgetExtra,
    });

  // Fixed-size centered modal (700x460 on the 765x503 canvas). widthMode 0
  // means "rawWidth is the width" — widthMode 1 would size this as
  // parent-minus-raw, which is for fill containers, not fixed modals.
  const root = add(C.ROOT, -1, {
    rawWidth: MODAL_W, rawHeight: MODAL_H,
    width: MODAL_W, height: MODAL_H,
    xPositionMode: 1, yPositionMode: 1,
  });

  // Double-rule frame: dim-gold border, panel inset by 2.
  rect(C.BORDER, root, 0, 0, MODAL_W, MODAL_H, TMA.GOLD_DIM);
  rect(C.BG, root, 2, 2, MODAL_W - 4, MODAL_H - 4, TMA.PANEL);

  label(C.TITLE, root, 0, 14, MODAL_W, 26, "WHERE DO YOU CALL HOME?", FONT_DISPLAY, TMA.GOLD_TEXT, { center: true });
  label(
    C.SUBTITLE, root, 0, 42, MODAL_W, 16,
    "The gods are silent. The great powers are stirring. Every traveller is asked the same question.",
    FONT_BODY, TMA.MUTED, { center: true }
  );
  rect(C.TITLE_RULE, root, 60, 64, MODAL_W - 120, 1, TMA.GOLD_DIM);

  // Realm cards, 3 x 2. Every visible part of a card is clickable so the
  // whole card feels like one button whichever widget the client hit-tests.
  Data.ORIGINS.forEach((origin, i) => {
    const col = i % 3;
    const row = (i / 3) | 0;
    const cx = GRID_X + col * (CARD_W + COL_GAP);
    const cy = GRID_Y + row * (CARD_H + ROW_GAP);
    const base = C.CARD_BASE + i * C.CARD_STRIDE;
    const iconId = Items[origin.icon];
    const click = { actions: ["Choose"], flags: FLAG_OP1 };

    // Selection glow (hidden until selected) sits behind the card.
    // Asgarnia (i === 0) starts selected so the detail pane is populated on open.
    const glowHidden = i !== 0;
    rect(base, root, cx - 2, cy - 2, CARD_W + 4, CARD_H + 4, TMA.GOLD,
      { hidden: glowHidden, isHidden: glowHidden, actions: ["Choose"], flags: FLAG_OP1 });
    rect(base + 1, root, cx, cy, CARD_W, CARD_H, TMA.GOLD_DIM, { actions: ["Choose"], flags: FLAG_OP1 });
    add(base + 2, root, {
      rawX: cx + 2, rawY: cy + 2, rawWidth: CARD_W - 4, rawHeight: CARD_H - 4,
      width: CARD_W - 4, height: CARD_H - 4,
      filled: true, color: TMA.CARD, mouseOverColor: TMA.CARD_HOVER,
      ...click,
    });
    add(base + 3, root, {
      type: TYPE_GRAPHIC,
      rawX: cx + 2 + (CARD_W - 4 - 32) / 2, rawY: cy + 10, rawWidth: 32, rawHeight: 32,
      width: 32, height: 32,
      itemId: iconId, itemQuantity: 1,
      ...click,
    });
    label(base + 4, root, cx + 2, cy + 48, CARD_W - 4, 16, origin.name.toUpperCase(), FONT_LABEL, TMA.GOLD_TEXT, { center: true, ...click });
    label(base + 5, root, cx + 2, cy + 66, CARD_W - 4, 14, origin.city, FONT_BODY, TMA.PARCHMENT, { center: true, ...click });
    label(base + 6, root, cx + 2, cy + 82, CARD_W - 4, 14, origin.epithet, FONT_BODY, TMA.MUTED, { center: true, ...click });
  });

  // Detail pane: the selected origin's lens.
  rect(C.DETAIL_BORDER, root, DETAIL_X, DETAIL_Y, DETAIL_W, DETAIL_H, TMA.GOLD_DIM);
  rect(C.DETAIL_BG, root, DETAIL_X + 2, DETAIL_Y + 2, DETAIL_W - 4, DETAIL_H - 4, TMA.PANEL_INNER);
  label(C.DETAIL_NAME, root, DETAIL_X + 10, DETAIL_Y + 12, DETAIL_W - 20, 18, "", FONT_LABEL, TMA.GOLD_TEXT, { center: true });
  label(C.DETAIL_SUB, root, DETAIL_X + 10, DETAIL_Y + 32, DETAIL_W - 20, 14, "", FONT_BODY, TMA.MUTED, { center: true });
  rect(C.DETAIL_RULE, root, DETAIL_X + 20, DETAIL_Y + 50, DETAIL_W - 40, 1, TMA.GOLD_DIM);
  label(C.DETAIL_LENS, root, DETAIL_X + 12, DETAIL_Y + 58, DETAIL_W - 24, 190, "", FONT_BODY, TMA.PARCHMENT);
  label(C.DETAIL_KINGDOM, root, DETAIL_X + 10, DETAIL_Y + 252, DETAIL_W - 20, 16, "", FONT_BODY, TMA.BUTTON_TEXT, { center: true });

  // Claim button.
  rect(C.BTN_BORDER, root, BTN_X, BTN_Y, BTN_W, BTN_H, TMA.GOLD);
  add(C.BTN_BG, root, {
    rawX: BTN_X + 2, rawY: BTN_Y + 2, rawWidth: BTN_W - 4, rawHeight: BTN_H - 4,
    width: BTN_W - 4, height: BTN_H - 4,
    filled: true, color: TMA.BUTTON, mouseOverColor: TMA.BUTTON_HOVER,
    actions: ["Claim"], flags: FLAG_OP1,
  });
  label(C.BTN_TEXT, root, BTN_X + 2, BTN_Y + 2, BTN_W - 4, BTN_H - 4, "", FONT_LABEL, TMA.BUTTON_TEXT,
    { center: true, vcenter: true, actions: ["Claim"], flags: FLAG_OP1 });

  label(
    C.FOOTNOTE, root, 0, 420, MODAL_W, 14,
    "Your home sets your starting city, your kit, and the crown you answer to.",
    FONT_BODY, TMA.MUTED, { center: true }
  );

  return { groupId: GROUP_ID, widgets };
}

// --- server-driven rendering -------------------------------------------------

/** Push the selection state to the client: glow, lens, claim label. */
function renderSelection(player, originId) {
  const sender = player.getPacketSender();
  Data.ORIGINS.forEach((origin, i) => {
    sender.sendInterfaceDisplayState(uid(C.CARD_BASE + i * C.CARD_STRIDE), origin.id !== originId);
  });
  const origin = Data.BY_ID.get(originId);
  if (!origin) return;
  sender.sendString(latin1Safe(origin.name.toUpperCase()), uid(C.DETAIL_NAME));
  sender.sendString(latin1Safe(`${origin.demonym} · ${origin.city}`), uid(C.DETAIL_SUB));
  sender.sendString(wrap(origin.lens, 33), uid(C.DETAIL_LENS));
  sender.sendString(latin1Safe(fealtyLine(origin)), uid(C.DETAIL_KINGDOM));
  sender.sendString(latin1Safe(claimLabel(origin)), uid(C.BTN_TEXT));
}

function selectOrigin(player, originId) {
  if (!openPlayers.has(player) || Selection.hasOrigin(player)) return;
  if (!Data.BY_ID.has(originId)) return;
  selectedByPlayer.set(player, originId);
  renderSelection(player, originId);
}

/**
 * Open the creation screen. Returns true when the screen is (now) open;
 * false when it could not be opened (caller falls back to the chatbox flow).
 * Idempotent: opening twice for the same player is a no-op success, which
 * also makes the interface:closed re-entrancy from sendInterfaceRemoval safe.
 */
function open(player) {
  if (!player || typeof player.getPacketSender !== "function") return false;
  if (Selection.hasOrigin(player)) return false;
  if (openPlayers.has(player)) return true;
  openPlayers.add(player);
  try {
    const sender = player.getPacketSender();
    sender.sendInterfaceRemoval();
    player.setInterfaceId?.(GROUP_ID);
    sender.sendSubInterface(MODAL_TARGET_UID, GROUP_ID, 0);
    const first = Data.ORIGINS[0].id;
    selectedByPlayer.set(player, first);
    // The definition fetch on first open holds these until the widgets exist.
    renderSelection(player, first);
    return true;
  } catch (err) {
    openPlayers.delete(player);
    selectedByPlayer.delete(player);
    console.warn(`[origins] creation GUI open failed: ${err?.message ?? err}`);
    return false;
  }
}

// --- clicks ------------------------------------------------------------------

function onCardClick({ player, buttonId }) {
  if (!player || !openPlayers.has(player) || Selection.hasOrigin(player)) return;
  const rel = ((buttonId | 0) & 0xffff) - C.CARD_BASE;
  const index = Math.floor(rel / C.CARD_STRIDE);
  const offset = rel % C.CARD_STRIDE;
  if (index < 0 || index >= Data.ORIGINS.length || offset < 0 || offset > 6) return;
  selectOrigin(player, Data.ORIGINS[index].id);
}

function onClaimClick({ player }) {
  if (!player || !openPlayers.has(player) || Selection.hasOrigin(player)) return;
  const originId = selectedByPlayer.get(player) ?? Data.ORIGINS[0].id;
  if (!Data.BY_ID.has(originId)) return;
  // Clear first: claimOrigin closes the interface, which emits
  // interface:closed — by then we must not look "still open".
  noteClosed({ player });
  Selection.claimOrigin(player, originId);
}

function attach(api) {
  const Items = api.core.ItemIdentifiers;
  Data.validateItemKeys(Items);
  api.registerCustomInterface(buildInterface(Items));
  api.onInterfaceActionButton(CARD_CLICK_UIDS, onCardClick);
  api.onInterfaceActionButton(CLAIM_UIDS, onClaimClick);
  api.onPlayerLogout(noteClosed);
  api.onPlayerDisconnect(noteClosed);
}

module.exports = {
  attach,
  open,
  isOpen,
  noteClosed,
  GROUP_ID,
  hooks: () => ({ open, isOpen, noteClosed, groupId: GROUP_ID }),
};
