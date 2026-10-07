"use strict";

/**
 * ExamineApi — HTTP data layer for the web client's examine overlay.
 *
 * Right-click "Examine" on another player sets the examine:open player
 * attribute to the target's username (see PlayerExamine.plugin.js); the
 * React ExamineOverlay (client/game/plugins/examine) polls this endpoint
 * and renders the character sheet in the origin-selection heraldic style.
 *
 *   GET /api/examine-status?player=<username>
 *     -> { open: false } | { open: true, sheet: {...} }
 *
 *   ...&action=close — clear the examine:open flag (overlay dismissed)
 *
 * Sheet shape:
 *   { name, byline, description,
 *     reputation: [{ kingdom, tier, points }],
 *     accomplishments: [name, ...], accomplishmentCount,
 *     guild: { name, rank } | null,
 *     skills: [{ name, level }] }
 */

const DISPLAY_NAME_ATTRIBUTE = "character:display-name";
const BACKGROUND_ID_ATTRIBUTE = "background:id";
const ORIGIN_ID_ATTRIBUTE = "origin:id";
const DESCRIPTION_ATTRIBUTE = "examine:description";
const INFLUENCE_ATTRIBUTE = "kingdom:influence";
const EXAMINE_OPEN_ATTRIBUTE = "examine:open";

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

function tierFor(points) {
  if (points >= 50) return "Revered";
  if (points >= 25) return "Respected";
  if (points >= 10) return "Known";
  if (points > 0) return "Noticed";
  return "Neutral";
}

function safeGet(player, key) {
  try {
    return player.getAttribute(key);
  } catch {
    return undefined;
  }
}

function sheetFor(api, target) {
  // Name
  let name = target.getUsername?.() || "Unknown";
  try {
    const dn = safeGet(target, DISPLAY_NAME_ATTRIBUTE);
    if (dn && String(dn).trim()) name = String(dn).trim();
  } catch {
    // keep username
  }

  // Byline: background + origin
  const bylineBits = [];
  try {
    const bgId = safeGet(target, BACKGROUND_ID_ATTRIBUTE);
    if (bgId) {
      const { BY_ID } = require("../origins/Data.Backgrounds");
      const bg = BY_ID.get(bgId);
      if (bg?.name) bylineBits.push(String(bg.name));
    }
  } catch {
    // no background
  }
  try {
    const originId = safeGet(target, ORIGIN_ID_ATTRIBUTE);
    if (originId) {
      const { BY_ID } = require("../origins/Data.Origins");
      const origin = BY_ID.get(originId);
      if (origin?.name) bylineBits.push(`of ${origin.name}`);
    }
  } catch {
    // no origin
  }

  // Description: plain text, no HTML tags
  let description = null;
  try {
    const desc = safeGet(target, DESCRIPTION_ATTRIBUTE);
    if (desc && String(desc).trim()) description = String(desc).trim().slice(0, 400);
  } catch {
    description = null;
  }

  // Reputation: structured array
  const reputation = [];
  try {
    const influence = safeGet(target, INFLUENCE_ATTRIBUTE) || {};
    for (const [kingdomId, data] of Object.entries(influence).slice(0, 6)) {
      const points = Math.round(data?.points || 0);
      reputation.push({ kingdom: kingdomName(kingdomId), tier: tierFor(points), points });
    }
  } catch {
    // no reputation
  }

  // Accomplishments: completed quest names
  const accomplishments = [];
  try {
    const QuestState = require("../quests/mortal/QuestState");
    const Data = require("../quests/mortal/Data.QuestRegistry");
    for (const quest of Data.ALL_QUESTS || []) {
      try {
        if (QuestState.isComplete(target, quest.id)) {
          accomplishments.push(String(quest.name || quest.id));
        }
      } catch {
        // skip this quest
      }
    }
  } catch {
    // quest system unavailable
  }

  // Guild
  let guild = null;
  try {
    const Registry = require("../guilds/GuildRegistry");
    const username = target.getUsername();
    const g = Registry.memberGuild(username);
    if (g) {
      guild = { name: String(g.name), rank: String(Registry.memberRank(g, username) || "Member") };
    }
  } catch {
    guild = null;
  }

  // Top skills
  const skills = [];
  try {
    const Skill = api.core.Skill;
    const manager = target.getSkillManager();
    const all = [];
    for (const skill of Skill.values()) {
      try {
        const level = manager.getCurrentLevel(skill);
        if (typeof level === "number" && level > 1) {
          all.push({ name: skill.getName?.() || "Unknown", level });
        }
      } catch {
        // skip
      }
    }
    all.sort((a, b) => b.level - a.level);
    for (const s of all.slice(0, 5)) skills.push(s);
  } catch {
    // no skills
  }

  return {
    name,
    byline: bylineBits.join(" ") || null,
    description,
    reputation,
    accomplishments: accomplishments.slice(0, 8),
    accomplishmentCount: accomplishments.length,
    guild,
    skills,
  };
}

function findPlayer(api, username) {
  const name = (username || "").trim();
  if (!name) return null;
  try {
    return api.core.World.getPlayerByName(name) || null;
  } catch {
    return null;
  }
}

function attach(api) {
  console.info("[examine-api] registering examine-status endpoint");
  api.registerContentEndpoint("examine-status", (query) => {
    const player = findPlayer(api, query.get("player"));
    const action = (query.get("action") || "").trim().toLowerCase();

    if (player && action === "close") {
      try {
        player.setAttribute(EXAMINE_OPEN_ATTRIBUTE, "");
      } catch (e) {
        console.warn("[examine-api] close failed", e?.message ?? e);
      }
      return { open: false };
    }

    if (!player) return { open: false };

    let targetName = "";
    try {
      targetName = String(player.getAttribute(EXAMINE_OPEN_ATTRIBUTE) || "").trim();
    } catch {
      targetName = "";
    }
    if (!targetName) return { open: false };

    const target = findPlayer(api, targetName);
    if (!target) {
      // Target logged out — clear the flag so the overlay closes.
      try {
        player.setAttribute(EXAMINE_OPEN_ATTRIBUTE, "");
      } catch {
        // ignore
      }
      return { open: false };
    }

    return { open: true, sheet: sheetFor(api, target) };
  });
}

module.exports = { attach, EXAMINE_OPEN_ATTRIBUTE };
