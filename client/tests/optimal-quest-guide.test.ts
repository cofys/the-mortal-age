import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Client } from "@runelite/api/Client";
import { GameState } from "@runelite/api/GameState";
import { Quest, QUEST_STATUS_GET } from "@runelite/api/Quest";
import { QuestState } from "@runelite/api/QuestState";
import { ConfigChanged, GameTick } from "@runelite/api/events";
import type { ConfigStorage } from "@runelite/client/config/ConfigStorage";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { EventBus } from "@runelite/client/eventbus/EventBus";
import { PluginManager } from "@runelite/client/plugins/PluginManager";
import { CLIENT_TOKEN } from "@runelite/client/plugins/PluginInjector";
import { ClientToolbar } from "@runelite/client/ui/ClientToolbar";
import { GuideConfig } from "../game/plugins/optimalquestguide/GuideConfig";
import { GuidePanel } from "../game/plugins/optimalquestguide/GuidePanel";
import { GuidePlugin } from "../game/plugins/optimalquestguide/GuidePlugin";
import {
    cssColor,
    isQuestShown,
    questNameColor,
    requirementColor,
    visibleRows,
    type GuideView,
    type QuestRow,
} from "../game/plugins/optimalquestguide/GuideView";
import { loadQuestInfos, playerLevel, requirementIcon, type QuestData } from "../game/plugins/optimalquestguide/QuestInfo";
import { SkillId } from "../rs/skill/skills";
import { ClientImpl } from "../runelite/impl/ClientImpl";
import { createCacheVm } from "../scripts/cache/cs2-sweep";

class MemoryStorage implements ConfigStorage {
    private readonly values = new Map<string, string>();
    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }
    removeItem(key: string): void {
        this.values.delete(key);
    }
    key(index: number): string | null {
        return [...this.values.keys()][index] ?? null;
    }
    get length(): number {
        return this.values.size;
    }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const publicFile = (url: string) => new URL(`../public${url}`, import.meta.url);
const ENGINE_LOGGED_IN = 30;
const ENGINE_LOGIN_SCREEN = 10;
const COOKS_ASSISTANT_VARP = 29;

// --- Data: the Hub plugin's quests.json, and RuneLite's Quest enum ---------------------------
const data = JSON.parse(
    readFileSync(new URL("../game/plugins/optimalquestguide/quests.json", import.meta.url), "utf8"),
) as QuestData[];
assert.equal(data.length, 205, "the plugin's 205 quests at Hub commit b801ca1");
assert.equal(data[0].name, "Learning the Ropes", "the guide starts at Learning the Ropes");
const questNames = new Set(Quest.values().map((quest) => quest.getName()));
assert.equal(Quest.values().length, 214, "RuneLite's Quest enum, quests and miniquests");
assert.equal(new Set(Quest.values().map((quest) => quest.getId())).size, 214, "quest ids are unique");
assert.equal(Quest.COOKS_ASSISTANT.getId(), 17);
assert.deepEqual(
    data.filter((quest) => !questNames.has(quest.name)).map((quest) => quest.name),
    ["Knight Waves Training Grounds"],
    "every guide entry is a RuneLite quest except the one the plugin can't track either",
);
for (const quest of data) {
    for (const requirement of quest.reqs) {
        const icon = requirementIcon(requirement);
        assert.ok(icon, `${quest.name}: an icon for ${requirement.skill}`);
        assert.ok(existsSync(publicFile(icon!)), `${icon} is bundled`);
    }
}
const license = readFileSync(publicFile("/optimalquestguide/LICENSE.md"), "utf8");
for (const file of ["quest_point.png", "combat_level.png", "skill_icons_small/"]) {
    assert.ok(license.includes(file), `LICENSE.md credits ${file}`);
}

// --- Quest.getState: RuneLite's reading of QUEST_STATUS_GET's result -------------------------
{
    let result = 0;
    const calls: number[][] = [];
    const client = {
        runScript: (...args: number[]) => calls.push(args),
        getIntStack: () => [result],
    } as unknown as Client;
    const states = [2, 1, 0].map((value) => {
        result = value;
        return Quest.DRAGON_SLAYER_I.getState(client);
    });
    assert.deepEqual(states, [QuestState.FINISHED, QuestState.NOT_STARTED, QuestState.IN_PROGRESS]);
    assert.deepEqual(calls[0], [QUEST_STATUS_GET, Quest.DRAGON_SLAYER_I.getId()]);
}

