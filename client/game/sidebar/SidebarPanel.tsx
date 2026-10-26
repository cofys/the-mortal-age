import type { NavigationButton } from "@runelite/client/ui/NavigationButton";

/**
 * The open panel. RuneLite draws no header or close button: the panel is the plugin's
 * content, and clicking its icon again (or Ctrl+F12) closes it.
 */
export function SidebarPanel({ button }: { button: NavigationButton }): JSX.Element | null {
    const Panel = button.panel;
    if (!Panel) return null;
    return (
        <section className="rl-sidebar-panel" aria-label={button.tooltip}>
            <div className="rl-sidebar-panel-body">
                <Panel />
            </div>
        </section>
    );
}
