import { ClientToolbar } from "@runelite/client/ui/ClientToolbar";
import { NavigationButton } from "@runelite/client/ui/NavigationButton";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { inject } from "@runelite/client/plugins/PluginInjector";

import { MyKingdomPanel } from "./MyKingdomPanel";

/**
 * Sidebar tab tooltip. The Town crier overlay reads this too, so it can stand
 * down while the tab owns the panel instead of rendering the same content twice.
 */
export const MY_KINGDOM_TOOLTIP = "My Kingdom";

function CrownIcon({ label }: { label: string }): JSX.Element {
    return (
        <svg className="rl-sidebar-icon-svg" viewBox="0 0 24 24" role="img" aria-label={label}>
            <path d="M3 8.5 7 11l5-6.5L17 11l4-2.5L19.5 18h-15L3 8.5z" />
            <path d="M7.5 14.5h9" />
        </svg>
    );
}

/**
 * The Mortal Age's My Kingdom sidebar tab: your kingdom, standing, the oath,
 * realm news and the other great powers, one click away. Same endpoint and
 * content as the Town crier overlay — the tab is just a second door to it.
 */
export class MyKingdomPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "My Kingdom",
        description: "Your kingdom: standing, realm news, and the other great powers.",
        tags: ["kingdom"],
        configKey: "mykingdomplugin",
    };

    private readonly clientToolbar = inject(ClientToolbar);
    private navButton?: NavigationButton;

    protected async startUp(): Promise<void> {
        this.navButton = NavigationButton.builder()
            .tooltip(MY_KINGDOM_TOOLTIP)
            .icon(CrownIcon)
            .priority(1)
            .panel(() => <MyKingdomPanel />)
            .build();
        this.clientToolbar.addNavigation(this.navButton);
    }

    protected async shutDown(): Promise<void> {
        if (this.navButton) this.clientToolbar.removeNavigation(this.navButton);
        this.navButton = undefined;
    }
}
