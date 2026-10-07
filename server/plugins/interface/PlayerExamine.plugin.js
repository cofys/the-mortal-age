/**
 * PlayerExamine — Mortal Age character sheet.
 *
 * Right-click "Examine" on another player opens a panel showing who they ARE,
 * not just their levels:
 *   - Name (display name from character creation)
 *   - Background + origin ("Fisher of Keldagrim")
 *   - Character description (RP flavor text, set via ::desc)
 *   - Reputation per kingdom (from kingdom:influence), tier-colored
 *   - Deeds (completed quests)
 *   - Allegiance (guild membership and rank)
 *   - Notable skills (top 5)
 *
 * Styled on the TMA UI template (war table palette): dark bronze panels,
 * double-rule gold frame, gold section headers, parchment body text.
 *
 * Player option slot 8 is used for "Examine"
 * (1 attack, 2 trade req, 3 follow, 4 duel, 5 recruit, 6 forfeit, 7 trade).
 *
 * Attributes (kebab-case, namespaced per AGENTS.md):
 *   examine:description — player-set RP flavor text
 */

const { FLAG_OP1, TYPE_RECTANGLE, TYPE_TEXT, createWidgetGroup } = require("./widgetGroup");

const GROUP_ID = 30010;
const EXAMINE_OPTION_SLOT = 8;
const MAIN_MODAL_UID = (161 << 16) | 16;

const DESCRIPTION_ATTRIBUTE = "examine:description";
const INFLUENCE_ATTRIBUTE = "kingdom:influence";
const DISPLAY_NAME_ATTRIBUTE = "character:display-name";
const BACKGROUND_ID_ATTRIBUTE = "background:id";
const ORIGIN_ID_ATTRIBUTE = "origin:id";

// --- TMA UI template (from WarTable.Kingdoms.js) -----------------------------
const TMA = {
  PANEL: 0x14100b,
  PANEL_INNER: 0x1e1812,
  GOLD_DIM: 0x6b5a3a,
  GOLD_TEXT: 0xd9b45b,
  PARCHMENT: 0xe8ded0,
  MUTED: 0x9a8f7d,
};
const FONT_BODY = 494;
const FONT_LABEL = 496;
const FONT_DISPLAY = 497;

const MODAL_W = 560;
const MODAL_H = 580;

const COMPONENT = {
  ROOT: 0,
  BORDER: 1,
  BG: 2,
  TITLE: 3,
  SUBTITLE: 4,
  SUBSUB: 5,
  TITLE_RULE: 6,
  // Section chrome: header label, inner panel, body text
  PERSON_HEAD: 10,
  PERSON_PANEL: 11,
  DESCRIPTION: 12,
  REP_HEAD: 20,
  REP_PANEL: 21,
  REPUTATION: 22,
  DEEDS_HEAD: 30,
  DEEDS_PANEL: 31,
  ACCOMPLISHMENTS: 32,
  GUILD_HEAD: 40,
  GUILD_PANEL: 41,
  GUILD: 42,
  SKILLS_HEAD: 50,
  SKILLS_PANEL: 51,
  SKILLS: 52,
  CLOSE_BUTTON: 60,
  CLOSE_TEXT: 61,
  FOOTNOTE: 62,
  // Kept for the test seam / backward compat with old layout keys
  FRAME: 63,
};

const uid = (component) => (GROUP_ID << 16) | component;

let pluginApi = null;

/** Latin-1 bitmap fonts choke on em/en dashes; normalise to hyphens. */
function latin1Safe(value) {
  return String(value ?? "").replace(/[—–]/g, "-");
}

