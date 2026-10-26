import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { NavigationButton } from "@runelite/client/ui/NavigationButton";
import { imageIcon, runeliteImage } from "@runelite/client/ui/runeliteImages";
import { IndexType } from "../../../rs/cache/IndexType";
import { OVERALL_ICON_SPRITE, skillIconSprite } from "../../../rs/skill/skillIcons";
import { MAX_XP, SKILL_NAME, getXpForLevel, type SkillId } from "../../../rs/skill/skills";
import { SpriteLoader } from "../../../rs/sprite/SpriteLoader";
import { spriteToCanvas } from "../../../ui/item/ItemIcon";
import type { OsrsClient } from "../../OsrsClient";
import { skillColorCss } from "./skillColor";
import { XP_PANEL_LABELS, type XpPanelLabel, type XpProgressBarLabel } from "./XpTrackerConfig";
import {
    isActionLabel,
    isCombatSkill,
    panelLabelValue,
    progressBarLabelValue,
    quantityToRSDecimalStack,
} from "./xpState";
import type { XpSkillView, XpTrackerPlugin } from "./XpTrackerPlugin";

/** RuneLite's ColorScheme, as the sidebar panels use it. */
const DARK_GRAY = "rgb(40, 40, 40)";
const DARKER_GRAY = "rgb(30, 30, 30)";
const LIGHT_GRAY = "rgb(165, 165, 165)";
const BAR_BACKGROUND = "rgb(61, 56, 49)";
/** FontManager.getRunescapeSmallFont(): RuneScape Small at 16 (Sidebar.css's variables). */
const FONT = "var(--rl-font-small)";
const FONT_SIZE = "var(--rl-font-size)";

type MenuItem = { label: string; run: () => void };
type MenuState = { x: number; y: number; items: MenuItem[] } | undefined;

const spriteUrls = new Map<number, string>();

/** A cache sprite as a data URL, decoded once. */
function useSpriteUrl(client: OsrsClient, id: number): string | undefined {
    const [url, setUrl] = useState(() => spriteUrls.get(id));
    useEffect(() => {
        if (url || !client?.cacheSystem) return;
        try {
            const index = client.cacheSystem.getIndex(IndexType.DAT2.sprites);
            const sprite = SpriteLoader.loadIntoIndexedSprite(index, id);
            if (!sprite) return;
            const data = spriteToCanvas(sprite).toDataURL();
            spriteUrls.set(id, data);
            setUrl(data);
        } catch {}
    }, [client, id, url]);
    return url;
}

