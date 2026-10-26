import React, { useCallback, useState, useSyncExternalStore } from "react";
import { NavigationButton } from "@runelite/client/ui/NavigationButton";
import { imageIcon, runeliteImage } from "@runelite/client/ui/runeliteImages";
import { customPackError, isCustomPack, type TilePack } from "./tilePackData";
import type { TilePacksPlugin } from "./TilePacksPlugin";

/** RuneLite's ColorScheme, as the sidebar panels use it. */
const DARK_GRAY = "rgb(40, 40, 40)";
const DARKER_GRAY = "rgb(30, 30, 30)";
const DARK_GRAY_HOVER = "rgb(35, 35, 35)";
/** FontManager.getRunescapeFont(), the panels' default (Sidebar.css's variables). */
const FONT = "var(--rl-font)";
/** Tile Packs' icon colours. */
const GREY = "#858585";
const GREEN = "#4CAF50";
const RED = "#E31C1C";
const WHITE = "#ffffff";

const GITHUB_LINK = "https://github.com/TrevorMDev/tile-packs?tab=readme-ov-file#tile-packs";
const DISCORD_LINK = "https://discord.gg/4EQRWxY3Wb";

type IconName = "add" | "remove" | "visible" | "invisible" | "copy" | "delete" | "help" | "youtube" | "discord" | "question";

/** The plugin's 20x20 icons, redrawn (its PNGs are Flaticon artwork, not under its licence). */
function Icon({ name, color }: { name: IconName; color: string }): JSX.Element {
    const stroke = { fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
    const body = (() => {
        switch (name) {
            case "add":
                return <><circle cx="10" cy="10" r="8" {...stroke} /><path d="M10 6v8M6 10h8" {...stroke} /></>;
            case "remove":
                return <><circle cx="10" cy="10" r="8" {...stroke} /><path d="M6 10h8" {...stroke} /></>;
            case "visible":
                return <><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6S1.5 10 1.5 10Z" {...stroke} /><circle cx="10" cy="10" r="2.5" {...stroke} /></>;
            case "invisible":
                return <><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6S1.5 10 1.5 10Z" {...stroke} /><path d="M3 17 17 3" {...stroke} /></>;
            case "copy":
                return <><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" {...stroke} /><path d="M13.5 3.5h-9a1.5 1.5 0 0 0-1.5 1.5v9" {...stroke} /></>;
            case "delete":
                return <><path d="M3 5h14M8 5V3h4v2M5 5l1 12h8l1-12M8.5 8.5v5M11.5 8.5v5" {...stroke} /></>;
            case "youtube":
                return <><rect x="1.5" y="4" width="17" height="12" rx="3.5" fill={color} /><path d="M8.3 7.3v5.4l4.6-2.7Z" fill={DARKER_GRAY} /></>;
            case "discord":
                return <><path d="M4.5 5.2C6.2 4.3 8 4 10 4s3.8.3 5.5 1.2c1.4 2.2 2 4.6 1.9 7.4-1.4 1.1-2.8 1.8-4.3 2.2l-.9-1.5c-1.4.4-3 .4-4.4 0l-.9 1.5c-1.5-.4-2.9-1.1-4.3-2.2-.1-2.8.5-5.2 1.9-7.4Z" fill={color} /><circle cx="7.4" cy="10.3" r="1.3" fill={DARKER_GRAY} /><circle cx="12.6" cy="10.3" r="1.3" fill={DARKER_GRAY} /></>;
            case "help":
            case "question":
                return <><circle cx="10" cy="10" r="8" {...stroke} /><path d="M7.7 7.6a2.4 2.4 0 1 1 3.4 2.2c-.7.3-1.1.9-1.1 1.6v.4" {...stroke} /><circle cx="10" cy="14.5" r=".6" fill={color} stroke={color} /></>;
        }
    })();
    return <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">{body}</svg>;
}

/** A clickable icon that fades on hover, as the plugin's labels do (alphaOffset 0.5). */
function IconButton({ icon, color, hoverColor, title, onClick }: {
    icon: IconName;
    color: string;
    hoverColor?: string;
    title: string;
    onClick: () => void;
}): JSX.Element {
    const [hover, setHover] = useState(false);
    return (
        <button
            type="button"
            title={title}
            aria-label={title}
            onClick={onClick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            style={{
                width: 20, height: 20, padding: 0, border: "none", background: "none", cursor: "pointer",
                opacity: hover && !hoverColor ? 0.5 : 1,
            }}
        >
            <Icon name={icon} color={hover && hoverColor ? hoverColor : color} />
        </button>
    );
}

const blank = <span style={{ display: "inline-block", width: 20, height: 20 }} />;

function linkIcon(link: string): IconName {
    if (link.includes("youtube.com") || link.includes("youtu.be")) return "youtube";
    if (link.includes("discord.gg")) return "discord";
    return "help";
}

function open(link: string): void {
    window.open(link, "_blank", "noopener,noreferrer");
}

/** TilePackPanel: the pack's name over its controls. */
function TilePackRow({ plugin, pack }: { plugin: TilePacksPlugin; pack: TilePack }): JSX.Element {
    const enabled = plugin.store.isPackEnabled(pack.id);
    return (
        <div style={{ padding: "3px 2px" }}>
            <div style={{ background: DARKER_GRAY, padding: "2px 4px 1px", fontFamily: FONT, color: WHITE }}>
                {pack.packName}
            </div>
            <div style={{
                background: DARKER_GRAY, borderTop: `1px solid ${DARK_GRAY}`, display: "flex",
                justifyContent: "flex-end", gap: 4, padding: "6px 4px",
            }}>
                {isCustomPack(pack) ? (
                    <IconButton icon="delete" color={RED} title="Delete this custom pack, this is permanent" onClick={() => {
                        if (window.confirm("Are you sure you want to delete this pack?")) plugin.removeCustomPack(pack);
                    }} />
                ) : blank}
                <IconButton
                    icon={pack.visible ? "visible" : "invisible"}
                    color={GREY}
                    title={pack.visible ? "Hide pack from list without deleting" : "Show tile pack in main list"}
                    onClick={() => plugin.toggleVisible(pack)}
                />
                <IconButton icon="copy" color={GREY} title="Copy tiles of pack to clipboard" onClick={() => void plugin.copyTiles(pack)} />
                {pack.link ? (
                    <IconButton icon={linkIcon(pack.link)} color={GREY} title="Click to open source of pack in browser" onClick={() => open(pack.link!)} />
                ) : blank}
                <IconButton
                    icon={enabled ? "remove" : "add"}
                    color={enabled ? RED : GREEN}
                    title={enabled ? "Remove tiles" : "Add tiles"}
                    onClick={() => plugin.togglePack(pack)}
                />
            </div>
        </div>
    );
}

/** VisibleHeaderLabel / InvisibleHeaderLabel: white when on, the icon's grey when off. */
function FilterToggle({ icon, on, title, onToggle }: { icon: IconName; on: boolean; title: string; onToggle: () => void }): JSX.Element {
    return <IconButton icon={icon} color={on ? WHITE : GREY} hoverColor={on ? "rgba(255,255,255,0.5)" : undefined} title={title} onClick={onToggle} />;
}

const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", height: 30, padding: "0 8px", border: "none",
    background: DARKER_GRAY, color: WHITE, outline: "none",
};

/** CustomPackManagerPanel: add a pack from pasted ground marker JSON. */
function CustomPackForm({ plugin }: { plugin: TilePacksPlugin }): JSX.Element {
    const [name, setName] = useState("");
    const [tiles, setTiles] = useState("");
    const [error, setError] = useState<string>();
    const add = () => {
        const problem = customPackError(name, tiles);
        setError(problem);
        if (!problem) plugin.addCustomPack(name, tiles);
    };
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 0" }}>
            <label style={{ color: WHITE }}>
                Custom Pack Name
                <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} aria-label="Custom Pack Name" />
            </label>
            <label style={{ color: WHITE }}>
                Custom Pack Tiles
                <input style={inputStyle} value={tiles} onChange={(e) => setTiles(e.target.value)} aria-label="Custom Pack Tiles" />
            </label>
            {error ? <div role="alert" style={{ color: RED }}>{error}</div> : null}
            <button type="button" onClick={add} style={{ height: 30, background: DARK_GRAY_HOVER, color: WHITE, border: `1px solid ${DARK_GRAY}`, cursor: "pointer" }}>
                Add Pack
            </button>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 4px 1px" }}>
                <span style={{ color: WHITE }}>Got cool tiles? Share in discord!</span>
                <IconButton icon="discord" color={GREY} title="Click to join the Tile Packs discord" onClick={() => open(DISCORD_LINK)} />
            </div>
        </div>
    );
}

