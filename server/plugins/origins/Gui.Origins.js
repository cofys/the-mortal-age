"use strict";

/**
 * Gui.Origins — the graphical character-creation screen for The Mortal Age.
 *
 * "Where do you call home?" — the player's first impression of the world, and
 * the seed of the Mortal Age UI template (palette, typography, borders,
 * buttons — documented in DESIGN.md under "The Mortal Age UI template").
 *
 * Implementation: a server-defined custom interface (group 30017) in the
 * established registerCustomInterface pattern (see
 * plugins/interface/Commands.plugin.js). The client fetches the definition
 * from /api/interfaces/30017 on first open; everything after that is the
 * usual socket traffic — clicks arrive as widget button presses
 * (api.onInterfaceActionButton), text/highlights are pushed with sendString /
 * sendInterfaceDisplayState. No client change, no new packets, no new hooks.
 *
 * Design (Jon's mockup, 2026-10-06): a TALL heraldic panel commanding the
 * screen — six realm rows, each with a real thematic item-sprite icon
 * (banner, crown, tree, star, shield, paws), gold-caps name, city + epithet,
 * and a chevron. The selected realm gets a bright gold glowing border and a
 * lit chevron; its full lens paragraph fills a dark inset detail box below.
 * Ornate double-rule gold frame with corner brackets, a compass-star diamond
 * on the top edge, and the claim button as a vow ("I CLAIM ASGARNIA AS MY
 * HOME"). The game world behind is fully covered by a dark backdrop rect —
 * this is the player's screen now, not a dialog over gameplay.
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

const GROUP_ID = 30017;
// NOTE: 30010 is the citizen merchant stall (MerchantShops.js), 30011 the
// player stall (PlayerShops.js), 30014 the market board, 30015 the war table.
// CustomInterfaceRegistry silently lets the last registration win, so every
// custom group ID must be unique — a collision serves one plugin's widgets
// to the other's interface.
// Bumped from 30012 on 2026-10-06: browsers cache /api/interfaces/<id> and
// Jon was seeing stale definitions. New ID forces a fresh fetch.
// Bumped to 30017 for the red-frame diagnostic (2026-10-06).
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
  GOLD_DIM: 0x6b5a3a, // borders, hairline rules — aged bronze
  GOLD: 0xc9a227, // selection glow, bright borders
  GOLD_TEXT: 0xd9b45b, // headings
  PARCHMENT: 0xe8ded0, // body text
  MUTED: 0x9a8f7d, // secondary text (epithets, subtitles, footnotes)
  BUTTON: 0x3a2c1a, // button fill
  BUTTON_HOVER: 0x4a3a22, // button hover
  BUTTON_TEXT: 0xffd27f, // button label
  BACKDROP: 0x0b0805, // fullscreen dim behind the panel — the world goes away
};

// Typography: q8_full (497) is the display face — the "fancy" quest font, the
// mythic register. b12_full (496) for labels, p11_full (494) for body. All
// text shadowed; headings gold, body parchment, secondary muted.
const FONT_BODY = 494;
const FONT_LABEL = 496;

// --- layout ----------------------------------------------------------------
// TALL panel: 440x486 on the 765x503 canvas — ~163px side margins, ~8px
// top/bottom. It commands the screen vertically (Jon's mockup); the dark
// backdrop rect covers the game world behind it, so the small top/bottom
// margins are invisible. Never hardcode interface dimensions to the canvas —
// the full-bleed transparent ROOT centers the PANEL via position modes.

const PANEL_W = 440;
const PANEL_H = 486;

const C = {
  ROOT: 0,
  BACKDROP: 1,
  PANEL: 2,
  FRAME_OUTER: 3,
  FRAME_BG: 4,
  RULE_T: 5,
  RULE_B: 6,
  RULE_L: 7,
  RULE_R: 8,
  // Corner brackets: CORNER_BASE + c*2 (+0 horizontal, +1 vertical), c = 0..3
  // (TL, TR, BL, BR).
  CORNER_BASE: 9,
  // Compass diamond on the top frame edge: COMPASS_BASE + 0 punch rect,
  // +1..+7 the diamond rows, +8 the dark center.
  COMPASS_BASE: 17,
  HEADER: 26,
  HEADER_RULE: 27,
  // Realm rows: ROW_BASE + i * ROW_STRIDE + offset, i = 0..5.
  // Offsets: 0 glow, 1 border, 2 face (clickable), 3 icon, 4 name, 5 sub,
  // 6 chevron (dim), 7 chevron (lit, shown when selected).
  ROW_BASE: 30,
  ROW_STRIDE: 10,
  DETAIL_BORDER: 90,
  DETAIL_BG: 91,
  DETAIL_TITLE: 92,
  DETAIL_TEXT: 93,
  BTN_BORDER: 94,
  BTN_BG: 95,
  BTN_TEXT: 96,
};
const CARD_CLICK_OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7]; // the whole row is one button

// Rows: 34px tall, 2px gaps. Icon 26px, name + city/epithet stacked.
const ROW_X = 34;
const ROW_W = PANEL_W - ROW_X * 2; // 372
const ROW_Y = 66;
const ROW_H = 34;
const ROW_GAP = 2;

// Detail box: dark inset pane with the selected realm's full lens. 152px:
// title line (16) + up to 9 wrapped lines at ~14px/line. The longest lens
// (Misthalin, 452 chars) wraps to 9 lines at 54 chars — measured, not guessed.
const DETAIL_X = 34;
const DETAIL_Y = 290;
const DETAIL_W = PANEL_W - DETAIL_X * 2; // 372
const DETAIL_H = 152;

const BTN_X = 100;
const BTN_Y = 450;
const BTN_W = 240;
const BTN_H = 28;

const uid = (component) => (GROUP_ID << 16) | component;
const CARD_CLICK_UIDS = Data.ORIGINS.flatMap((_, i) =>
  CARD_CLICK_OFFSETS.map((off) => uid(C.ROW_BASE + i * C.ROW_STRIDE + off))
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

function claimLabel(origin) {
  return origin.id === "wanderer" ? "I TAKE TO THE ROAD" : `I CLAIM ${origin.name.toUpperCase()} AS MY HOME`;
}

function detailTitle(origin) {
  return `${origin.name.toUpperCase()} - ${origin.epithet}`;
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

  // ROOT: full-bleed, fills the maximum canvas (765x503) and absorbs viewport
  // differences. The BACKDROP rect covers the game world — this screen owns
  // the player's attention; nothing of the world shows through.
  const root = add(C.ROOT, -1, {
    rawWidth: 765, rawHeight: 503,
    width: 765, height: 503,
    xPositionMode: 1, yPositionMode: 1,
  });
  rect(C.BACKDROP, root, 0, 0, 765, 503, TMA.BACKDROP);

  // The tall panel, centered in the root.
  const panel = add(C.PANEL, root, {
    rawWidth: PANEL_W, rawHeight: PANEL_H,
    width: PANEL_W, height: PANEL_H,
    xPositionMode: 1, yPositionMode: 1,
  });

  // Ornate double-rule frame: dim-gold outer, panel inset 3, bright inner
  // rule at inset 9, corner brackets in bright gold.
  // DIAGNOSTIC: bright red frame to test widget rendering (revert after Jon confirms)
  rect(C.FRAME_OUTER, panel, 0, 0, PANEL_W, PANEL_H, 0xff0000);
  rect(C.FRAME_BG, panel, 3, 3, PANEL_W - 6, PANEL_H - 6, 0xff0000);
  rect(C.RULE_T, panel, 9, 9, PANEL_W - 18, 1, 0xff0000);
  rect(C.RULE_B, panel, 9, PANEL_H - 10, PANEL_W - 18, 1, 0xff0000);
  rect(C.RULE_L, panel, 9, 9, 1, PANEL_H - 18, 0xff0000);
  rect(C.RULE_R, panel, PANEL_W - 10, 9, 1, PANEL_H - 18, 0xff0000);

  // Corner brackets: L-shaped, bright gold, inset 12, 26px arms. The
  // horizontal arm sits at the corner; the vertical arm extends inward.
  const corners = [
    { x: 12, hy: 12, vy: 12 }, // TL
    { x: PANEL_W - 38, hy: 12, vy: 12 }, // TR
    { x: 12, hy: PANEL_H - 15, vy: PANEL_H - 38 }, // BL
    { x: PANEL_W - 38, hy: PANEL_H - 15, vy: PANEL_H - 38 }, // BR
  ];
  corners.forEach(({ x, hy, vy }, c) => {
    const base = C.CORNER_BASE + c * 2;
    const vx = x < PANEL_W / 2 ? x : x + 23; // vertical arm at the outer end
    rect(base, panel, x, hy, 26, 3, 0xff0000);
    rect(base + 1, panel, vx, vy, 3, 26, 0xff0000);
  });

  // Compass star: a gold diamond straddling the top frame edge, centered.
  // Built from stacked rects (the client has no rotated primitives); a dark
  // punch rect behind it so it sits ON the frame, not under it.
  const ccx = PANEL_W / 2;
  rect(C.COMPASS_BASE, panel, ccx - 20, 0, 40, 20, 0xff0000);
  const diamond = [4, 8, 12, 16, 12, 8, 4];
  diamond.forEach((w, k) => {
    rect(C.COMPASS_BASE + 1 + k, panel, ccx - w / 2, 2 + k * 2, w, 2, 0xff0000);
  });
  rect(C.COMPASS_BASE + 8, panel, ccx - 2, 8, 4, 4, 0xff0000);

  // Header: Jon's words, small, centered, atmospheric.
  label(
    C.HEADER, panel, 30, 26, PANEL_W - 60, 28,
    "The gods are silent. The great powers are stirring. Every traveller is asked the same question.",
    FONT_BODY, TMA.MUTED, { center: true }
  );
  rect(C.HEADER_RULE, panel, 70, 60, PANEL_W - 140, 1, TMA.GOLD_DIM);

  // Realm rows. The whole row is one button: every visible part carries the
  // Choose action so whichever widget the client hit-tests, the row answers.
  Data.ORIGINS.forEach((origin, i) => {
    const rx = ROW_X;
    const ry = ROW_Y + i * (ROW_H + ROW_GAP);
    const base = C.ROW_BASE + i * C.ROW_STRIDE;
    const iconId = Items[origin.icon];
    const click = { actions: ["Choose"], flags: FLAG_OP1 };
    const selected = i === 0; // Asgarnia starts selected: the detail box is never empty.

    // Selection signal: bright gold glow behind the row + lit chevron.
    // Hidden until selected, toggled with sendInterfaceDisplayState.
    rect(base, panel, rx - 2, ry - 2, ROW_W + 4, ROW_H + 4, TMA.GOLD,
      { hidden: !selected, isHidden: !selected, actions: ["Choose"], flags: FLAG_OP1 });
    rect(base + 1, panel, rx, ry, ROW_W, ROW_H, TMA.GOLD_DIM, click);
    add(base + 2, panel, {
      rawX: rx + 2, rawY: ry + 2, rawWidth: ROW_W - 4, rawHeight: ROW_H - 4,
      width: ROW_W - 4, height: ROW_H - 4,
      filled: true, color: TMA.CARD, mouseOverColor: TMA.CARD_HOVER,
      ...click,
    });
    // Heraldic icon, name in gold caps, city + epithet beneath, chevron right.
    add(base + 3, panel, {
      type: TYPE_GRAPHIC,
      rawX: rx + 8, rawY: ry + 4, rawWidth: 26, rawHeight: 26,
      width: 26, height: 26,
      itemId: iconId, itemQuantity: 1,
      ...click,
    });
    label(base + 4, panel, rx + 42, ry + 2, 240, 15, origin.name.toUpperCase(), FONT_LABEL, TMA.GOLD_TEXT, click);
    label(base + 5, panel, rx + 42, ry + 18, 300, 13, `${origin.city} - ${origin.epithet}`, FONT_BODY, TMA.MUTED, click);
    label(base + 6, panel, rx + ROW_W - 28, ry + 7, 20, 20, ">", FONT_LABEL, TMA.GOLD_DIM, { center: true, vcenter: true, ...click });
    label(base + 7, panel, rx + ROW_W - 28, ry + 7, 20, 20, ">", FONT_LABEL, TMA.GOLD,
      { center: true, vcenter: true, hidden: !selected, isHidden: !selected, ...click });
  });

  // Detail box: dark inset pane with the selected realm's full lens —
  // title line, then the whole paragraph, breathing room, no clipping.
  rect(C.DETAIL_BORDER, panel, DETAIL_X, DETAIL_Y, DETAIL_W, DETAIL_H, TMA.GOLD_DIM);
  rect(C.DETAIL_BG, panel, DETAIL_X + 2, DETAIL_Y + 2, DETAIL_W - 4, DETAIL_H - 4, TMA.PANEL_INNER);
  label(C.DETAIL_TITLE, panel, DETAIL_X + 10, DETAIL_Y + 8, DETAIL_W - 20, 16, "", FONT_LABEL, TMA.GOLD_TEXT, { center: true });
  label(C.DETAIL_TEXT, panel, DETAIL_X + 10, DETAIL_Y + 28, DETAIL_W - 20, DETAIL_H - 36, "", FONT_BODY, TMA.PARCHMENT);

  // The vow: a claim button that reads like an oath, not a form submit.
  rect(C.BTN_BORDER, panel, BTN_X, BTN_Y, BTN_W, BTN_H, TMA.GOLD);
  add(C.BTN_BG, panel, {
    rawX: BTN_X + 2, rawY: BTN_Y + 2, rawWidth: BTN_W - 4, rawHeight: BTN_H - 4,
    width: BTN_W - 4, height: BTN_H - 4,
    filled: true, color: TMA.BUTTON, mouseOverColor: TMA.BUTTON_HOVER,
    actions: ["Claim"], flags: FLAG_OP1,
  });
  label(C.BTN_TEXT, panel, BTN_X + 2, BTN_Y + 2, BTN_W - 4, BTN_H - 4, "", FONT_LABEL, TMA.BUTTON_TEXT,
    { center: true, vcenter: true, actions: ["Claim"], flags: FLAG_OP1 });

  return { groupId: GROUP_ID, widgets };
}

// --- server-driven rendering -------------------------------------------------

/** Push the selection state to the client: glow, chevron, detail, vow label. */
function renderSelection(player, originId) {
  const sender = player.getPacketSender();
  Data.ORIGINS.forEach((origin, i) => {
    const base = C.ROW_BASE + i * C.ROW_STRIDE;
    const selected = origin.id === originId;
    sender.sendInterfaceDisplayState(uid(base), !selected); // gold glow
    sender.sendInterfaceDisplayState(uid(base + 7), !selected); // lit chevron
  });
  const origin = Data.BY_ID.get(originId);
  if (!origin) return;
  sender.sendString(latin1Safe(detailTitle(origin)), uid(C.DETAIL_TITLE));
  sender.sendString(wrap(origin.lens, 54), uid(C.DETAIL_TEXT));
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
  const rel = ((buttonId | 0) & 0xffff) - C.ROW_BASE;
  const index = Math.floor(rel / C.ROW_STRIDE);
  const offset = rel % C.ROW_STRIDE;
  if (index < 0 || index >= Data.ORIGINS.length || offset < 0 || offset > 7) return;
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
