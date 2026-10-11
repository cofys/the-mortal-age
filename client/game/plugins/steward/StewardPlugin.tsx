import { ClientToolbar } from "@runelite/client/ui/ClientToolbar";
import { NavigationButton } from "@runelite/client/ui/NavigationButton";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { inject } from "@runelite/client/plugins/PluginInjector";

import { StewardPanel } from "./StewardPanel";

/**
 * Sidebar tab tooltip. The steward's-desk overlay reads this too, so it can
 * stand down while the tab owns the panel instead of rendering twice.
 */
export const STEWARD_TOOLTIP = "Steward's Desk";

function StewardSealIcon({ label }: { label: string }): JSX.Element {
    return (
        <svg className="rl-sidebar-icon-svg" viewBox="0 0 24 24" role="img" aria-label={label}>
            <circle cx="12" cy="9" r="5" />
            <circle cx="12" cy="9" r="1.6" />
            <path d="M9.5 13.4L8 21l4-2 4 2-1.5-7.6" />
        </svg>
    );
}

/**
 * The Mortal Age's Steward's Desk sidebar tab: petitions, offices, standing,
 * renunciation, and naturalization at the player's own court. Same endpoint
 * and content as the in-world steward's-desk overlay — the tab is just a
 * second door to it.
 */
export class StewardPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Steward's Desk",
        description: "Petitions, offices, standing, and oaths at your court's desk.",
        tags: ["kingdom"],
        configKey: "stewardplugin",
    };

    private readonly clientToolbar = inject(ClientToolbar);
    private navButton?: NavigationButton;

    protected async startUp(): Promise<void> {
        this.navButton = NavigationButton.builder()
            .tooltip(STEWARD_TOOLTIP)
            .icon(StewardSealIcon)
            .priority(4)
            .panel(() => <StewardPanel />)
            .build();
        this.clientToolbar.addNavigation(this.navButton);
    }

    protected async shutDown(): Promise<void> {
        if (this.navButton) this.clientToolbar.removeNavigation(this.navButton);
        this.navButton = undefined;
    }
}
