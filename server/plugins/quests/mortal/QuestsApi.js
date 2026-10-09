"use strict";

/**
 * QuestsApi — HTTP data layer for the web client's quest overlay.
 *
 *   GET /api/quests-status?player=<username>
 *     -> { quest: null | {
 *            id, name, blurb, stageIndex, stageTotal,
 *            objective, arrived: boolean,
 *            dialogue: null | { speaker, title, lines, choices: [{text}] | null },
 *            task: null | { verb, has, need },
 *            complete: boolean,
 *            rewards: null | { items: [[name, amount]...], xp: [[skill, amount]...], message }
 *          } }
 *
 *   Actions (same endpoint):
 *     &action=continue  — advance past current dialogue stage
 *     &action=choice&option=N — pick dialogue choice N (jumps to stage)
 *     &action=dismiss    — dismiss the completion overlay
 *
 * Proximity ("arrive") and item tasks are evaluated server-side on every
 * poll: when a task stage's condition is met it auto-advances. Dialogue
 * stages advance only via explicit continue/choice actions.
 *
 * Follow-up quests (Data.FollowUpQuests) extend the schema:
 *   - arrive: { site: "<kingdom site>" } is resolved per-player via
 *     CitizenSites (square, market, tavern, bank, court, work, patrol).
 *   - {var} placeholders in any text are substituted from quest vars.
 *   - choices may carry set: { var: value } written on pick.
 *   - a stage may carry its own rewards, used when the quest completes
 *     from that stage (branching endings).
 *   - a stage may carry next: <stage index> | "complete" to control where
 *     the Continue button goes. Without it, Continue advances to the next
 *     stage index. This is what makes choice branches terminate correctly:
 *     the first branch's final stage sets next so it doesn't fall through
 *     into the second branch's stages.
 * When the player has no active quest, eligible follow-ups auto-start.
 */

const Data = require("./Data.QuestRegistry");
const QuestState = require("./QuestState");
const FollowUps = require("./FollowUpQuests");
const { substitute } = require("./QuestUtil");
const { siteTileByKingdom } = require("../../citizens/brain/CitizenSites");
const ContentApiAuth = require("../../interface/ContentApiAuth");

let apiRef = null;
let Items = null;
let Skill = null;

function playerPosition(player) {
  try {
    const loc = player.getLocation();
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ() };
  } catch {
    return null;
  }
}

/**
 * Resolve a stage's arrive target to concrete { x, y, r }. Symbolic
 * { site } targets resolve per-player through CitizenSites; patrol
 * resolves to the first patrol point; missing sites fall back to square.
 */
function resolveArrive(player, arrive) {
  if (!arrive) return null;
  if (arrive.site) {
    const kingdomId = FollowUps.playerKingdomId(player);
    let tile = siteTileByKingdom(kingdomId, arrive.site);
    if (!tile && arrive.site === "patrol") {
      // Patrol is a circuit array — resolve to its first point.
      tile = firstPatrolTile(kingdomId);
    }
    if (!tile) tile = siteTileByKingdom(kingdomId, "square");
    if (!tile) return { x: arrive.x, y: arrive.y, r: arrive.r || 8 };
    return { x: tile.x, y: tile.y, r: arrive.r || 8 };
  }
  return { x: arrive.x, y: arrive.y, r: arrive.r || 8 };
}

/** First valid tile of a kingdom's patrol circuit (sites.json "patrol"). */
const patrolTileCache = new Map(); // kingdomId -> tile|null
function firstPatrolTile(kingdomId) {
  if (patrolTileCache.has(kingdomId)) return patrolTileCache.get(kingdomId);
  let tile = null;
  try {
    const path = require("path");
    const fs = require("fs");
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "..", "..", "citizens", "data", "sites.json"),
        "utf8"
      )
    );
    const circuit = raw?.[kingdomId]?.patrol;
    if (Array.isArray(circuit)) {
      const pt = circuit.find((t) => t && Number.isFinite(t.x) && Number.isFinite(t.y));
      if (pt) tile = { x: pt.x, y: pt.y, z: pt.z ?? 0 };
    }
  } catch {
    // fall through to square fallback
  }
  // Cache even nulls: sites.json is static, and the client polls every 2s.
  patrolTileCache.set(kingdomId, tile);
  return tile;
}

function within(pos, target) {
  if (!pos || !target) return false;
  const dx = Math.abs(pos.x - target.x);
  const dy = Math.abs(pos.y - target.y);
  return Math.max(dx, dy) <= (target.r || 8);
}

