import { ClientToolbar } from "@runelite/client/ui/ClientToolbar";
import { NavigationButton } from "@runelite/client/ui/NavigationButton";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { inject } from "@runelite/client/plugins/PluginInjector";

import { WarTablePanel } from "./WarTablePanel";

/**
 * Sidebar tab tooltip. The war table overlay reads this too, so it can stand
 * down while the tab owns the panel instead of rendering the same content twice.
 */
export const WAR_COUNCIL_TOOLTIP = "War Council";

function CrossedSwordsIcon({ label }: { label: string }): JSX.Element {
    return (
        <svg className="rl-sidebar-icon-svg" viewBox="0 0 24 24" role="img" aria-label={label}>
            <path d="M4 4l10.5 10.5" />
            <path d="M11.5 17.5l5-5" />
            <path d="M14.5 14.5L18 18" />
            <path d="M20 4L9.5 14.5" />
            <path d="M12.5 17.5l-5-5" />
            <path d="M9.5 14.5L6 18" />
        </svg>
    );
}

/**
 * The Mortal Age's War Council sidebar tab: the campaign map, the realm's
 * wars and diplomacy, and the council's declare-war / declare-siege orders.
 * Same endpoint and content as the in-world war table overlay — the tab is
 * just a second door to it.
 */
export class WarTablePlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "War Council",
        description: "The war table: wars, diplomacy, sieges, and the council's orders.",
        tags: ["kingdom", "war"],
        configKey: "warcouncilplugin",
    };

    private readonly clientToolbar = inject(ClientToolbar);
    private navButton?: NavigationButton;

    protected async startUp(): Promise<void> {
        this.navButton = NavigationButton.builder()
            .tooltip(WAR_COUNCIL_TOOLTIP)
            .icon(CrossedSwordsIcon)
            .priority(3)
            .panel(() => <WarTablePanel />)
            .build();
        this.clientToolbar.addNavigation(this.navButton);
    }

    protected async shutDown(): Promise<void> {
        if (this.navButton) this.clientToolbar.removeNavigation(this.navButton);
        this.navButton = undefined;
    }
}
