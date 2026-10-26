import { runeliteImage } from "@runelite/client/ui/runeliteImages";

/**
 * One row of the plugin hub, as RuneLite's `PluginListItem` draws it: a pin star, the name (its
 * description only in the tooltip), a settings cog and an on/off switch.
 */
export interface PluginListItemProps {
    name: string;
    description?: string;
    failure?: string;
    /** Absent for rows that can't be pinned (the client's own settings, always first). */
    pinned?: boolean;
    onPin?: (pinned: boolean) => void;
    /** Absent for rows that can't be turned off (the client's own settings). */
    enabled?: boolean;
    onToggle?: (enabled: boolean) => void;
    /** Absent when there are no settings: no cog, and the name isn't a button. */
    onOpenConfig?: () => void;
}

/** RuneLite's tooltip: "<html>Name:<br>Description</html>". */
function tooltip(name: string, description?: string): string {
    return description ? `${name}:\n${description}` : name;
}

export function PluginListItem({
    name,
    description,
    failure,
    pinned,
    onPin,
    enabled,
    onToggle,
    onOpenConfig,
}: PluginListItemProps): JSX.Element {
    const off = enabled === false;
    const title = tooltip(name, description);
    return (
        <div className="rl-plugin-item">
            <div className="rl-plugin-item-row">
                {onPin ? (
                    <button
                        type="button"
                        className={`rl-plugin-item-pin${pinned ? " on" : ""}`}
                        aria-pressed={pinned === true}
                        aria-label={`${pinned ? "Unpin" : "Pin"} ${name}`}
                        title={pinned ? "Unpin plugin" : "Pin plugin"}
                        onClick={() => onPin(!pinned)}
                    >
                        <img src={runeliteImage("star_on.png")} alt="" width={18} height={18} />
                    </button>
                ) : (
                    <span className="rl-plugin-item-pin" aria-hidden="true" />
                )}
                {onOpenConfig ? (
                    <button
                        type="button"
                        className="rl-plugin-item-name"
                        onClick={onOpenConfig}
                        title={title}
                    >
                        {name}
                    </button>
                ) : (
                    <span className="rl-plugin-item-name" title={title}>
                        {name}
                    </span>
                )}
                <span className="rl-plugin-item-buttons">
                    {onOpenConfig ? (
                        <button
                            type="button"
                            className="rl-plugin-item-cog"
                            onClick={onOpenConfig}
                            aria-label={`${name} settings`}
                            title="Edit plugin configuration"
                        >
                            <img
                                src={runeliteImage("config_edit_icon.png")}
                                alt=""
                                width={18}
                                height={18}
                            />
                        </button>
                    ) : (
                        <span aria-hidden="true" />
                    )}
                    {onToggle ? (
                        <button
                            type="button"
                            role="switch"
                            aria-checked={!off}
                            aria-label={`${off ? "Enable" : "Disable"} ${name}`}
                            title={off ? "Enable plugin" : "Disable plugin"}
                            className={`rl-switch${off ? "" : " on"}`}
                            onClick={() => onToggle(off)}
                        >
                            <img
                                src={runeliteImage("switcher_on.png")}
                                alt=""
                                width={25}
                                height={15}
                            />
                        </button>
                    ) : (
                        <span aria-hidden="true" />
                    )}
                </span>
            </div>
            {failure ? <span className="rl-plugin-item-failure">Failed: {failure}</span> : null}
        </div>
    );
}
