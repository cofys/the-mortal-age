import { Opcodes as Cs2Opcodes } from "../../rs/cs2/Opcodes";
import type { Script as Cs2Script } from "../../rs/cs2/Script";
import { MenuOpcode } from "../../ui/menu/MenuState";
import type { SimpleMenuEntry } from "../../ui/menu/MenuEngine";
import { fetchContent } from "../../network/serverConnection/contentApi";
import { state as connectionState } from "../../network/serverConnection/state";
import {
    WORLD_MAP_CITIZEN_CAT_LABELS,
    WORLD_MAP_ELEMENT_TOOLTIP_CLEAR_SCRIPT_ID,
    WORLD_MAP_ELEMENT_TOOLTIP_SCRIPT_ID,
    type WorldMapCitizenDot,
    type WorldMapRenderedIcon,
    type WorldMapStateHolder,
} from "./WorldMapTypes";

export type WorldMapIconDeps = {
    loadClientScriptIfExists: (scriptId: number) => Cs2Script | null;
    loadMapElement: (elementId: number) => any;
    runCs2Script: (script: Cs2Script, intArgs: number[]) => void;
    invalidateAllWidgets: () => void;
    /** Plugin entries for the map tile under the mouse (RuneLite plugins' MenuEntryAdded on the map). */
    pluginMenuEntries?: (screenX: number, screenY: number) => SimpleMenuEntry[];
};

export function getWorldMapIconKey(icon: WorldMapRenderedIcon): string {
    return `${icon.elementId | 0}:${icon.coord1 | 0}:${icon.coord2 | 0}`;
}

export function getWorldMapIconsAt(
    state: WorldMapStateHolder,
    screenX: number,
    screenY: number,
): WorldMapRenderedIcon[] {
    const hits: WorldMapRenderedIcon[] = [];
    const x = screenX | 0;
    const y = screenY | 0;
    for (let i = state.renderedWorldMapIcons.length - 1; i >= 0; i--) {
        const icon = state.renderedWorldMapIcons[i];
        if (x >= icon.x0 && x <= icon.x1 && y >= icon.y0 && y <= icon.y1) {
            hits.push(icon);
        }
    }
    return hits;
}

function loadWorldMapScript(
    deps: WorldMapIconDeps,
    eventType: number,
    elementId: number,
    categoryId: number,
): Cs2Script | null {
    const type = eventType | 0;
    const elementScriptId = ((elementId | 0) << 8) + type;
    const categoryScriptId = ((-3 - (categoryId | 0)) << 8) + type;
    const fallbackScriptId = type - 512;
    return (
        loadWorldMapEventScriptIfValid(deps, elementScriptId) ??
        loadWorldMapEventScriptIfValid(deps, categoryScriptId) ??
        loadWorldMapEventScriptIfValid(deps, fallbackScriptId) ??
        loadWorldMapDefaultHoverScript(deps, type)
    );
}

function loadWorldMapDefaultHoverScript(deps: WorldMapIconDeps, eventType: number): Cs2Script | null {
    switch (eventType | 0) {
        case 15:
        case 17:
            return loadWorldMapEventScriptIfValid(deps, WORLD_MAP_ELEMENT_TOOLTIP_SCRIPT_ID);
        case 16:
            return loadWorldMapEventScriptIfValid(deps, WORLD_MAP_ELEMENT_TOOLTIP_CLEAR_SCRIPT_ID);
        default:
            return null;
    }
}

function loadWorldMapEventScriptIfValid(deps: WorldMapIconDeps, scriptId: number): Cs2Script | null {
    const script = deps.loadClientScriptIfExists(scriptId | 0);
    if (!script || !isWorldMapEventScript(deps, script)) return null;
    return script;
}

function isWorldMapEventScript(
    deps: WorldMapIconDeps,
    script: Cs2Script,
    seen: Set<number> = new Set(),
): boolean {
    const scriptId = script.id | 0;
    if (seen.has(scriptId)) return false;
    seen.add(scriptId);
    if (scriptId === WORLD_MAP_ELEMENT_TOOLTIP_CLEAR_SCRIPT_ID) return true;
    const instructions = script.instructions;
    const intOperands = script.intOperands;
    for (let i = 0; i < instructions.length; i++) {
        const opcode = instructions[i] | 0;
        if (
            opcode === Cs2Opcodes.WORLDMAP_ELEMENT ||
            opcode === Cs2Opcodes.WORLDMAP_ELEMENTCOORD1 ||
            opcode === Cs2Opcodes.WORLDMAP_ELEMENTCOORD
        ) {
            return true;
        }
        if (opcode === Cs2Opcodes.INVOKE) {
            const subScript = deps.loadClientScriptIfExists(intOperands[i] | 0);
            if (subScript && isWorldMapEventScript(deps, subScript, seen)) return true;
        }
    }
    return false;
}

function runWorldMapScriptEvent(
    state: WorldMapStateHolder,
    deps: WorldMapIconDeps,
    eventType: number,
    icon: WorldMapRenderedIcon,
    intArgs: number[] = [],
): void {
    const category = icon.category | 0;
    const script = loadWorldMapScript(deps, eventType | 0, icon.elementId | 0, category);
    if (!script) return;
    const previousEvent = state.worldMapState.currentEvent;
    state.worldMapState.setCurrentEvent({
        element: icon.elementId | 0,
        coord1: icon.coord1 | 0,
        coord2: icon.coord2 | 0,
    });
    try {
        deps.runCs2Script(
            script,
            intArgs.map((value) => value | 0),
        );
        deps.invalidateAllWidgets();
    } finally {
        state.worldMapState.setCurrentEvent(previousEvent);
    }
}

