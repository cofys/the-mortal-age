import { GameState } from "@runelite/api/GameState";
import type { GameStateChanged, StatChanged } from "@runelite/api/events";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { PluginManager } from "@runelite/client/plugins/PluginManager";
import { openConfiguration } from "@runelite/client/plugins/config/configurationRequests";
import { toRuneLiteGameState } from "../../../runelite/impl/GameStateMapping";
import { SKILL_IDS } from "../../../rs/skill/skills";
import type { OsrsClient } from "../../OsrsClient";
import { XpTrackerPlugin } from "../xptracker/XpTrackerPlugin";
import { XpGlobesConfig } from "./XpGlobesConfig";
import { XpGlobesOverlay } from "./XpGlobesOverlay";
import { XpGlobes, levelGoals, type XpGlobe, type XpTrackerNumbers } from "./xpGlobes";

/**
 * RuneLite 1.13.3 XP Globes: a globe per skill that gains experience, at the top centre of the
 * game view, with its progress to the next level (or XP-drop goal) and a tooltip on hover.
 * Goal and rate numbers come from the XP Tracker when it is running.
 */
export class XpGlobesPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "XP Globes",
        description: "Show XP globes for the respective skill when gaining XP",
        tags: ["experience", "levels", "overlay"],
        enabledByDefault: false,
        configKey: "xpglobesplugin",
    };

    static config = XpGlobesConfig;

    private readonly configManager = inject(ConfigManager);
    readonly config = this.configManager.getConfig(XpGlobesConfig);
    private readonly osrsClient: OsrsClient;
    private readonly pluginManager: PluginManager | undefined;
    readonly globes = new XpGlobes();
    readonly widgetOverlay: XpGlobesOverlay;
    /** Overridable wall clock. */
    now: () => number = () => Date.now();
    private timer?: ReturnType<typeof setInterval>;

    constructor(osrsClient?: OsrsClient) {
        super();
        this.osrsClient = osrsClient ?? inject<OsrsClient>(CLIENT_TOKEN);
        let manager: PluginManager | undefined;
        try {
            manager = inject(PluginManager);
        } catch {
            manager = undefined;
        }
        this.pluginManager = manager;
        this.widgetOverlay = new XpGlobesOverlay(this);
    }

    protected async startUp(): Promise<void> {
        this.timer = setInterval(() => this.removeExpiredXpGlobes(), 1000);
        (this.timer as any)?.unref?.();
    }

    protected async shutDown(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    onStatChanged(event: StatChanged): void {
        if (!SKILL_IDS.includes(event.getSkill())) return;
        this.globes.onStatChanged(event.getSkill(), event.getXp(), event.getLevel(), this.now(), {
            hideMaxed: this.config.hideMaxed() === true,
            showVirtualLevel: this.config.showVirtualLevel() === true,
        });
    }

    onGameStateChanged(event: GameStateChanged): void {
        const state = event.getGameState();
        if (state === GameState.HOPPING || state === GameState.LOGGING_IN) this.globes.reset();
    }

    removeExpiredXpGlobes(): void {
        this.globes.expire(this.now(), Number(this.config.xpOrbDuration()) || 0);
    }

    getClient(): OsrsClient {
        return this.osrsClient;
    }

    isLoggedIn(): boolean {
        return toRuneLiteGameState((this.osrsClient as any)?.gameState) === GameState.LOGGED_IN;
    }

    /** The running XP Tracker (RuneLite's XpTrackerService), if any. */
    private tracker(): XpTrackerPlugin | undefined {
        const tracker = this.pluginManager?.getPlugin(XpTrackerPlugin);
        return tracker?.isStarted() ? tracker : undefined;
    }

    /** The globe's goal range: the XP Tracker's, else this level to the next. */
    goals(globe: XpGlobe): { start: number; end: number } {
        const tracker = this.tracker();
        if (tracker?.getSkillSnapshot(globe.skill)) {
            return { start: tracker.getStartGoalXp(globe.skill), end: tracker.getEndGoalXp(globe.skill) };
        }
        return levelGoals(globe.currentXp);
    }

    trackerNumbers(globe: XpGlobe): XpTrackerNumbers | undefined {
        const tracker = this.tracker();
        if (!tracker?.getSkillSnapshot(globe.skill)) return undefined;
        return {
            actionsLeft: tracker.getActionsLeft(globe.skill),
            xpHr: tracker.getXpHr(globe.skill),
            timeTilGoal: tracker.getTimeTilGoal(globe.skill),
        };
    }

    /** The overlay's "Flip": rows become columns (RuneLite's alignOrbsVertically). */
    flip(): void {
        this.configManager.setConfigValue(XpGlobesConfig, "alignOrbsVertically", !this.config.alignOrbsVertically());
    }

    openSettings(): void {
        openConfiguration(XpGlobesPlugin);
    }
}
