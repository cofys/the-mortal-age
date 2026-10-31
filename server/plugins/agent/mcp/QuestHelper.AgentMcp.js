// Drives the real Quest Helper (server -> Java bridge) for an online player with no client
// attached. Each call answers two questions at once: what the helper says to do next, and where the
// quest's saved stage actually is, so a divergence is attributable rather than a shrug.
const { collectQuestHelperSnapshot, resolveTargets } = require("../../quests/questhelper/Snapshot.QuestHelper");

module.exports = function registerQuestHelperTools(ctx) {
  const { core, tool, z, player, find, items, nearby } = ctx;
  const { Skill, World, ObjectDefinition, NpcDefinition, ItemDefinition } = core;

  const runtime = () => {
    const instance = require("../../quests/QuestHelper.plugin").getRuntime?.();
    if (!instance) throw new Error("Quest Helper is not registered on this server");
    return instance;
  };

  const inCache = (kind, id) => {
    try {
      if (kind === "npc") return !!NpcDefinition.forId(id);
      if (kind === "object") return !!ObjectDefinition.forId(id);
      if (kind === "item") return !!ItemDefinition.forId(id);
    } catch {
      return false;
    }
    return true;
  };

  const skillsOf = (p) => {
    const manager = p.getSkillManager();
    const skills = {};
    for (const skill of Skill.values()) {
      skills[skill.getName().toUpperCase()] = {
        real: manager.getMaxLevel(skill), boosted: manager.getCurrentLevel(skill), xp: manager.getExperience(skill),
      };
    }
    return skills;
  };

  // Without a camera matrix the helper cannot project overlays; QueryHelperRuntime's authoritative
  // pass supplies every var, quest state, item and position after this.
  const snapshotFor = (p, radius) => collectQuestHelperSnapshot({
    nearby, items, skills: skillsOf, tick: () => World.getProcessCycle(),
  }, p, { radius });

  const resolveQuest = (instance, wanted) => {
    const quests = instance.quests();
    const text = String(wanted ?? "").trim();
    if (!text) throw new Error("Name a quest; quest_helper_quests lists the keys");
    const exact = quests.find((q) => q.key === text)
      ?? quests.find((q) => q.name?.toLowerCase() === text.toLowerCase());
    if (exact) return exact;
    const partial = quests.filter((q) => q.name?.toLowerCase().includes(text.toLowerCase()));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new Error(`"${text}" matches ${partial.length} quests: `
        + `${partial.slice(0, 8).map((q) => `${q.name} (${q.key})`).join(", ")}; pass the quest key`);
    }
    throw new Error(`Unknown quest "${text}"; quest_helper_quests lists the keys`);
  };

  // The section holding the active step, with its own steps: the immediate plan.
  // Upstream nests panels (TopLevelPanelDetails), so flatten before looking for it.
  const flatSections = (sections, depth = 0, out = []) => {
    for (const section of sections ?? []) {
      out.push({ ...section, depth });
      if (Array.isArray(section.children)) flatSections(section.children, depth + 1, out);
    }
    return out;
  };
  const currentSection = (sections) => {
    const found = flatSections(sections).find((section) => section.active === true
      || (section.steps ?? []).some((step) => step.active === true));
    if (!found) return null;
    return {
      index: found.index, title: found.title, depth: found.depth, locked: found.locked ?? false,
      steps: (found.steps ?? []).map((step) => ({
        text: step.text, ...(step.faded ? { faded: true } : {}), ...(step.active ? { current: true } : {}),
      })),
    };
  };

  // Every section, so the agent knows how much of the guide is left, without the whole text.
  const sectionIndex = (sections) => flatSections(sections).map((section) => ({
    index: section.index, title: section.title, depth: section.depth, steps: (section.steps ?? []).length,
    ...(section.hidden ? { hidden: true } : {}),
    ...(section.lockable ? { lockable: true, locked: section.locked ?? false } : {}),
    ...(section.active === true || (section.steps ?? []).some((step) => step.active === true) ? { current: true } : {}),
  }));

  const summarize = (instance, p, result, snapshot, { overlays = false, verbose = false } = {}) => {
    const step = result.activeStep ?? null;
    const quest = instance.describe(p, result.questKey) ?? { questKey: result.questKey };
    const section = currentSection(result.sections);
    return {
      // Two sides, named apart: the saved quest and what the helper answered. Collapsing them
      // would hide exactly the disagreement this tool exists to find.
      questKey: quest.questKey, name: quest.name,
      questStatus: quest.status, stage: quest.stage, complete: quest.complete, wire: quest.wire,
      contract: quest.contract ?? null,
      helperStatus: result.status,
      sourceCommit: result.sourceCommit ?? null,
      step: step && {
        id: step.id,
        text: step.text,
        targets: step.targets,
        requirements: step.requirements,
        recommended: step.recommended,
        teleports: step.teleports,
        dialogueChoices: step.dialogueChoices,
        choiceRules: step.choiceRules,
        geItems: step.geItems,
        inventoryHighlights: step.inventoryHighlights,
      },
      targets: resolveTargets(step?.targets, snapshot, inCache),
      section,
      sections: sectionIndex(result.sections),
      pluginMessages: result.pluginMessages ?? [],
      diagnostics: result.diagnostics ?? [],
      requests: result.requests ?? [],
      // How many times the bridge's state requests were answered from the server, and what is
      // still missing (a cache definition or geometry the server cannot supply).
      ...(result.requestsFilled ? { requestsFilled: result.requestsFilled } : {}),
      ...(result.requestsUnresolved?.length ? { requestsUnresolved: result.requestsUnresolved } : {}),
      ...(overlays ? { overlays: step?.overlays ?? [] } : {}),
      ...(verbose ? {
        activeStep: step, panels: result.panels, overview: result.overview,
        overlayPanel: result.overlayPanel, bankTab: result.bankTab, sectionsRaw: result.sections,
      } : {}),
    };
  };

  tool(
    "quest_helper",
    "Evaluate the real Quest Helper for an online player with no client attached: the current step's text, dialogue choices, NPC/object/item/tile targets, requirements, teleports and recommended items, each target checked against the cache and the scene, and the quest's saved stage with the varp/varbit it mirrors to. Play the step with the normal tools, then call again. Compare the step and the stage to tell a helper-integration fault from a quest fault.",
    {
      player,
      quest: z.string().describe("Quest key or name, e.g. cooks_assistant"),
      variant: z.string().optional().describe("Helper variant, when the quest maps to more than one route"),
      radius: z.number().int().min(8).max(64).default(32).describe("Scene scan radius in tiles"),
      config: z.record(z.union([z.boolean(), z.number().int()])).optional()
        .describe('Upstream QuestHelperConfig keys, e.g. {"showWidgetHints": false}'),
      bankTab: z.boolean().default(false).describe("Also return the quest bank tab (bank open or near the GE)"),
      section: z.object({ section: z.number().int().min(0), locked: z.boolean() }).optional()
        .describe("Mark a sidebar section complete, like the panel's own checkbox"),
      fresh: z.boolean().default(false).describe("Drop the parked engine session and start this route again"),
      overlays: z.boolean().default(false).describe("Include upstream's portable draw commands"),
      verbose: z.boolean().default(false).describe("Include the whole sidebar, overview and raw step"),
    },
    async ({ player: username, quest, variant, radius, config, bankTab, section, fresh, overlays, verbose }) => {
      const instance = runtime();
      const p = find(username);
      const row = resolveQuest(instance, quest);
      const snapshot = snapshotFor(p, radius);
      const result = await instance.evaluateHeadless(p, {
        questKey: row.key, helperVariant: variant, snapshot, config, bankTab, lockSection: section, fresh,
      });
      return summarize(instance, p, result, snapshot, { overlays, verbose });
    }
  );

  tool(
    "quest_helper_result",
    "What Quest Helper last told a connected browser for this player (the real client-to-server path), falling back to the last headless evaluation when no client has asked. Use it to confirm headless steps match what a user actually sees.",
    { player, overlays: z.boolean().default(false), verbose: z.boolean().default(false) },
    ({ player: username, overlays, verbose }) => {
      const instance = runtime();
      const p = find(username);
      const tapped = instance.lastResult(p);
      const headless = instance.lastAgentResult(p);
      const picked = tapped ?? headless;
      if (!picked) throw new Error("No Quest Helper result yet: call quest_helper, or open the helper panel in a client");
      return {
        source: tapped ? "client" : "headless",
        ageMs: Date.now() - picked.at,
        ...summarize(instance, p, picked.result, snapshotFor(p, 32), { overlays, verbose }),
      };
    }
  );

  tool(
    "quest_helper_quests",
    "The quests this server knows, with saved status and stage, so quest_helper can be pointed at a key. Read-only, needs no client.",
    { player, filter: z.string().optional().describe("Only keys or names containing this text") },
    ({ player: username, filter }) => {
      const instance = runtime();
      const p = find(username);
      const text = filter?.toLowerCase();
      const rows = instance.progress(p)
        .map((row) => instance.describe(p, row.questKey))
        .filter((row) => row && (!text || row.questKey.includes(text) || row.name?.toLowerCase().includes(text)))
        .map((row) => ({
          questKey: row.questKey, name: row.name, status: row.status, stage: row.stage, wire: row.wire,
          // A quest whose wire and saved stage disagree with the cache's own endstate is a defect in
          // this server, whatever the guide says.
          ...(row.contract ? { contract: { endstate: row.contract.endstate, agrees: row.contract.agrees } } : {}),
        }));
      return { count: rows.length, quests: rows };
    }
  );
};