export function updateWorldMapIconHover(
    state: WorldMapStateHolder,
    deps: WorldMapIconDeps,
    screenX: number,
    screenY: number,
): void {
    const hits = getWorldMapIconsAt(state, screenX, screenY);
    const next = new Map<string, WorldMapRenderedIcon>();
    const mouseArgs = [screenX | 0, screenY | 0];
    for (const icon of hits) {
        const key = getWorldMapIconKey(icon);
        next.set(key, icon);
        runWorldMapScriptEvent(
            state,
            deps,
            state.hoveredWorldMapIcons.has(key) ? 17 : 15,
            icon,
            mouseArgs,
        );
    }
    for (const [key, icon] of state.hoveredWorldMapIcons) {
        if (!next.has(key)) {
            runWorldMapScriptEvent(state, deps, 16, icon, mouseArgs);
        }
    }
    state.hoveredWorldMapIcons = next;
}

export function getWorldMapMenuEntriesAt(
    state: WorldMapStateHolder,
    deps: WorldMapIconDeps,
    screenX: number,
    screenY: number,
): SimpleMenuEntry[] {
    const citizenEntries = getCitizenMenuEntriesAt(state, screenX | 0, screenY | 0);
    if (citizenEntries.length > 0) return citizenEntries;
    const entries = getWorldMapIconMenuEntriesAt(state, deps, screenX, screenY);
    const plugin = deps.pluginMenuEntries?.(screenX | 0, screenY | 0) ?? [];
    if (plugin.length === 0) return entries;
    if (entries.length === 0) return [...plugin, { option: "Cancel", opcode: MenuOpcode.Cancel }];
    // Above Cancel, under the icon's own options.
    return [...entries.slice(0, -1), ...plugin, entries[entries.length - 1]];
}

function getWorldMapIconMenuEntriesAt(
    state: WorldMapStateHolder,
    deps: WorldMapIconDeps,
    screenX: number,
    screenY: number,
): SimpleMenuEntry[] {
    const icons = getWorldMapIconsAt(state, screenX | 0, screenY | 0);
    const opcodes = [
        MenuOpcode.WorldMap1,
        MenuOpcode.WorldMap2,
        MenuOpcode.WorldMap3,
        MenuOpcode.WorldMap4,
        MenuOpcode.WorldMap5,
    ];
    for (const icon of icons) {
        let element: any;
        try {
            element = deps.loadMapElement(icon.elementId | 0);
        } catch {
            element = undefined;
        }
        const ops = Array.isArray(element?.ops) ? element.ops : [];
        const entries: SimpleMenuEntry[] = [];
        for (let i = 0; i < opcodes.length; i++) {
            const option = typeof ops[i] === "string" ? String(ops[i]).trim() : "";
            if (!option) continue;
            const opcode = opcodes[i] | 0;
            entries.push({
                option,
                target: element?.targetName ?? "",
                opcode,
                targetId: icon.elementId | 0,
                mapX: icon.coord1 | 0,
                mapY: icon.coord2 | 0,
                onClick: () => {
                    runWorldMapScriptEvent(state, deps, opcode - 998, icon);
                },
            });
        }
        if (entries.length > 0) {
            entries.push({ option: "Cancel", opcode: MenuOpcode.Cancel });
            return entries;
        }
    }
    return [];
}

/**
 * Right-click menu for citizen dots on the world map (admin). The dots are
 * recorded by the map renderer each frame; entries call the admin-worldmap
 * content API (session-token authed, admin-gated server-side).
 */
function getCitizenMenuEntriesAt(
    state: WorldMapStateHolder,
    screenX: number,
    screenY: number,
): SimpleMenuEntry[] {
    const dots = state.renderedCitizenDots;
    if (!dots || dots.length === 0) return [];
    const x = screenX | 0;
    const y = screenY | 0;
    let hit: WorldMapCitizenDot | undefined;
    for (let i = dots.length - 1; i >= 0; i--) {
        const d = dots[i];
        if (x >= d.x0 && x <= d.x1 && y >= d.y0 && y <= d.y1) {
            hit = d;
            break;
        }
    }
    if (!hit) return [];
    const username = connectionState.sessionUsername;
    if (!username) return [];
    const target = encodeURIComponent(hit.name);
    const call = (params: string): void => {
        fetchContent(
            `/api/admin-worldmap?player=${encodeURIComponent(username)}${params}`,
        ).catch(() => {
            /* server gates non-admins; failures are silent on the map */
        });
    };
    const label = WORLD_MAP_CITIZEN_CAT_LABELS[hit.category] ?? "Other";
    return [
        {
            option: "Teleport to",
            target: `${hit.name} (${label})`,
            opcode: MenuOpcode.WorldMap1,
            onClick: () => call(`&action=teleport&target=${target}`),
        },
        {
            option: "Pause/Resume brain",
            target: hit.name,
            opcode: MenuOpcode.WorldMap2,
            onClick: () => call(`&action=toggle-brain&target=${target}`),
        },
        { option: "Cancel", opcode: MenuOpcode.Cancel },
    ];
}

export function clearWorldMapRenderCaches(
    state: WorldMapStateHolder,
    clearHostRenderCaches: () => void,
): void {
    clearHostRenderCaches();
    state.renderedWorldMapIcons = [];
    state.renderedCitizenDots = [];
    state.hoveredWorldMapIcons.clear();
}
