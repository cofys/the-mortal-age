import { ClientToolbar } from "@runelite/client/ui/ClientToolbar";
import { NavigationButton } from "@runelite/client/ui/NavigationButton";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { inject } from "@runelite/client/plugins/PluginInjector";

import { StallsPanel } from "./StallsPanel";

/**
 * Sidebar tab tooltip. The marketplace overlay reads this too, so it can stand
 * down while the tab owns the panel instead of rendering the same content twice.
 */
export const STALLS_TOOLTIP = "Stalls";

function StallIcon({ label }: { label: string }): JSX.Element {
    return (
        <svg className="rl-sidebar-icon-svg" viewBox="0 0 24 24" role="img" aria-label={label}>
            <path d="M4 10 6.5 4.5h11L20 10" />
            <path d="M6.5 10v9" />
            <path d="M17.5 10v9" />
            <path d="M4.5 15h15" />
        </svg>
    );
}

/**
 * The Mortal Age's Stalls sidebar tab: the market board and your own stall —
 * lease, stock, prices, till, shop hand, and the sales feed. Same endpoint and
 * content as the in-game marketplace overlay — the tab is just a second door.
 */
export class StallsPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Stalls",
        description: "Your market stall: stock, prices, the till, and the market board.",
        tags: ["market"],
        configKey: "stallsplugin",
    };

    private readonly clientToolbar = inject(ClientToolbar);
    private navButton?: NavigationButton;

    protected async startUp(): Promise<void> {
        this.navButton = NavigationButton.builder()
            .tooltip(STALLS_TOOLTIP)
            .icon(StallIcon)
            .priority(2)
            .panel(() => <StallsPanel />)
            .build();
        this.clientToolbar.addNavigation(this.navButton);
    }

    protected async shutDown(): Promise<void> {
        if (this.navButton) this.clientToolbar.removeNavigation(this.navButton);
        this.navButton = undefined;
    }
}
