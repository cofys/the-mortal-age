/**
 * PlayerExamine — Mortal Age character sheet.
 *
 * Right-click "Examine" on another player opens a panel showing who they ARE,
 * not just their levels:
 *   - Name
 *   - Character description (RP flavor text, set via ::desc)
 *   - Reputation per kingdom (from kingdom:influence)
 *   - Accomplishments (completed quests)
 *   - Guild membership and rank
 *   - Top 5 skills by level
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

const COMPONENT = {
  ROOT: 0,
  FRAME: 1,
  TITLE: 2,
  DESCRIPTION_LABEL: 3,
  DESCRIPTION: 4,
  REPUTATION_LABEL: 5,
  REPUTATION: 6,
  ACCOMPLISHMENTS_LABEL: 7,
  ACCOMPLISHMENTS: 8,
  GUILD_LABEL: 9,
  GUILD: 10,
  SKILLS_LABEL: 11,
  SKILLS: 12,
  CLOSE_BUTTON: 13,
  CLOSE_TEXT: 14,
};

const uid = (component) => (GROUP_ID << 16) | component;

let pluginApi = null;

function buildInterface() {
  const { widgets, add } = createWidgetGroup(GROUP_ID);

  const root = add(COMPONENT.ROOT, -1, {
    rawWidth: 18, rawHeight: 18, widthMode: 1, heightMode: 1,
    width: 494, height: 400, xPositionMode: 1, yPositionMode: 1,
  });
  add(COMPONENT.FRAME, root, {
    widthMode: 1, heightMode: 1, width: 494, height: 400,
  });

  // Title — player name
  add(COMPONENT.TITLE, root, {
    type: TYPE_TEXT, rawX: 18, rawY: 12, rawWidth: 458, rawHeight: 24,
    width: 458, height: 24, fontId: 494, textColor: 0xffd27f,
    textShadowed: true, yTextAlignment: 1,
  });

  // Description section
  add(COMPONENT.DESCRIPTION_LABEL, root, {
    type: TYPE_TEXT, rawX: 18, rawY: 42, rawWidth: 458, rawHeight: 16,
    width: 458, height: 16, fontId: 494, textColor: 0xc9a86a, text: "Description",
    textShadowed: true,
  });
  add(COMPONENT.DESCRIPTION, root, {
    type: TYPE_TEXT, rawX: 18, rawY: 60, rawWidth: 458, rawHeight: 48,
    width: 458, height: 48, fontId: 494, textColor: 0xe8ded0,
    textShadowed: true,
  });

  // Reputation section
  add(COMPONENT.REPUTATION_LABEL, root, {
    type: TYPE_TEXT, rawX: 18, rawY: 114, rawWidth: 458, rawHeight: 16,
    width: 458, height: 16, fontId: 494, textColor: 0xc9a86a, text: "Reputation",
    textShadowed: true,
  });
  add(COMPONENT.REPUTATION, root, {
    type: TYPE_TEXT, rawX: 18, rawY: 132, rawWidth: 458, rawHeight: 48,
    width: 458, height: 48, fontId: 494, textColor: 0xe8ded0,
    textShadowed: true,
  });

  // Accomplishments section
  add(COMPONENT.ACCOMPLISHMENTS_LABEL, root, {
    type: TYPE_TEXT, rawX: 18, rawY: 186, rawWidth: 458, rawHeight: 16,
    width: 458, height: 16, fontId: 494, textColor: 0xc9a86a, text: "Accomplishments",
    textShadowed: true,
  });
  add(COMPONENT.ACCOMPLISHMENTS, root, {
    type: TYPE_TEXT, rawX: 18, rawY: 204, rawWidth: 458, rawHeight: 48,
    width: 458, height: 48, fontId: 494, textColor: 0xe8ded0,
    textShadowed: true,
  });

  // Guild section
  add(COMPONENT.GUILD_LABEL, root, {
    type: TYPE_TEXT, rawX: 18, rawY: 258, rawWidth: 458, rawHeight: 16,
    width: 458, height: 16, fontId: 494, textColor: 0xc9a86a, text: "Guild",
    textShadowed: true,
  });
  add(COMPONENT.GUILD, root, {
    type: TYPE_TEXT, rawX: 18, rawY: 276, rawWidth: 458, rawHeight: 24,
    width: 458, height: 24, fontId: 494, textColor: 0xe8ded0,
    textShadowed: true,
  });

  // Skills section
  add(COMPONENT.SKILLS_LABEL, root, {
    type: TYPE_TEXT, rawX: 18, rawY: 306, rawWidth: 458, rawHeight: 16,
    width: 458, height: 16, fontId: 494, textColor: 0xc9a86a, text: "Notable Skills",
    textShadowed: true,
  });
  add(COMPONENT.SKILLS, root, {
    type: TYPE_TEXT, rawX: 18, rawY: 324, rawWidth: 458, rawHeight: 32,
    width: 458, height: 32, fontId: 494, textColor: 0xe8ded0,
    textShadowed: true,
  });

  // Close button
  add(COMPONENT.CLOSE_BUTTON, root, {
    type: TYPE_RECTANGLE, rawX: 197, rawY: 362, rawWidth: 100, rawHeight: 28,
    width: 100, height: 28, filled: true, color: 0x2b241b, mouseOverColor: 0x3a3125,
    actions: ["Close"], flags: FLAG_OP1,
  });
  add(COMPONENT.CLOSE_TEXT, root, {
    type: TYPE_TEXT, rawX: 197, rawY: 362, rawWidth: 100, rawHeight: 28,
    width: 100, height: 28, fontId: 494, textColor: 0xe8ded0, text: "Close",
    textShadowed: true, yTextAlignment: 1,
  });

  return { groupId: GROUP_ID, widgets };
}

/** Wrap text to fit within a max line length. */
function wrapText(text, maxLen = 70) {
  if (!text) return "";
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > maxLen && line) {
      lines.push(line.trim());
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line.trim());
  return lines.join("<br>");
}