/** TilePacksListPanel: the header (search and filters), the packs, then the custom pack form. */
export function TilePacksPanel({ plugin }: { plugin: TilePacksPlugin }): JSX.Element {
    const subscribe = useCallback((listener: () => void) => plugin.subscribe(listener), [plugin]);
    const version = useCallback(() => plugin.getVersion(), [plugin]);
    useSyncExternalStore(subscribe, version, version);
    const [search, setSearch] = useState("");
    const store = plugin.store;
    const needle = search.toLowerCase();
    const packs = [...store.tilePacks.values()]
        .sort((a, b) => a.id - b.id)
        .filter((pack) => !needle || (pack.packName ?? "").toLowerCase().includes(needle))
        .filter((pack) => (store.showVisible && pack.visible) || (store.showInvisible && !pack.visible));

    return (
        <div className="rl-sidebar-panel-content" style={{ display: "flex", flexDirection: "column", overflowY: "auto" }}>
            <div>
                <input
                    type="search"
                    className="rl-plugin-search"
                    style={{ margin: 0, width: "100%", boxSizing: "border-box", height: 30 }}
                    value={search}
                    placeholder="Search"
                    aria-label="Search tile packs"
                    onChange={(e) => setSearch(e.target.value)}
                />
                <div style={{
                    background: DARKER_GRAY, borderTop: `1px solid ${DARK_GRAY}`, display: "flex",
                    justifyContent: "space-between", alignItems: "center", padding: "6px 8px 6px 4px",
                }}>
                    <div style={{ display: "flex", gap: 4 }}>
                        <FilterToggle icon="visible" on={store.showVisible} title="Show visible tile packs" onToggle={() => plugin.setShowVisible(!store.showVisible)} />
                        <FilterToggle icon="invisible" on={store.showInvisible} title="Show invisible packs" onToggle={() => plugin.setShowInvisible(!store.showInvisible)} />
                    </div>
                    <IconButton icon="question" color={GREY} title="Click for help with Tile Packs" onClick={() => open(GITHUB_LINK)} />
                </div>
            </div>
            <div>
                {packs.map((pack) => <TilePackRow key={pack.id} plugin={plugin} pack={pack} />)}
            </div>
            <CustomPackForm plugin={plugin} />
        </div>
    );
}

/** Tile Packs' nav button: "Tile Packs", priority 4. */
export function createTilePacksNavigationButton(plugin: TilePacksPlugin): NavigationButton {
    return NavigationButton.builder()
        .tooltip("Tile Packs")
        .icon(imageIcon(runeliteImage("tile_packs_icon.png")))
        .priority(4)
        .panel(() => <TilePacksPanel plugin={plugin} />)
        .build();
}