// --- The real cache's quest_status_get, run through ClientImpl -------------------------------
const { vm } = createCacheVm();
const varManager = vm.context.varManager;
const levels = new Map<number, number>([[SkillId.Cooking, 10], [SkillId.Crafting, 30]]);
(vm.context as any).getStatBase = (skill: number) => levels.get(skill) ?? 1;
const engine: any = {
    gameState: ENGINE_LOGGED_IN,
    cs2Vm: vm,
    varManager,
    controlledPlayerServerId: 5,
    localPlayerName: "Alice",
    playerEcs: { getIndexForServerId: (id: number) => (id === 5 ? 0 : undefined), getCombatLevel: () => 40 },
};
const clientImpl = new ClientImpl(engine);
{
    const stateAt = (value: number) => {
        varManager.setVarp(COOKS_ASSISTANT_VARP, value);
        return Quest.COOKS_ASSISTANT.getState(clientImpl);
    };
    assert.equal(stateAt(0), QuestState.NOT_STARTED, "cache script: Cook's Assistant not started");
    assert.equal(stateAt(1), QuestState.IN_PROGRESS, "cache script: in progress");
    assert.equal(stateAt(2), QuestState.FINISHED, "cache script: finished");
    varManager.setVarp(COOKS_ASSISTANT_VARP, 0);
    assert.equal(clientImpl.getGameState(), GameState.LOGGED_IN);
    assert.equal(clientImpl.getRealSkillLevel(SkillId.Crafting), 30);
    assert.equal(clientImpl.getLocalPlayer()?.getCombatLevel(), 40);
    // Requirement levels: quest points (varp 101), combat level, real skill level.
    varManager.setVarp(101, 12);
    assert.equal(playerLevel(clientImpl, { skill: "Quest points", level: 10, boostable: false }), 12);
    assert.equal(playerLevel(clientImpl, { skill: "Combat level", level: 50, boostable: false }), 40);
    assert.equal(playerLevel(clientImpl, { skill: "Crafting", level: 31, boostable: true }), 30);
    const loggedOut = new ClientImpl({ ...engine, controlledPlayerServerId: -1 });
    assert.equal(loggedOut.getLocalPlayer(), null);
    assert.equal(playerLevel(loggedOut, { skill: "Crafting", level: 31, boostable: true }), undefined);
    // Never run a script from inside another: it would reset that script's stacks.
    const busy = new ClientImpl({ ...engine, cs2Vm: { isRunning: () => true } });
    assert.throws(() => busy.runScript(QUEST_STATUS_GET, 17));
}

// --- What the panel shows (GuidePanel / QuestPanel / SearchListener) -------------------------
const bus = new EventBus();
const configManager = new ConfigManager(bus, new MemoryStorage());
const config = configManager.getConfig(GuideConfig);
const set = (key: string, value: unknown) => configManager.setConfiguration(GuideConfig.group, key, value as any);
{
    assert.equal(config.getInProgressColor(), 0xf0cf7b, "new Color(240, 207, 123)");
    assert.equal(config.getRequirementUnmetColor(), 0xe61e1e, "new Color(230, 30, 30)");
    assert.equal(cssColor(config.getRequirementBoostableColor()), "#32a0fa");
    assert.equal(questNameColor(undefined, config), undefined, "uncoloured until known");
    assert.equal(questNameColor(QuestState.FINISHED, config), 0x6ee16e);
    assert.equal(questNameColor(QuestState.NOT_STARTED, config), 0xc6c6c6);
    const req = { skill: "Mining", level: 40, boostable: true };
    assert.equal(requirementColor(req, 40, config), config.getRequirementMetColor(), "met at the level");
    assert.equal(requirementColor(req, 39, config), config.getRequirementBoostableColor());
    assert.equal(requirementColor({ ...req, boostable: false }, 39, config), config.getRequirementUnmetColor());
    assert.equal(requirementColor(req, undefined, config), undefined);

    const row = (name: string, questState: QuestState | undefined, reqLevels: number[] = [], have: number[] = []): QuestRow => ({
        info: { name, uri: "", index: 0, questState, reqs: reqLevels.map((level) => ({ skill: "Mining", level, boostable: false })) },
        levels: have,
    });
    const done = row("Cook's Assistant", QuestState.FINISHED);
    const started = row("Demon Slayer", QuestState.IN_PROGRESS);
    const hard = row("Dragon Slayer I", QuestState.NOT_STARTED, [32], [20]);
    const unknown = row("Knight Waves Training Grounds", undefined);
    const view: GuideView = { updated: true, rows: [done, started, hard, unknown] };
    const names = (rows: QuestRow[]) => rows.map((r) => r.info.name);

    assert.deepEqual(names(visibleRows({ ...view, updated: false }, config, "")), names(view.rows), "before login: all");
    assert.deepEqual(names(visibleRows(view, config, "")), ["Demon Slayer", "Dragon Slayer I"], "unfinished only");
    set("filterMetRequirements", true);
    assert.deepEqual(names(visibleRows(view, config, "")), ["Demon Slayer"], "filter by met requirements");
    hard.levels = [32];
    assert.deepEqual(names(visibleRows(view, config, "")), ["Demon Slayer", "Dragon Slayer I"], "shown once met");
    hard.levels = [undefined];
    assert.ok(isQuestShown(hard, config, true), "no local player: left shown");
    set("filterMetRequirements", false);
    set("showCompletedQuests", true);
    assert.equal(visibleRows(view, config, "").length, 4, "show completed: all");
    set("showCompletedQuests", false);

    assert.deepEqual(names(visibleRows(view, config, "SLAYER")), ["Demon Slayer", "Dragon Slayer I"], "search ignores case");
    assert.deepEqual(names(visibleRows(view, config, "cook")), [], "search skips completed quests");
    set("searchCompletedQuests", true);
    assert.deepEqual(names(visibleRows(view, config, "cook")), ["Cook's Assistant"], "unless asked to");
    set("searchCompletedQuests", false);
    const allDone: GuideView = { updated: true, rows: [done] };
    assert.deepEqual(names(visibleRows(allDone, config, "cook")), ["Cook's Assistant"], "nothing shown: search all");
}