function useView(plugin: XpTrackerPlugin) {
    const subscribe = useCallback((listener: () => void) => plugin.subscribe(listener), [plugin]);
    const snapshot = useCallback(() => plugin.getView(), [plugin]);
    return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** "Key: " in light gray and the value in white (RuneLite's htmlLabel). */
function Label({ name, value }: { name: string; value: string }): JSX.Element {
    if (!name) return <span />;
    return (
        <span style={{ color: LIGHT_GRAY, whiteSpace: "nowrap" }}>
            {name}
            <span style={{ color: "white" }}>{value}</span>
        </span>
    );
}

function PopupMenu({ menu, close }: { menu: MenuState; close: () => void }): JSX.Element | null {
    useEffect(() => {
        if (!menu) return;
        const onDown = () => close();
        window.addEventListener("mousedown", onDown);
        return () => window.removeEventListener("mousedown", onDown);
    }, [menu, close]);
    if (!menu) return null;
    return (
        <div
            role="menu"
            style={{
                position: "fixed", left: menu.x, top: menu.y, zIndex: 1000, background: DARKER_GRAY,
                border: "1px solid rgb(60, 60, 60)", padding: "2px 0", minWidth: 140, fontFamily: FONT,
            }}
        >
            {menu.items.map((item) => (
                <div
                    key={item.label}
                    role="menuitem"
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        close();
                        item.run();
                    }}
                    style={{ padding: "4px 10px", color: "white", cursor: "default" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgb(50, 50, 50)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                >
                    {item.label}
                </div>
            ))}
        </div>
    );
}

/** The panel's progress bar: skill colour, level labels, centre label and level markers. */
function ProgressBar({ plugin, view }: { plugin: XpTrackerPlugin; view: XpSkillView }): JSX.Element {
    const { snapshot, paused, skill } = view;
    const config = plugin.config;
    const progress = Math.max(0, Math.min(100, Math.trunc(snapshot.skillProgressToGoal)));
    const center = paused
        ? "Paused"
        : progressBarLabelValue(config.progressBarLabel() as XpProgressBarLabel, snapshot);
    const right = snapshot.endGoalXp === MAX_XP ? "200M" : `Lvl. ${snapshot.endLevel}`;
    const tooltipLabel = config.progressBarTooltipLabel() as XpProgressBarLabel;
    const tooltipValue = progressBarLabelValue(tooltipLabel, snapshot);
    const suffix = tooltipLabel === "PERCENTAGE" ? "of goal" : "till goal lvl";
    const tooltip = isCombatSkill(skill)
        ? `${tooltipValue} ${suffix}`
        : `${snapshot.actionsInSession} Actions done\n${snapshot.actionsPerHour} Actions/hr\n${tooltipValue} ${suffix}`;
    const markers: number[] = [];
    if (config.intermediateLevelMarkers() && snapshot.endLevel - snapshot.startLevel > 1) {
        const span = snapshot.endGoalXp - snapshot.startGoalXp;
        for (let level = snapshot.startLevel + 1; level <= snapshot.endLevel; level++) {
            markers.push(Math.trunc(((getXpForLevel(level) - snapshot.startGoalXp) / span) * 100));
        }
    }
    return (
        <div
            title={tooltip}
            style={{
                position: "relative", height: 16, background: BAR_BACKGROUND, opacity: paused ? 0.5 : 1,
                fontSize: FONT_SIZE, lineHeight: "16px", color: "white", textShadow: "1px 1px 0 black",
            }}
        >
            <div style={{ position: "absolute", inset: 0, width: `${progress}%`, background: skillColorCss(skill) }} />
            {markers.map((m) => (
                <div key={m} style={{ position: "absolute", top: 0, bottom: 0, left: `${m}%`, width: 1, background: "black" }} />
            ))}
            <span style={{ position: "absolute", left: 4 }}>Lvl. {snapshot.startLevel}</span>
            <span style={{ position: "absolute", left: 0, right: 0, textAlign: "center" }}>{center}</span>
            <span style={{ position: "absolute", right: 4 }}>{right}</span>
        </div>
    );
}

function InfoBox({
    plugin, view, openMenu, onDragStart, onDrop,
}: {
    plugin: XpTrackerPlugin;
    view: XpSkillView;
    openMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
    onDragStart: () => void;
    onDrop: () => void;
}): JSX.Element {
    const { skill, snapshot, compact } = view;
    const client = plugin.getClient();
    const icon = useSpriteUrl(client, skillIconSprite(skill));
    const config = plugin.config;
    const labels = [config.xpPanelLabel1(), config.xpPanelLabel2(), config.xpPanelLabel3(), config.xpPanelLabel4()]
        .map((label) => label as XpPanelLabel)
        .map((label) => (isCombatSkill(skill) && isActionLabel(label)
            ? { name: "", value: "" }
            : { name: `${XP_PANEL_LABELS[label]}: `, value: panelLabelValue(label, snapshot) }));
    const items: MenuItem[] = [
        { label: "Reset", run: () => plugin.resetSkillState(skill) },
        { label: "Reset others", run: () => plugin.resetOtherSkillState(skill) },
        { label: "Reset/hr", run: () => plugin.resetSkillPerHour(skill) },
        view.paused
            ? { label: "Unpause", run: () => plugin.pauseSkill(skill, false) }
            : { label: "Pause", run: () => plugin.pauseSkill(skill, true) },
        view.hasOverlay
            ? { label: "Remove from canvas", run: () => plugin.removeOverlay(skill) }
            : { label: "Add to canvas", run: () => plugin.addOverlay(skill) },
    ];
    return (
        <div
            data-skill={SKILL_NAME[skill]}
            draggable
            onDragStart={onDragStart}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            onClick={() => plugin.toggleCompactView(skill)}
            onContextMenu={(e) => openMenu(e, items)}
            style={{
                background: DARKER_GRAY, marginTop: 7, padding: compact ? "1px 5px 5px 5px" : "7px 7px 7px 0",
                fontFamily: FONT, fontSize: FONT_SIZE, cursor: "default",
            }}
        >
            {!compact && (
                <div style={{ display: "flex", alignItems: "center", marginBottom: 7 }}>
                    <div style={{ width: 35, height: 35, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {icon && <img src={icon} alt={SKILL_NAME[skill]} />}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", rowGap: 2, columnGap: 4, flex: 1 }}>
                        {labels.map((label, i) => <Label key={i} name={label.name} value={label.value} />)}
                    </div>
                </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: compact ? 0 : 7 }}>
                {compact && icon && <img src={icon} alt={SKILL_NAME[skill]} style={{ width: 16, height: 16 }} />}
                <div style={{ flex: 1 }}>
                    <ProgressBar plugin={plugin} view={view} />
                </div>
            </div>
        </div>
    );
}

/** RuneLite's XpPanel: the overall row and one info box per skill trained this session. */
export function XpPanel({ plugin }: { plugin: XpTrackerPlugin }): JSX.Element {
    const view = useView(plugin);
    const [menu, setMenu] = useState<MenuState>();
    const [dragging, setDragging] = useState<SkillId>();
    const overallIcon = useSpriteUrl(plugin.getClient(), OVERALL_ICON_SPRITE);
    const close = useCallback(() => setMenu(undefined), []);
    const openMenu = useCallback((e: React.MouseEvent, items: MenuItem[]) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY, items });
    }, []);
    const overallItems = useMemo<MenuItem[]>(() => [
        { label: "Reset All", run: () => plugin.resetAndInitState() },
        { label: "Reset All/hr", run: () => plugin.resetAllSkillsPerHour() },
        { label: "Pause All", run: () => plugin.pauseAllSkills(true) },
        { label: "Unpause All", run: () => plugin.pauseAllSkills(false) },
    ], [plugin]);
    const drop = (target: SkillId) => {
        if (dragging === undefined || dragging === target) return;
        const order = view.skills.map((s) => s.skill).filter((s) => s !== dragging);
        order.splice(order.indexOf(target), 0, dragging);
        plugin.setOrder(order);
        setDragging(undefined);
    };

    return (
        <div className="rl-sidebar-panel-content" style={{ background: DARK_GRAY, padding: 10, fontFamily: FONT }}>
            {view.overall.gained === 0 ? (
                <div style={{ textAlign: "center", padding: "20px 0", color: LIGHT_GRAY }}>
                    <div style={{ color: "white", fontFamily: "var(--rl-font)", marginBottom: 6 }}>Exp trackers</div>
                    <div>You have not gained experience yet.</div>
                </div>
            ) : (
                <div
                    onContextMenu={(e) => openMenu(e, overallItems)}
                    style={{ display: "flex", alignItems: "center", gap: 10, background: DARKER_GRAY, padding: 10 }}
                >
                    {overallIcon && <img src={overallIcon} alt="Overall" />}
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <Label name="Gained: " value={quantityToRSDecimalStack(view.overall.gained)} />
                        <Label name="Per hour: " value={quantityToRSDecimalStack(view.overall.perHour)} />
                    </div>
                </div>
            )}
            {view.skills.map((skill) => (
                <InfoBox
                    key={skill.skill}
                    plugin={plugin}
                    view={skill}
                    openMenu={openMenu}
                    onDragStart={() => setDragging(skill.skill)}
                    onDrop={() => drop(skill.skill)}
                />
            ))}
            <PopupMenu menu={menu} close={close} />
        </div>
    );
}

/** RuneLite's nav button: "XP Tracker", priority 2. */
export function createXpTrackerNavigationButton(plugin: XpTrackerPlugin): NavigationButton {
    return NavigationButton.builder()
        .tooltip("XP Tracker")
        .icon(imageIcon(runeliteImage("xp_overall.png")))
        .priority(2)
        .panel(() => <XpPanel plugin={plugin} />)
        .build();
}