function getDescription(player) {
  const desc = player.getAttribute(DESCRIPTION_ATTRIBUTE);
  if (desc && String(desc).trim()) {
    return wrapText(desc, 70);
  }
  return "<i>No description set. Use ::desc to tell your story.</i>";
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
    return "No standing yet — serve a kingdom to earn reputation.";
  }
  return entries
    .map(([kingdomId, data]) => {
      const points = Math.round(data?.points || 0);
      const label = points >= 50 ? "Revered" : points >= 25 ? "Respected"
        : points >= 10 ? "Known" : points > 0 ? "Noticed" : "Neutral";
      return `${kingdomId}: ${label} (${points})`;
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
        completed.push(quest.name || quest.id);
      }
    }
  } catch {
    // Quest system not available
  }
  if (completed.length === 0) {
    return "No quests completed yet.";
  }
  return completed.slice(0, 5).join("<br>") +
    (completed.length > 5 ? `<br><i>+${completed.length - 5} more</i>` : "");
}

function getGuildInfo(player) {
  try {
    const Registry = require("../guilds/GuildRegistry");
    const username = player.getUsername();
    const guild = Registry.memberGuild(username);
    if (!guild) {
      return "No guild — a free agent.";
    }
    const rank = Registry.memberRank(guild, username) || "Member";
    return `${guild.name} — ${rank}`;
  } catch {
    return "No guild — a free agent.";
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
    const top = skills.slice(0, 5);
    if (top.length === 0) {
      return "No notable skills yet.";
    }
    return top.map((s) => `${s.name}: ${s.level}`).join("  |  ");
  } catch {
    return "No notable skills yet.";
  }
}

function openExamine({ player, target }) {
  if (!player || !target) return;
  const sender = player.getPacketSender();

  const name = target.getUsername?.() || "Unknown";

  sender.sendString(name, uid(COMPONENT.TITLE));
  sender.sendString(getDescription(target), uid(COMPONENT.DESCRIPTION));
  sender.sendString(getReputation(target), uid(COMPONENT.REPUTATION));
  sender.sendString(getAccomplishments(target), uid(COMPONENT.ACCOMPLISHMENTS));
  sender.sendString(getGuildInfo(target), uid(COMPONENT.GUILD));
  sender.sendString(getTopSkills(target), uid(COMPONENT.SKILLS));

  player.setInterfaceId(GROUP_ID);
  sender.sendSubInterface(MAIN_MODAL_UID, GROUP_ID, 0, {
    postScripts: [{ scriptId: 227, args: [uid(COMPONENT.FRAME), `Examining ${name}`] }],
  });
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