// TEMP DIAGNOSTIC (remove after south-gate coordinate fix): log once per
// player+quest+stage when the arrive check fails, so we can see the player's
// real tile versus the target.
const arriveDiagLogged = new Set();
function diagNotArrived(player, quest, stageIndex, pos, target) {
  if (!player || !quest || !pos || !target) return;
  let name = "?";
  try {
    name = player.getUsername();
  } catch {
    return;
  }
  // Only sample near the target (~3x radius, floor 24 tiles). buildPayload is
  // polled every ~2s, so a once-ever log fires while the player is still at the
  // quest-giver (~60 tiles away) and never records them standing at the gate.
  const radius = target.r || 8;
  const dist = Math.max(Math.abs(pos.x - target.x), Math.abs(pos.y - target.y));
  if (dist > Math.max(radius * 3, 24)) return;
  const key = `${name}:${quest.id}:${stageIndex}`;
  if (arriveDiagLogged.has(key)) return;
  if (arriveDiagLogged.size > 200) arriveDiagLogged.clear();
  arriveDiagLogged.add(key);
  console.info(
    `[quests-api] DIAG not-arrived player=${name} quest=${quest.id} stage=${stageIndex} ` +
      `pos=(${pos.x},${pos.y},${pos.z}) target=(${target.x},${target.y},r=${target.r || 8})`
  );
}

function checkTask(player, stage) {
  const task = stage.task;
  if (!task) return { done: true, has: 0, need: 0 };
  if (task.type === "item") {
    const id = Items[task.item];
    if (!Number.isInteger(id)) return { done: false, has: 0, need: task.amount };
    let has = 0;
    try {
      has = player.getInventory().getAmount(id);
    } catch {
      has = 0;
    }
    return { done: has >= task.amount, has, need: task.amount };
  }
  return { done: true, has: 0, need: 0 };
}