/** Wrap text to fit within a max line length. */
function wrapText(text, maxLen = 62) {
  if (!text) return "";
  const words = latin1Safe(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxLen && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function buildInterface() {
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

  // Root: fixed-size centered modal.
  const root = add(COMPONENT.ROOT, -1, {
    rawWidth: MODAL_W, rawHeight: MODAL_H,
    width: MODAL_W, height: MODAL_H,
    xPositionMode: 1, yPositionMode: 1,
  });

  // Double-rule frame: dim-gold border, dark panel inset by 2.
  rect(COMPONENT.BORDER, root, 0, 0, MODAL_W, MODAL_H, TMA.GOLD_DIM);
  rect(COMPONENT.BG, root, 2, 2, MODAL_W - 4, MODAL_H - 4, TMA.PANEL);

  // Title block.
  label(COMPONENT.TITLE, root, 0, 12, MODAL_W, 26, "CHARACTER SHEET", FONT_DISPLAY, TMA.GOLD_TEXT, true);
  label(COMPONENT.SUBTITLE, root, 0, 40, MODAL_W, 20, "", FONT_LABEL, TMA.GOLD_TEXT, true);
  label(COMPONENT.SUBSUB, root, 0, 60, MODAL_W, 14, "", FONT_BODY, TMA.MUTED, true);
  rect(COMPONENT.TITLE_RULE, root, 60, 80, MODAL_W - 120, 1, TMA.GOLD_DIM);

  // Sections: gold header, inner panel, parchment body. Body rows ~14px.
  const sections = [
    { head: COMPONENT.PERSON_HEAD, panel: COMPONENT.PERSON_PANEL, body: COMPONENT.DESCRIPTION,
      title: "THE PERSON", x: 24, w: 512, y: 88, rows: 6 },
    { head: COMPONENT.REP_HEAD, panel: COMPONENT.REP_PANEL, body: COMPONENT.REPUTATION,
      title: "REPUTATION", x: 24, w: 512, y: 200, rows: 5 },
    { head: COMPONENT.DEEDS_HEAD, panel: COMPONENT.DEEDS_PANEL, body: COMPONENT.ACCOMPLISHMENTS,
      title: "DEEDS & HONOURS", x: 24, w: 512, y: 306, rows: 5 },
    { head: COMPONENT.GUILD_HEAD, panel: COMPONENT.GUILD_PANEL, body: COMPONENT.GUILD,
      title: "ALLEGIANCE", x: 24, w: 248, y: 412, rows: 3 },
    { head: COMPONENT.SKILLS_HEAD, panel: COMPONENT.SKILLS_PANEL, body: COMPONENT.SKILLS,
      title: "NOTABLE SKILLS", x: 288, w: 248, y: 412, rows: 3 },
  ];
  for (const s of sections) {
    const panelH = s.rows * 14 + 8;
    const bodyH = s.rows * 14;
    label(s.head, root, s.x + 4, s.y, s.w - 8, 18, s.title, FONT_LABEL, TMA.GOLD_TEXT);
    rect(s.panel, root, s.x, s.y + 20, s.w, panelH, TMA.PANEL_INNER);
    label(s.body, root, s.x + 10, s.y + 24, s.w - 20, bodyH, "", FONT_BODY, TMA.PARCHMENT);
  }

  // Close button.
  const btnX = Math.floor((MODAL_W - 110) / 2);
  add(COMPONENT.CLOSE_BUTTON, root, {
    type: TYPE_RECTANGLE, rawX: btnX, rawY: 508, rawWidth: 110, rawHeight: 28,
    width: 110, height: 28, filled: true, color: 0x2b241b, mouseOverColor: 0x3a3125,
    actions: ["Close"], flags: FLAG_OP1,
  });
  label(COMPONENT.CLOSE_TEXT, root, btnX, 508, 110, 28, "Close", FONT_BODY, TMA.PARCHMENT, true);

  label(
    COMPONENT.FOOTNOTE, root, 0, 544, MODAL_W, 14,
    "Every life is a full game.", FONT_BODY, TMA.MUTED, true
  );

  return { groupId: GROUP_ID, widgets };
}

// --- data -------------------------------------------------------------------

const KINGDOM_NAMES = {
  misthalin: "Misthalin",
  asgarnia: "Asgarnia",
  kandarin: "Kandarin",
  morytania: "Morytania",
  keldagrim: "Keldagrim",
  wanderer: "Wanderer",
};

function kingdomName(id) {
  return KINGDOM_NAMES[String(id).toLowerCase()] || String(id);
}

function getDisplayName(player) {
  try {
    const dn = player.getAttribute(DISPLAY_NAME_ATTRIBUTE);
    if (dn && String(dn).trim()) return latin1Safe(dn);
  } catch {
    // fall through
  }
  return player.getUsername?.() || "Unknown";
}

function getByline(player) {
  const bits = [];
  try {
    const bgId = player.getAttribute(BACKGROUND_ID_ATTRIBUTE);
    if (bgId) {
      const { BY_ID } = require("../origins/Data.Backgrounds");
      const bg = BY_ID.get(bgId);
      if (bg?.name) bits.push(latin1Safe(bg.name));
    }
  } catch {
    // no background
  }
  try {
    const originId = player.getAttribute(ORIGIN_ID_ATTRIBUTE);
    if (originId) {
      const { BY_ID } = require("../origins/Data.Origins");
      const origin = BY_ID.get(originId);
      if (origin?.name) bits.push(`of ${latin1Safe(origin.name)}`);
    }
  } catch {
    // no origin
  }
  return bits.join(" ");
}

function getDescription(player) {
  let desc = null;
  try {
    desc = player.getAttribute(DESCRIPTION_ATTRIBUTE);
  } catch {
    desc = null;
  }
  if (desc && String(desc).trim()) {
    return wrapText(desc, 62).slice(0, 6).join("<br>");
  }
  return "<col=9a8f7d><i>No description set. Use ::desc to tell your story.</i></col>";
}

const TIER_COLORS = {
  Revered: "d9b45b",
  Respected: "c9a86a",
  Known: "e8ded0",
  Noticed: "9a8f7d",
  Neutral: "9a8f7d",
};

function tierFor(points) {
  if (points >= 50) return "Revered";
  if (points >= 25) return "Respected";
  if (points >= 10) return "Known";
  if (points > 0) return "Noticed";
  return "Neutral";
}

function getReputation(player) {
  let influence = {};
  try {
    influence = player.getAttribute(INFLUENCE_ATTRIBUTE) || {};
  } catch {
    influence = {};
  }
  const entries = Object.entries(influence);
  if (entries.length === 0) {
    return "<col=9a8f7d><i>No standing yet - serve a kingdom to earn a name.</i></col>";
  }
  return entries
    .slice(0, 5)
    .map(([kingdomId, data]) => {
      const points = Math.round(data?.points || 0);
      const tier = tierFor(points);
      const color = TIER_COLORS[tier];
      return `${kingdomName(kingdomId)}: <col=${color}>${tier}</col> <col=9a8f7d>(${points})</col>`;
    })
    .join("<br>");
}

function getAccomplishments(player) {
  const completed = [];
  try {
    const QuestState = require("../quests/mortal/QuestState");
    const Data = require("../quests/mortal/Data.QuestRegistry");
    for (const quest of Data.ALL_QUESTS || []) {
      if (QuestState.isComplete(player, quest.id)) {
        completed.push(latin1Safe(quest.name || quest.id));
      }
    }
  } catch {
    // Quest system not available
  }
  if (completed.length === 0) {
    return "<col=9a8f7d><i>No deeds yet. The realm is waiting.</i></col>";
  }
  const lines = completed.slice(0, 5).map((q) => `<col=d9b45b>-</col> ${q}`);
  if (completed.length > 5) {
    lines.push(`<col=9a8f7d><i>+${completed.length - 5} more</i></col>`);
  }
  return lines.join("<br>");
}

function getGuildInfo(player) {
  try {
    const Registry = require("../guilds/GuildRegistry");
    const username = player.getUsername();
    const guild = Registry.memberGuild(username);
    if (!guild) {
      return "<col=9a8f7d><i>Sworn to none - a free agent.</i></col>";
    }
    const rank = Registry.memberRank(guild, username) || "Member";
    return `${latin1Safe(guild.name)}<br><col=9a8f7d>${latin1Safe(rank)}</col>`;
  } catch {
    return "<col=9a8f7d><i>Sworn to none - a free agent.</i></col>";
  }
}

function getTopSkills(player) {
  try {
    const Skill = pluginApi.core.Skill;
    const manager = player.getSkillManager();
    const skills = [];
    for (const skill of Skill.values()) {
      try {
        const level = manager.getCurrentLevel(skill);
        if (typeof level === "number" && level > 1) {
          const name = skill.getName?.() || "Unknown";
          skills.push({ name, level });
        }
      } catch {
        // Skip skills that fail
      }
    }
    skills.sort((a, b) => b.level - a.level);
    const top = skills.slice(0, 3);
    if (top.length === 0) {
      return "<col=9a8f7d><i>No notable skills yet.</i></col>";
    }
    return top.map((s) => `${latin1Safe(s.name)} <col=d9b45b>${s.level}</col>`).join("<br>");
  } catch {
    return "<col=9a8f7d><i>No notable skills yet.</i></col>";
  }
}

const EXAMINE_OPEN_ATTRIBUTE = "examine:open";

function openExamine({ player, target }) {
  if (!player || !target) return;
  // The React examine overlay renders from this flag (see ExamineApi).
  // The engine widget stays registered as a fallback, but no longer opens.
  try {
    player.setAttribute(EXAMINE_OPEN_ATTRIBUTE, target.getUsername());
  } catch (error) {
    console.warn("[examine] open failed", error?.message ?? error);
  }
}

function closeExamine({ player }) {
  player.getPacketSender().closeInterfaces?.();
  // Fallback: send main gameframe if closeInterfaces not available
  try {
    player.getPacketSender().sendCloseInterface?.();
  } catch {
    // Interface will close on next action
  }
}

function handlePlayerOption(event) {
  const { player, target, option } = event;
  if (option !== EXAMINE_OPTION_SLOT) return;
  if (!target || target === player) return;
  // Don't examine bots via this panel (they have their own interactions)
  event.handled = true;
  openExamine({ player, target });
}

function syncExamineOption({ player }) {
  if (player?.isPlayerBot?.() === true) return;
  const sender = player?.getPacketSender?.();
  if (!sender) return;
  sender.sendPlayerOption(EXAMINE_OPTION_SLOT, "Examine", false);
}

function setDescription({ player, parts }) {
  const text = parts.slice(1).join(" ").trim();
  if (!text) {
    const current = player.getAttribute(DESCRIPTION_ATTRIBUTE);
    player.getPacketSender().sendMessage(
      current
        ? `Your current description: "${current}"`
        : "You have no description set. Use ::desc <text> to set one."
    );
    return true;
  }
  if (text.length > 200) {
    player.getPacketSender().sendMessage("Description too long — keep it under 200 characters.");
    return true;
  }
  player.setAttribute(DESCRIPTION_ATTRIBUTE, text);
  player.getPacketSender().sendMessage("Your character description has been updated.");
  return true;
}

const examinedPlayers = new WeakSet();

function onLoginSyncOption({ player }) {
  if (examinedPlayers.has(player)) return;
  syncExamineOption({ player });
  examinedPlayers.add(player);
}

function onCloseButton({ player }) {
  closeExamine({ player });
}

function attachPlugin(api) {
  pluginApi = api;
  api.registerCustomInterface(buildInterface());
  // Web overlay data layer (see ExamineApi.js).
  require("./ExamineApi").attach(api);
  api.registerCommand("desc", setDescription, undefined, "Set your character description (::desc <text>)");
  api.persistAttribute(DESCRIPTION_ATTRIBUTE);
  api.onPlayerLogin(onLoginSyncOption);
  api.onPlayerProcess(onLoginSyncOption);
  api.onPlayerOption(handlePlayerOption);
  api.onInterfaceActionButton(uid(COMPONENT.CLOSE_BUTTON), onCloseButton);
}

module.exports = {
  name: "PlayerExamine",
  register: attachPlugin,
  _test: { GROUP_ID, COMPONENT, uid, DESCRIPTION_ATTRIBUTE, EXAMINE_OPTION_SLOT },
};