// --- The plugin: off by default, its button while on, updated every game tick ----------------
async function main(): Promise<void> {
    // CORE_PLUGINS pulls in WebGL plugins Node can't load, so read the list's source.
    const corePlugins = readFileSync(new URL("../runelite/client/plugins/index.ts", import.meta.url), "utf8");
    assert.match(corePlugins, /^\s+GuidePlugin,$/m, "listed in the plugin hub");
    const pluginManager = new PluginManager(bus, configManager);
    const injector = pluginManager.getInjector();
    const toolbar = injector.get<ClientToolbar>(ClientToolbar);
    injector.provide(CLIENT_TOKEN, engine);
    pluginManager.loadCorePlugins([GuidePlugin]);
    await settle();
    const tooltips = () => toolbar.getNavigations().map((button) => button.tooltip);
    assert.deepEqual(tooltips(), [], "off on fresh installs");

    await pluginManager.setPluginEnabled(GuidePlugin, true);
    assert.equal(configManager.getConfiguration("runelite", "guideplugin"), "true", "RuneLite's enabled key");
    const button = toolbar.getNavigations().find((b) => b.tooltip === "Optimal Quest Guide");
    assert.ok(button, "the sidebar button");
    assert.equal(button!.getPriority(), 7);
    const plugin = pluginManager.getPlugins().find((p) => p instanceof GuidePlugin) as GuidePlugin;
    assert.ok(plugin?.isStarted());

    let view = plugin.getView();
    assert.equal(view.updated, false);
    assert.equal(view.rows.length, 205);
    let markup = renderToStaticMarkup(createElement(GuidePanel, { plugin }));
    assert.ok(markup.includes("Quests will adjust after login."));
    assert.ok(markup.includes("Learning the Ropes") && markup.includes("Dragon Slayer I"));

    // A game tick reads every quest through the real cache script.
    varManager.setVarp(COOKS_ASSISTANT_VARP, 2);
    let emits = 0;
    const unsubscribe = plugin.subscribe(() => emits++);
    bus.post(new GameTick());
    view = plugin.getView();
    assert.equal(view.updated, true);
    assert.equal(emits, 1);
    const cook = view.rows.find((r) => r.info.name === "Cook's Assistant")!;
    assert.equal(cook.info.questState, QuestState.FINISHED);
    assert.equal(view.rows.find((r) => r.info.name === "Sheep Shearer")!.info.questState, QuestState.NOT_STARTED);
    assert.equal(view.rows.find((r) => r.info.name === "Knight Waves Training Grounds")!.info.questState, undefined);
    bus.post(new GameTick());
    assert.equal(emits, 1, "an unchanged tick doesn't redraw the panel");
    levels.set(SkillId.Cooking, 11);
    bus.post(new GameTick());
    assert.equal(emits, 2, "a level change does");

    markup = renderToStaticMarkup(createElement(GuidePanel, { plugin }));
    assert.ok(markup.includes("Happy questing."));
    assert.ok(!markup.includes("Cook&#x27;s Assistant"), "a finished quest is hidden");
    assert.ok(markup.includes("color:#c6c6c6\">Sheep Shearer"), "not started: its colour");
    assert.ok(markup.includes("/optimalquestguide/skill_icons_small/cooking.png"), "RuneLite's small skill icons");
    assert.ok(markup.includes("/optimalquestguide/quest_point.png"));
    assert.ok(markup.includes('aria-label="Search quests"'), "the search bar");

    // Changing a setting redraws, logged in or not.
    plugin.onConfigChanged(new ConfigChanged(GuideConfig.group, "showCompletedQuests", "false", "true"));
    assert.equal(emits, 3);
    engine.gameState = ENGINE_LOGIN_SCREEN;
    set("showCompletedQuests", true);
    assert.ok(emits >= 4, "the config bus event reaches the plugin");
    markup = renderToStaticMarkup(createElement(GuidePanel, { plugin }));
    assert.ok(markup.includes("Cook&#x27;s Assistant"), "show completed quests");
    set("showCompletedQuests", false);
    engine.gameState = ENGINE_LOGGED_IN;
    unsubscribe();

    await pluginManager.setPluginEnabled(GuidePlugin, false);
    assert.deepEqual(tooltips(), [], "the button goes when turned off");
    varManager.setVarp(COOKS_ASSISTANT_VARP, 0);
    console.log("optimal-quest-guide: ok");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