function itemDisplayName(key) {
  // "RAW_SHRIMPS" -> "Raw shrimps"
  return key.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function rewardsDisplay(rewards, vars) {
  const r = rewards || {};
  return {
    items: (r.items || []).map(([key, amount]) => [itemDisplayName(key), amount]),
    xp: (r.xp || []).map(([skillName, amount]) => [skillName.toLowerCase(), amount]),
    message: substitute(r.message || "", vars),
  };
}

function grantRewards(player, quest, stage, vars) {
  const rewards = (stage && stage.rewards) || quest.rewards || {};
  try {
    const inv = player.getInventory();
    for (const [key, amount] of rewards.items || []) {
      const id = Items[key];
      if (Number.isInteger(id)) inv.adds(id, amount);
    }
  } catch (e) {
    console.warn("[quests-api] reward items failed", e?.message ?? e);
  }
  try {
    const sm = player.getSkillManager();
    for (const [skillName, amount] of rewards.xp || []) {
      const skill = Skill[skillName];
      if (skill !== undefined && skill !== null) sm.addExperiences(skill, amount);
    }
  } catch (e) {
    console.warn("[quests-api] reward xp failed", e?.message ?? e);
  }
  return rewardsDisplay(rewards, vars);
}

/** Run completion side-effects: rewards, chat message, follow-up effects. */
function completeQuestNow(player, quest, stage, stageIndex) {
  const vars = FollowUps.questVars(player, quest);
  const rewards = grantRewards(player, quest, stage, vars);
  try {
    player.sendMessage(`Quest complete: ${quest.name}`);
  } catch { /* non-fatal */ }
  FollowUps.onQuestCompleted(player, quest, apiRef);
  // Street news: citizens gossip about quest completions through the
  // bonded gossip network (zero LLM, template forceChat, paced by the
  // memory tick). Holderless seed — the first hop picks a citizen to
  // carry it, same pattern as the skill rumors.
  try {
    const { getMemory, GOSSIP_QUEST } = require("../../citizens/lib/CitizenMemory");
    const { playerName } = require("./QuestUtil");
    const kingdomId = FollowUps.playerKingdomId(player);
    const name = playerName(player);
    if (kingdomId && name) {
      getMemory().seedGossip({
        kingdomId,
        kind: GOSSIP_QUEST,
        subject: name,
        subjectDisplay: name,
        text: `finished the quest "${quest.name}"!`,
        holder: "",
      });
    }
  } catch {
    // Quests complete fine without the citizen layer.
  }
  return {
    quest: {
      id: quest.id, name: quest.name, blurb: substitute(quest.blurb, vars),
      stageIndex, stageTotal: quest.stages.length,
      complete: true, rewards,
    },
  };
}

function buildPayload(player) {
  const quest = QuestState.activeQuest(player);
  if (!quest) {
    // No active quest: maybe a follow-up is now eligible (lazy start),
    // then show any undismissed completion overlay.
    FollowUps.maybeStartFollowUps(player);
    const active = QuestState.activeQuest(player);
    if (active) return buildPayload(player);
    const done = QuestState.undismissedCompleteQuest(player);
    if (!done) return { quest: null };
    const vars = FollowUps.questVars(player, done);
    return {
      quest: {
        id: done.id, name: done.name, blurb: substitute(done.blurb, vars),
        stageIndex: done.stages.length - 1, stageTotal: done.stages.length,
        complete: true, rewards: rewardsDisplay(done.rewards, vars),
      },
    };
  }

  let stageIndex = QuestState.getStage(player, quest.id);
  // Defensive clamp (data may have changed since state was written).
  if (stageIndex < 0) stageIndex = 0;
  if (stageIndex >= quest.stages.length) stageIndex = quest.stages.length - 1;
  const stage = quest.stages[stageIndex];
  const pos = playerPosition(player);
  const vars = FollowUps.questVars(player, quest);

  const target = resolveArrive(player, stage.arrive);
  const arrived = !target || within(pos, target);
  if (!arrived && target) diagNotArrived(player, quest, stageIndex, pos, target);
  const taskCheck = checkTask(player, stage);

  // Auto-advance item tasks the moment their condition is met.
  if (stage.task && arrived && taskCheck.done) {
    const result = QuestState.advanceStage(player, quest.id);
    if (result === "complete") {
      return completeQuestNow(player, quest, stage, stageIndex);
    }
    // Rebuild for the new stage.
    return buildPayload(player);
  }

  // choices must be null (not []) when the stage has none: the client
  // treats a truthy choices value as "render choice buttons instead of the
  // Continue button", and [] is truthy in JS. An empty array here used to
  // strand players on the last dialogue line with no way to advance.
  const choiceList = (stage.dialogue.choices || []).map((c) => ({ text: substitute(c.text, vars) }));
  const dialogue = arrived && stage.dialogue
    ? {
        speaker: substitute(stage.dialogue.speaker, vars),
        title: substitute(stage.dialogue.title || "", vars),
        lines: (stage.dialogue.lines || []).map((l) => substitute(l, vars)),
        choices: choiceList.length ? choiceList : null,
      }
    : null;

  return {
    quest: {
      id: quest.id,
      name: quest.name,
      blurb: substitute(quest.blurb, vars),
      stageIndex,
      stageTotal: quest.stages.length,
      objective: substitute(stage.objective, vars),
      arrived,
      dialogue,
      task: stage.task
        ? { verb: stage.task.verb, has: taskCheck.has, need: taskCheck.need }
        : null,
      complete: false,
      rewards: null,
    },
  };
}

function handleAction(player, quest, action, query) {
  if (action === "dismiss") {
    // Dismiss the completion overlay for any undismissed completed quest.
    const done = QuestState.undismissedCompleteQuest(player);
    if (done) QuestState.markSeen(player, done.id);
    return;
  }
  if (!quest) return;
  const stageIndex = QuestState.getStage(player, quest.id);
  const stage = quest.stages[Math.min(stageIndex, quest.stages.length - 1)];
  const target = resolveArrive(player, stage.arrive);
  const pos = playerPosition(player);
  const arrived = !target || within(pos, target);

  if (action === "continue") {
    if (!arrived) return; // can't skip travel
    if (stage.dialogue && stage.dialogue.choices && stage.dialogue.choices.length) return; // must pick
    // Branch terminals: a stage can declare where Continue goes instead of
    // blindly advancing to stageIndex + 1 (which would fall through into a
    // sibling branch's stages after a choice).
    if (stage.next === "complete") {
      QuestState.completeQuest(player, quest.id); // persist completion; completeQuestNow only runs side-effects
      completeQuestNow(player, quest, stage, stageIndex);
      return;
    }
    if (Number.isInteger(stage.next)) {
      QuestState.setStage(player, quest.id, stage.next);
      return;
    }
    const result = QuestState.advanceStage(player, quest.id);
    if (result === "complete") {
      completeQuestNow(player, quest, stage, stageIndex);
    }
  } else if (action === "choice") {
    if (!arrived || !stage.dialogue || !stage.dialogue.choices) return;
    const idx = parseInt(query.get("option") || "-1", 10);
    const choice = stage.dialogue.choices[idx];
    if (!choice) return;
    // Choice-attached var writes (e.g. which ending branch was taken).
    if (choice.set) {
      for (const [name, value] of Object.entries(choice.set)) {
        try {
          QuestState.setVar(player, quest.id, name, value);
        } catch { /* non-fatal */ }
      }
    }
    QuestState.setStage(player, quest.id, choice.goto);
  }
}

function attach(api) {
  apiRef = api;
  Items = api.core.ItemIdentifiers;
  Skill = api.core.Skill;
  ContentApiAuth.setPluginApi(api);
  console.info("[quests-api] registering quests-status endpoint");
  api.registerContentEndpoint("quests-status", (query) => {
    // P0 security fix: require per-session token auth. Quest advancement is privileged.
    const player = ContentApiAuth.requireAuth(query);
    if (!player) return { quest: null, error: "unauthorized" };

    const quest = QuestState.activeQuest(player);
    const action = (query.get("action") || "").trim().toLowerCase();
    // Dismiss must work without an active quest: the completion overlay shows
    // exactly when there is no active quest, so gating on `quest` would make
    // its Continue button a dead button. handleAction no-ops other actions
    // when quest is null.
    if (action && (quest || action === "dismiss")) {
      try {
        handleAction(player, quest, action, query);
      } catch (e) {
        console.warn("[quests-api] action failed", e?.message ?? e);
      }
    }
    return buildPayload(player);
  });
}

module.exports = { attach };
