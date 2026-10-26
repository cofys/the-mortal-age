import { ConfigManager } from "../../config/ConfigManager";
import { ClientToolbar } from "../../ui/ClientToolbar";
import { NavigationButton } from "../../ui/NavigationButton";
import { imageIcon, runeliteImage } from "../../ui/runeliteImages";
import { PluginListPanel } from "../../ui/plugin/PluginListPanel";
import { Plugin, type PluginDescriptor } from "../Plugin";
import { inject } from "../PluginInjector";
import { PluginManager } from "../PluginManager";
import { onConfigurationRequest } from "./configurationRequests";

/**
 * RuneLite's Configuration plugin: always on and not listed itself, it puts the plugin hub
 * (every plugin with its switch and settings) behind the first sidebar button.
 */
export class ConfigPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Configuration",
        hidden: true,
        configKey: "configplugin",
    };

    private readonly clientToolbar = inject(ClientToolbar);
    private readonly pluginManager = inject(PluginManager);
    private readonly configManager = inject(ConfigManager);
    private navButton?: NavigationButton;
    private unsubscribeRequests?: () => void;

    protected async startUp(): Promise<void> {
        const pluginManager = this.pluginManager;
        const configManager = this.configManager;
        this.navButton = NavigationButton.builder()
            .tooltip("Configuration")
            .icon(imageIcon(runeliteImage("config_icon.png")))
            .priority(0)
            .panel(() => (
                <PluginListPanel pluginManager={pluginManager} configManager={configManager} />
            ))
            .build();
        this.clientToolbar.addNavigation(this.navButton);
        // "Configure ..." entries: show this panel; it opens the requested plugin's settings.
        this.unsubscribeRequests = onConfigurationRequest(() => {
            if (this.navButton) this.clientToolbar.openPanel(this.navButton);
        });
    }

    protected async shutDown(): Promise<void> {
        this.unsubscribeRequests?.();
        this.unsubscribeRequests = undefined;
        if (this.navButton) this.clientToolbar.removeNavigation(this.navButton);
        this.navButton = undefined;
    }
}
