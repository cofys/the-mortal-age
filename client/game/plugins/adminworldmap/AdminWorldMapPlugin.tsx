import { ClientToolbar } from "@runelite/client/ui/ClientToolbar";
import { NavigationButton } from "@runelite/client/ui/NavigationButton";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { inject } from "@runelite/client/plugins/PluginInjector";

import { subscribeHandshake } from "../../../network/ServerConnection";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { state as connectionState } from "../../../network/serverConnection/state";

function WorldMapIcon({ label, on }: { label: string; on: boolean }): JSX.Element {
    return (
        <svg className="rl-sidebar-icon-svg" viewBox="0 0 24 24" role="img" aria-label={label}>
            <circle cx="12" cy="12" r="9" fill={on ? "currentColor" : "none"} opacity={on ? 0.35 : 1} />
            <path d="M3.5 9.5h17M3.5 14.5h17M12 3.5c-4.5 4.2-4.5 12.8 0 17M12 3.5c4.5 4.2 4.5 12.8 0 17" />
        </svg>
    );
}

/**
 * Citizen layer toggle for the game's world map (Jon, 2026-10-12):
 * "Why didn't you just use the map already in the game, and add an overlay
 * to it?"
 *
 * The old full-screen admin overlay is gone. Citizen dots now render on the
 * game's own world map (streamed by WorldMapPlayers.plugin.js); right-click a
 * dot for Teleport / Pause brain. This sidebar button toggles the citizen
 * layer on/off per admin (server attribute worldmap:citizen-layer, default
 * on). Open the world map itself with the game's map button or ::worldmap.
 *
 * Admin-only: the button is added/removed reactively based on the handshake's
 * isAdmin flag. The server endpoint is the authority, so this is
 * defense-in-depth, not the security boundary.
 */
export class AdminWorldMapPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Admin World Map",
        description: "Citizen layer toggle for the world map.",
        tags: ["admin", "map", "citizens"],
        configKey: "adminworldmapplugin",
    };

    private readonly clientToolbar = inject(ClientToolbar);
    private navButton?: NavigationButton;
    private unsubscribeHandshake?: () => void;
    private layerOn = true;

    protected async startUp(): Promise<void> {
        this.unsubscribeHandshake = subscribeHandshake(({ chatIcons, isAdmin }) => {
            const admin =
                typeof isAdmin === "boolean"
                    ? isAdmin
                    : Array.isArray(chatIcons) && chatIcons.includes(1);
            if (admin) {
                void this.refreshLayerState().then(() => this.addButton());
            } else {
                this.removeButton();
            }
        });
    }

    protected async shutDown(): Promise<void> {
        this.unsubscribeHandshake?.();
        this.unsubscribeHandshake = undefined;
        this.removeButton();
    }

    private tooltip(): string {
        return this.layerOn
            ? "Citizen map layer: ON — click to hide"
            : "Citizen map layer: OFF — click to show";
    }

    private addButton(): void {
        this.removeButton();
        const on = this.layerOn;
        this.navButton = NavigationButton.builder()
            .tooltip(this.tooltip())
            .icon(({ label }: { label: string }) => (
                <WorldMapIcon label={label} on={on} />
            ))
            .priority(2)
            .onClick(() => void this.toggleLayer())
            .build();
        this.clientToolbar.addNavigation(this.navButton);
    }

    private removeButton(): void {
        if (this.navButton) this.clientToolbar.removeNavigation(this.navButton);
        this.navButton = undefined;
    }

    private async apiCall(params: string): Promise<any> {
        const username = connectionState.sessionUsername;
        if (!username) return null;
        try {
            return await fetchContent(
                `/api/admin-worldmap?player=${encodeURIComponent(username)}${params}`,
            );
        } catch {
            return null;
        }
    }

    private async refreshLayerState(): Promise<void> {
        const data = await this.apiCall("&action=layer-state");
        if (data && typeof data.layer !== "undefined") {
            this.layerOn = (data.layer | 0) === 1;
        }
    }

    private async toggleLayer(): Promise<void> {
        const data = await this.apiCall(`&action=layer&enabled=${this.layerOn ? "0" : "1"}`);
        if (data && typeof data.layer !== "undefined") {
            this.layerOn = (data.layer | 0) === 1;
        } else {
            this.layerOn = !this.layerOn;
        }
        // Rebuild so the tooltip/icon reflect the new state.
        this.addButton();
    }
}
