import { GameState } from "@runelite/api/GameState";
import type { GameStateChanged, PluginMessage } from "@runelite/api/events";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import type { OsrsClient } from "../../OsrsClient";

// Cache 2776 rebuilds the reward rows under 243:3 whenever a selection, level or points changes.
const REWARD_ROWS_UID = (243 << 16) | 3;
const DRAW_REWARDS_SCRIPT = 2776;

export class PestControlPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Pest Control",
        description: "Shows the world's Pest Control experience rewards.",
        hidden: true,
        configKey: "pestcontrolplugin",
    };

    private readonly client = inject<OsrsClient>(CLIENT_TOKEN);
    private experience: Record<string, number> = {};

    onPluginMessage(event: PluginMessage): void {
        if (event.channel !== "pest-control") return;
        const values = event.data.xpPerPoint;
        if (!values || typeof values !== "object" || Array.isArray(values)) return;
        this.experience = Object.fromEntries(Object.entries(values).filter(([, xp]) =>
            typeof xp === "number" && Number.isFinite(xp) && xp >= 0));
        this.updateRewards();
    }

    onGameStateChanged(event: GameStateChanged): void {
        if (event.getGameState() !== GameState.LOGGED_IN) this.experience = {};
    }

    onScriptFinished(scriptId: number): void {
        if (scriptId === DRAW_REWARDS_SCRIPT) this.updateRewards();
    }

    private updateRewards(): void {
        const manager = this.client.widgetManager;
        if (!manager?.getWidgetByUid(REWARD_ROWS_UID)) return;
        for (const widget of manager.getDynamicChildrenByParent(REWARD_ROWS_UID)) {
            const row = /^(.+) - [\d.]+ XP$/.exec(widget.text ?? "");
            if (!row) continue;
            const xp = this.experience[row[1]];
            if (xp === undefined) continue;
            const text = `${row[1]} - ${xp} XP`;
            if (text === widget.text) continue;
            widget.text = text;
            manager.invalidateWidgetRender(widget, "pest-control");
        }
    }
}
