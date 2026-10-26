/*
 * Copyright (c) 2020, Christopher Oswald <https://github.com/cesoun>
 * All rights reserved.
 *
 * Ported to TypeScript. BSD 2-Clause License, see ./LICENSE.
 */
import { useCallback, useEffect, useState, useSyncExternalStore, type MouseEvent } from "react";

import { NavigationButton } from "@runelite/client/ui/NavigationButton";
import type { GuidePlugin } from "./GuidePlugin";
import { cssColor, questNameColor, requirementColor, visibleRows, type QuestRow } from "./GuideView";
import { requirementIcon } from "./QuestInfo";

type Menu = { x: number; y: number; uri: string } | undefined;

/** A quest scroll with ticks, drawn like the other sidebar icons. */
function GuideIcon({ label }: { label: string }): JSX.Element {
    return (
        <svg className="rl-sidebar-icon-svg" viewBox="0 0 24 24" role="img" aria-label={label}>
            <path d="M6.5 3.5h11a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z" />
            <path d="M7.5 8l1.2 1.2 2.1-2.4M7.5 13l1.2 1.2 2.1-2.4M13 8h4M13 13h4M8 17.5h9" />
        </svg>
    );
}

/** RuneLite's LinkBrowser.browse. */
function openWiki(uri: string): void {
    window.open(uri, "_blank", "noopener,noreferrer");
}

/** QuestPanel: the quest's name, coloured by state, over its requirements five to a row. */
function QuestPanel({
    plugin,
    row,
    openMenu,
}: {
    plugin: GuidePlugin;
    row: QuestRow;
    openMenu: (event: MouseEvent, uri: string) => void;
}): JSX.Element {
    const { config } = plugin;
    const { info } = row;
    return (
        <div className="rl-oqg-quest" onContextMenu={(event) => openMenu(event, info.uri)}>
            <div className="rl-oqg-quest-name" style={{ color: cssColor(questNameColor(info.questState, config)) }}>
                {info.name}
            </div>
            {info.reqs.length > 0 ? (
                <div className="rl-oqg-reqs">
                    {info.reqs.map((requirement, i) => {
                        const icon = requirementIcon(requirement);
                        const color = requirementColor(requirement, row.levels[i], config);
                        return (
                            <div className="rl-oqg-req" key={requirement.skill} title={requirement.skill}>
                                <span className="rl-oqg-req-icon">
                                    {icon ? <img src={icon} alt={requirement.skill} draggable={false} /> : null}
                                </span>
                                <span className="rl-oqg-req-level" style={{ color: cssColor(color) }}>
                                    {requirement.level}
                                </span>
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
}

/** The JPopupMenu with "Open Wiki Guide". */
function PopupMenu({ menu, close }: { menu: Menu; close: () => void }): JSX.Element | null {
    useEffect(() => {
        if (!menu) return;
        window.addEventListener("mousedown", close);
        return () => window.removeEventListener("mousedown", close);
    }, [menu, close]);
    if (!menu) return null;
    return (
        <div className="rl-oqg-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
            <div
                className="rl-oqg-menu-item"
                role="menuitem"
                onMouseDown={(event) => {
                    event.stopPropagation();
                    close();
                    openWiki(menu.uri);
                }}
            >
                Open Wiki Guide
            </div>
        </div>
    );
}

/** GuidePanel: a heading, the search bar, and the quests in the guide's order. */
export function GuidePanel({ plugin }: { plugin: GuidePlugin }): JSX.Element {
    const subscribe = useCallback((listener: () => void) => plugin.subscribe(listener), [plugin]);
    const getSnapshot = useCallback(() => plugin.getView(), [plugin]);
    const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const [search, setSearch] = useState("");
    const [menu, setMenu] = useState<Menu>();
    const close = useCallback(() => setMenu(undefined), []);
    const openMenu = useCallback((event: MouseEvent, uri: string) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY, uri });
    }, []);

    const rows = visibleRows(view, plugin.config, search);

    return (
        <div className="rl-sidebar-scrollable rl-oqg-panel">
            <div className="rl-oqg-heading">
                <div className="rl-oqg-heading-title">Optimal Quest Guide</div>
                <div className="rl-oqg-heading-copy">
                    {view.updated ? "Happy questing." : "Quests will adjust after login."}
                </div>
            </div>
            <input
                type="search"
                className="rl-plugin-search rl-oqg-search"
                value={search}
                placeholder="Search quests"
                aria-label="Search quests"
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Escape" && search) {
                        event.stopPropagation();
                        setSearch("");
                    }
                }}
            />
            {rows.map((row) => (
                <QuestPanel key={row.info.name} plugin={plugin} row={row} openMenu={openMenu} />
            ))}
            <PopupMenu menu={menu} close={close} />
        </div>
    );
}

/** The sidebar button, at the plugin's priority. */
export function createGuideNavigationButton(plugin: GuidePlugin): NavigationButton {
    return NavigationButton.builder()
        .tooltip("Optimal Quest Guide")
        .icon(GuideIcon)
        .priority(7)
        .panel(() => <GuidePanel plugin={plugin} />)
        .build();
}
