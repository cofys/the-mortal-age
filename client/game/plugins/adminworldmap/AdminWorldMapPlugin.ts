import { ClientToolbar } from "@runelite/client/ui/ClientToolbar";
import { NavigationButton } from "@runelite/client/ui/NavigationButton";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { inject } from "@runelite/client/plugins/PluginInjector";

import { subscribeHandshake } from "../../network/ServerConnection";
import { fetchContent } from "../../network/serverConnection/contentApi";
import { state as connectionState } from "../../network/serverConnection/state";

/**
 * Sidebar tab tooltip. Kept as a const so other UI can reference it.
 */
export const ADMIN_WORLD_MAP_TOOLTIP = "World Map (Admin)";

function WorldMapIcon({ label }: { label: string }): JSX.Element {
    return (
        <svg className="rl-sidebar-icon-svg" viewBox="0 0 24 24" role="img" aria-label={label}>
            <circle cx="12" cy="12" r="9" />
            <path d="M3.5 9.5h17M3.5 14.5h17M12 3.5c-4.5 4.2-4.5 12.8 0 17M12 3.5c4.5 4.2 4.5 12.8 0 17" />
        </svg>
    );
}

/**
 * Admin World Map sidebar button (Jon, 2026-10-12): "admin map/menu is not on
 * my sidebar?" — the map was previously only reachable via ::worldmap.
 *
 * Admin-only: the button is added/removed reactively based on the handshake's
 * isAdmin flag. The server endpoint is the authority (it returns {open:false}
 * for non-admins), so this is defense-in-depth, not the security boundary.
 *
 * Clicking the button calls action=open on the admin-worldmap endpoint, which
 * sets the adminworldmap:open attribute — the AdminWorldMapOverlay polls for
 * it and renders. No sidebar panel; the overlay is full-screen.
 */
export class AdminWorldMapPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Admin World Map",
        description: "Live admin world map: all citizens, teleport tools.",
        tags: ["admin", "map", "citizens"],
        configKey: "adminworldmapplugin",
    };

    private readonly clientToolbar = inject(ClientToolbar);
    private navButton?: NavigationButton;
    private unsubscribeHandshake?: () => void;

    protected async startUp(): Promise<void> {
        this.unsubscribeHandshake = subscribeHandshake(({ chatIcons, isAdmin }) => {
            const admin =
                typeof isAdmin === "boolean"
                    ? isAdmin
                    : Array.isArray(chatIcons) && chatIcons.includes(1);
            if (admin) {
                this.addButton();
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

    private addButton(): void {
        if (this.navButton) return;
        this.navButton = NavigationButton.builder()
            .tooltip(ADMIN_WORLD_MAP_TOOLTIP)
            .icon(WorldMapIcon)
            .priority(2)
            .onClick(() => void this.openMap())
            .build();
        this.clientToolbar.addNavigation(this.navButton);
    }

    private removeButton(): void {
        if (this.navButton) this.clientToolbar.removeNavigation(this.navButton);
        this.navButton = undefined;
    }

    private async openMap(): Promise<void> {
        const username = connectionState.sessionUsername;
        if (!username) return;
        try {
            await fetchContent(
                `/api/admin-worldmap?player=${encodeURIComponent(username)}&action=open`,
            );
        } catch {
            // Overlay poll will retry; server gates non-admins anyway.
        }
    }
}
