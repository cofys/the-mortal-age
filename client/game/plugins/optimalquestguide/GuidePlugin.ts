/*
 * Copyright (c) 2020, Christopher Oswald <https://github.com/cesoun>
 * All rights reserved.
 *
 * Ported to TypeScript. BSD 2-Clause License, see ./LICENSE.
 */
import type { Client } from "@runelite/api/Client";
import { GameState } from "@runelite/api/GameState";
import { Quest } from "@runelite/api/Quest";
import type { ConfigChanged, GameTick } from "@runelite/api/events";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { ClientToolbar } from "@runelite/client/ui/ClientToolbar";
import type { NavigationButton } from "@runelite/client/ui/NavigationButton";
import { ClientImpl } from "../../../runelite/impl/ClientImpl";
import type { OsrsClient } from "../../OsrsClient";
import { GuideConfig } from "./GuideConfig";
import { createGuideNavigationButton } from "./GuidePanel";
import type { GuideView } from "./GuideView";
import { loadQuestInfos, playerLevel, type QuestData, type QuestInfo } from "./QuestInfo";
import questData from "./quests.json";

/**
 * Optimal Quest Guide (cesoun, RuneLite Plugin Hub): the OSRS Wiki's optimal quest order in a
 * side panel, coloured by quest state and by whether you meet each skill requirement, updated
 * every game tick.
 */
export class GuidePlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Optimal Quest Guide",
        description: "I wanted this so now you get this as well. OSRS Wiki Optimal Quest Guide.",
        tags: ["quest", "guide", "optimal"],
        enabledByDefault: false,
        configKey: "guideplugin",
    };

    static config = GuideConfig;

    private readonly configManager = inject(ConfigManager);
    readonly config = this.configManager.getConfig(GuideConfig);
    private readonly client: Client;
    private readonly toolbar: ClientToolbar | undefined;
    private readonly infoMap = new Map<string, QuestInfo>();
    private infos: QuestInfo[] = [];
    private navButton?: NavigationButton;
    private view: GuideView = { updated: false, rows: [] };
    private viewKey = "";
    private readonly listeners = new Set<() => void>();

    constructor(client?: Client) {
        super();
        this.client = client ?? new ClientImpl(inject<OsrsClient>(CLIENT_TOKEN));
        try {
            this.toolbar = inject(ClientToolbar);
        } catch {
            this.toolbar = undefined;
        }
    }

    protected async startUp(): Promise<void> {
        this.infos = loadQuestInfos(questData as QuestData[]);
        this.infoMap.clear();
        for (const info of this.infos) this.infoMap.set(info.name, info);
        this.setView({ updated: false, rows: this.infos.map((info) => ({ info, levels: [] })) });

        if (this.toolbar) {
            this.navButton = createGuideNavigationButton(this);
            this.toolbar.addNavigation(this.navButton);
        }
    }

    protected async shutDown(): Promise<void> {
        if (this.navButton) this.toolbar?.removeNavigation(this.navButton);
        this.navButton = undefined;
    }

    onConfigChanged(event: ConfigChanged): void {
        if (event.getGroup().toLowerCase() !== GuideConfig.group) return;
        // The panel reads colours and filters from config; redraw it even when logged out.
        this.view = { ...this.view };
        this.emit();
        if (this.client.getGameState() !== GameState.LOGGED_IN) return;
        this.updateQuestList();
    }

    onGameTick(_event: GameTick): void {
        this.updateQuestList();
    }

    /** Reads every quest's state and the player's level for each requirement. */
    updateQuestList(): void {
        try {
            for (const quest of Quest.values()) {
                const info = this.infoMap.get(quest.getName());
                if (info) info.questState = quest.getState(this.client);
            }
        } catch {
            // A script is running or the cache isn't loaded: try again next tick.
            return;
        }
        const rows = this.infos.map((info) => ({
            info: { ...info },
            levels: info.reqs.map((requirement) => playerLevel(this.client, requirement)),
        }));
        this.setView({ updated: true, rows });
    }

    getView(): GuideView {
        return this.view;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Publishes a new view only when a state or level changed, not every tick. */
    private setView(view: GuideView): void {
        const key = JSON.stringify([view.updated, view.rows.map((row) => [row.info.questState, row.levels])]);
        if (key === this.viewKey) return;
        this.viewKey = key;
        this.view = view;
        this.emit();
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (err) {
                console.log("[optimal-quest-guide] listener failed", err);
            }
        }
    }
}
