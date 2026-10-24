import { GameState } from "@runelite/api/GameState";
import type {
    ConfigChanged,
    GameStateChanged,
    NpcChanged,
    NpcDespawned,
    NpcSpawned,
} from "@runelite/api/events";
import { SMOKEPUFF } from "@runelite/api/gameval/SpotanimID";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { subscribeSpot } from "../../../network/serverConnection/subscriptions/audio";
import { toRuneLiteGameState } from "../../../runelite/impl/GameStateMapping";
import { baseNpcTypeId } from "../../../custom/npcs/NpcModelOverrideRegistry";
import type { NpcType } from "../../../rs/config/npctype/NpcType";
import { MenuTargetType } from "../../../rs/MenuEntry";
import { getEffectiveNpcType } from "../../../render/webgpu/actors/actorPacking";
import type { SimpleMenuEntry } from "../../../ui/menu/MenuEngine";
import type { MenuTransformContext } from "../../../ui/menu/menuTransforms";
import { ClientState } from "../../ClientState";
import type { OsrsClient } from "../../OsrsClient";
import type { HealthBarEvent, NpcOutline, WidgetOverlay } from "../ClientPluginManager";
import { NpcIndicatorsConfig, argbToRgba } from "./NpcIndicatorsConfig";
import {
    CORP_DEATH,
    DEATH_ANIMATIONS,
    NPC_DEATH_HIDER_EXCLUDE,
    RESET_DEAD_ON_CHANGE,
    isDying,
} from "./npcDeath";
import {
    TAG_STYLES,
    TAG_STYLE_LABELS,
    type HighlightFlags,
    type MenuHighlightStyle,
    fromCSV,
    prependColorTag,
    recolorMenuTarget,
    resolveHighlightFlags,
    stripTags,
    tagColorChoices,
    toCSV,
    wildcardMatches,
} from "./npcMatching";
import { NpcOverlay } from "./NpcOverlay";
import { RespawnTracker, type WorldPoint } from "./respawn";

const GROUP = NpcIndicatorsConfig.group;
export const HIGHLIGHT_COLOR_PREFIX = "highlightcolor_";
export const TAG_STYLE_PREFIX = "tagstyle_";

/** One highlighted NPC: RuneLite's HighlightedNpc. */
export type HighlightedNpc = {
    ecsId: number;
    index: number;
    id: number;
    name: string;
    /** 0xAARRGGBB */
    color: number;
    flags: HighlightFlags;
};

type DeathState = { dead: boolean; ratio: number };

/**
 * RuneLite 1.13.3 NPC Indicators. Highlights NPCs by name (with `*` wildcards) or by tag
 * (Shift + right-click Examine: Tag), with hull, tile, true tile, south-west tile, south-west
 * true tile or model outline, names above them and on the minimap, recoloured menu entries,
 * per-NPC tag colours and styles, and learnt respawn timers.
 */
export class NpcIndicatorsPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "NPC Indicators",
        description: "Highlight NPCs on-screen and/or on the minimap",
        tags: ["highlight", "minimap", "npcs", "overlay", "respawn", "tags"],
        enabledByDefault: false,
        configKey: "npcindicatorsplugin",
    };

    static config = NpcIndicatorsConfig;

    private readonly configManager = inject(ConfigManager);
    readonly config = this.configManager.getConfig(NpcIndicatorsConfig);
    private readonly osrsClient: OsrsClient;

    /** Tagged NPCs, by server index (in memory only, as RuneLite). */
    readonly npcTags = new Set<number>();
    /** Highlighted NPCs by ECS id. */
    readonly highlightedNpcs = new Map<number, HighlightedNpc>();
    readonly respawn = new RespawnTracker();
    private highlights: string[] = [];
    private readonly deaths = new Map<number, DeathState>();
    private tickCount = 0;
    lastTickAt = 0;
    private unsubscribeSpot?: () => void;
    readonly overlay: NpcOverlay;
    readonly widgetOverlay: WidgetOverlay;

    constructor(osrsClient?: OsrsClient) {
        super();
        this.osrsClient = osrsClient ?? inject<OsrsClient>(CLIENT_TOKEN);
        this.overlay = new NpcOverlay(this);
        this.widgetOverlay = this.overlay;
    }

    protected async startUp(): Promise<void> {
        this.migrate();
        this.respawn.clear();
        this.rebuild();
        try {
            this.unsubscribeSpot = subscribeSpot((spot) => {
                if (spot.spotId === SMOKEPUFF && spot.tile && spot.npcId === undefined && spot.playerId === undefined) {
                    this.respawn.onTeleport({ x: spot.tile.x, y: spot.tile.y, plane: spot.tile.level ?? this.playerPlane() });
                }
            });
        } catch {}
    }

    protected async shutDown(): Promise<void> {
        this.unsubscribeSpot?.();
        this.unsubscribeSpot = undefined;
        this.npcTags.clear();
        this.highlightedNpcs.clear();
        this.respawn.clear();
        this.deaths.clear();
        this.highlights = [];
    }

    /** RuneLite's migrate(): the old highlightMenuNames switch becomes highlightMenuStyle. */
    private migrate(): void {
        const old = this.configManager.getConfiguration(GROUP, "highlightMenuNames");
        if (old === undefined || old === null) return;
        this.configManager.unsetConfiguration(GROUP, "highlightMenuNames");
        this.configManager.setConfiguration(GROUP, "highlightMenuStyle", old === "true" ? "BOTH" : "NONE");
    }

    // ------------------------------------------------------------------ npc facts

    getClient(): OsrsClient {
        return this.osrsClient;
    }

    /** The NPC's transformed type (RuneLite's getTransformedComposition), or undefined. */
    npcType(ecsId: number): NpcType | undefined {
        const id = this.npcId(ecsId);
        return id >= 0 ? getEffectiveNpcType(this.osrsClient, id) : undefined;
    }

    /** RuneLite's NPC.getId(): the cache type id (model customisations map back to it). */
    npcId(ecsId: number): number {
        return baseNpcTypeId(this.osrsClient.npcEcs.getNpcTypeId(ecsId) | 0);
    }

    npcName(ecsId: number): string | undefined {
        const name = this.npcType(ecsId)?.name;
        return name && name !== "null" ? stripTags(name) : undefined;
    }

    private npcIndex(ecsId: number): number {
        return this.osrsClient.npcEcs.getServerId(ecsId) | 0;
    }

    /** The NPC's south-west tile (RuneLite's getWorldLocation), from the server's position. */
    npcWorldLocation(ecsId: number): WorldPoint {
        const npcs = this.osrsClient.npcEcs;
        const state = npcs.getServerState(ecsId);
        if (state) return { x: state.tileX, y: state.tileY, plane: state.plane };
        const size = Math.max(1, npcs.getSize(ecsId) | 0);
        return {
            x: Math.floor((npcs.getWorldX(ecsId) - size * 64) / 128),
            y: Math.floor((npcs.getWorldY(ecsId) - size * 64) / 128),
            plane: npcs.getLevel(ecsId) | 0,
        };
    }

    isDying(ecsId: number): boolean {
        const type = this.npcType(ecsId);
        const death = this.deaths.get(this.npcIndex(ecsId));
        return isDying({
            id: this.npcId(ecsId),
            actions: type?.actions,
            deathHiderExclude: Number(type?.params?.get?.(NPC_DEATH_HIDER_EXCLUDE) ?? 0) | 0,
            dead: death?.dead === true,
            healthRatio: death?.ratio ?? -1,
        });
    }

    private gameState(): GameState {
        return toRuneLiteGameState((this.osrsClient as any)?.gameState);
    }

    private playerTile(): WorldPoint | undefined {
        const client: any = this.osrsClient;
        const players = client.playerEcs;
        const index = players?.getIndexForServerId?.(client.controlledPlayerServerId);
        if (index === undefined) return undefined;
        return { x: players.getX(index) >> 7, y: players.getY(index) >> 7, plane: players.getLevel(index) | 0 };
    }

    playerPlane(): number {
        return this.playerTile()?.plane ?? 0;
    }

    // ------------------------------------------------------------------ highlights

    private highlightMatchesNpcName(name: string): boolean {
        return this.highlights.some((h) => wildcardMatches(h, name));
    }

    private tagColor(id: number): number | undefined {
        const raw = this.configManager.getConfiguration(GROUP, HIGHLIGHT_COLOR_PREFIX + id);
        if (!raw) return undefined;
        const value = parseInt(raw.replace(/^#/, ""), 16);
        return Number.isFinite(value) ? value >>> 0 : undefined;
    }

    private tagStyle(id: number): string | undefined {
        return this.configManager.getConfiguration(GROUP, TAG_STYLE_PREFIX + id) || undefined;
    }

    private globalFlags(): HighlightFlags {
        return {
            hull: this.config.highlightHull() === true,
            tile: this.config.highlightTile() === true,
            trueTile: this.config.highlightTrueTile() === true,
            swTile: this.config.highlightSouthWestTile() === true,
            swTrueTile: this.config.highlightSouthWestTrueTile() === true,
            outline: this.config.highlightOutline() === true,
        };
    }

    private highlightedNpc(ecsId: number, name: string): HighlightedNpc {
        const id = this.npcId(ecsId);
        const tagColor = this.tagColor(id);
        return {
            ecsId,
            index: this.npcIndex(ecsId),
            id,
            name,
            color: tagColor !== undefined ? tagColor : Number(this.config.highlightColor()) >>> 0,
            flags: resolveHighlightFlags(this.globalFlags(), this.tagStyle(id)),
        };
    }

    private memorize(ecsId: number, name: string): void {
        this.respawn.memorize(this.npcIndex(ecsId), name, Math.max(1, this.npcType(ecsId)?.size ?? 1));
    }

    /** RuneLite's rebuild(): re-reads the list and re-evaluates every loaded NPC. */
    rebuild(): void {
        this.highlights = fromCSV(String(this.config.npcToHighlight() ?? ""));
        this.highlightedNpcs.clear();
        const state = this.gameState();
        if (state !== GameState.LOGGED_IN && state !== GameState.LOADING) return;
        const npcs = this.osrsClient.npcEcs;
        for (const ecsId of npcs.getAllActiveIds()) {
            if (!npcs.isLinked(ecsId)) continue;
            const name = this.npcName(ecsId);
            if (!name) continue;
            const index = this.npcIndex(ecsId);
            if (this.npcTags.has(index)) {
                this.highlightedNpcs.set(ecsId, this.highlightedNpc(ecsId, name));
            } else if (this.highlightMatchesNpcName(name)) {
                if (!ClientState.inInstance) this.memorize(ecsId, name);
                this.highlightedNpcs.set(ecsId, this.highlightedNpc(ecsId, name));
            } else {
                this.respawn.forget(index);
            }
        }
    }

    // ------------------------------------------------------------------ events

    onNpcSpawned(event: NpcSpawned): void {
        const { ecsId, index } = event.getNpc();
        const name = this.npcName(ecsId);
        if (!name) return;
        const orientation = this.osrsClient.npcEcs.getRotation(ecsId) | 0;
        if (this.npcTags.has(index)) {
            this.memorize(ecsId, name);
            this.highlightedNpcs.set(ecsId, this.highlightedNpc(ecsId, name));
            this.respawn.onSpawned(index, this.npcWorldLocation(ecsId), orientation);
            return;
        }
        if (this.highlightMatchesNpcName(name)) {
            this.highlightedNpcs.set(ecsId, this.highlightedNpc(ecsId, name));
            if (!ClientState.inInstance) {
                this.memorize(ecsId, name);
                this.respawn.onSpawned(index, this.npcWorldLocation(ecsId), orientation);
            }
        }
    }

    onNpcDespawned(event: NpcDespawned): void {
        const { ecsId, index } = event.getNpc();
        this.respawn.onDespawned(index, this.npcWorldLocation(ecsId));
        this.highlightedNpcs.delete(ecsId);
        this.deaths.delete(index);
    }

    onNpcChanged(event: NpcChanged): void {
        const { ecsId, index } = event.getNpc();
        if (RESET_DEAD_ON_CHANGE.has(this.npcId(ecsId))) this.deaths.delete(index);
        this.highlightedNpcs.delete(ecsId);
        const name = this.npcName(ecsId);
        if (name && (this.npcTags.has(index) || this.highlightMatchesNpcName(name))) {
            this.highlightedNpcs.set(ecsId, this.highlightedNpc(ecsId, name));
        }
    }

    onGameStateChanged(event: GameStateChanged): void {
        const state = event.getGameState();
        if (state === GameState.LOGIN_SCREEN || state === GameState.HOPPING) {
            this.respawn.resetForHop();
            this.highlightedNpcs.clear();
            this.deaths.clear();
        }
    }

    onGameTick(): void {
        this.tickCount++;
        // Death animations mark NPCs dead (NpcUtil.onAnimationChanged).
        const npcs = this.osrsClient.npcEcs;
        for (const npc of this.highlightedNpcs.values()) {
            const seq = npcs.getSeqId(npc.ecsId) | 0;
            if (DEATH_ANIMATIONS.has(seq) || (seq === CORP_DEATH.animation && npc.id === CORP_DEATH.npc)) {
                this.deaths.set(npc.index, { dead: true, ratio: this.deaths.get(npc.index)?.ratio ?? -1 });
            }
        }
        this.respawn.tick(this.tickCount, this.playerTile());
        this.lastTickAt = performance.now();
    }

    getTickCount(): number {
        return this.tickCount;
    }

    onConfigChanged(event: ConfigChanged): void {
        if (event.getGroup() === GROUP) this.rebuild();
    }

    /** A health bar of 0 marks the NPC dead (RuneLite's NPC.isDead()). */
    onHealthBar(event: HealthBarEvent): void {
        if (event.type !== "npc" || event.bar.removed) return;
        const previous = this.deaths.get(event.serverId);
        const ratio = event.bar.health2 | 0;
        this.deaths.set(event.serverId, { dead: previous?.dead === true || ratio === 0, ratio });
    }

    // ------------------------------------------------------------------ drawing rules

    /** RuneLite's render predicate plus NpcOverlay's composition checks. */
    shouldDraw(npc: HighlightedNpc): boolean {
        const type = this.npcType(npc.ecsId);
        if (!type || !type.isInteractable) return false;
        if (this.config.ignoreDeadNpcs() && this.isDying(npc.ecsId)) return false;
        if (this.config.ignorePets() && type.isFollower) return false;
        return true;
    }

    /** Model outlines for highlighted NPCs styled "outline" (ModelOutlineRenderer). */
    npcOutlines(): NpcOutline[] {
        if (!this.isStarted() || this.gameState() !== GameState.LOGGED_IN) return [];
        const outlines: NpcOutline[] = [];
        const plane = this.playerPlane();
        for (const npc of this.highlightedNpcs.values()) {
            if (!npc.flags.outline || !this.shouldDraw(npc)) continue;
            if ((this.osrsClient.npcEcs.getLevel(npc.ecsId) | 0) !== plane) continue;
            const [r, g, b, a] = argbToRgba(npc.color);
            outlines.push({
                ecsId: npc.ecsId,
                serverId: npc.index,
                color: (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255),
                alpha: a,
                width: Number(this.config.borderWidth()) || 2,
            });
        }
        return outlines;
    }

    // ------------------------------------------------------------------ menu

    transformMenuEntries(entries: SimpleMenuEntry[], context: MenuTransformContext): SimpleMenuEntry[] {
        if (!this.isStarted() || context.surface !== "world") return entries;
        let out: SimpleMenuEntry[] | undefined;
        const shift = ClientState.isShiftPressed();
        for (let i = 0; i < (out ?? entries).length; i++) {
            const list = out ?? entries;
            const entry = list[i];
            if (entry.targetType !== MenuTargetType.NPC || typeof entry.npcServerId !== "number") continue;
            const ecsId = this.osrsClient.npcEcs.getEcsIdForServer(entry.npcServerId);
            if (ecsId === undefined || ecsId < 0) continue;
            const name = this.npcName(ecsId);
            if (shift && String(entry.option).toLowerCase() === "examine") {
                if (!name) continue;
                const tagEntries = this.tagMenu(ecsId, name, String(entry.target ?? ""));
                out = list.slice();
                out.splice(i, 0, ...tagEntries);
                i += tagEntries.length;
                continue;
            }
            const recolored = this.recolor(ecsId, String(entry.target ?? ""));
            if (recolored !== entry.target) {
                out = out ?? entries.slice();
                out[i] = { ...entry, target: recolored };
            }
        }
        return out ?? entries;
    }

    private recolor(ecsId: number, target: string): string {
        const dying = this.isDying(ecsId);
        const deadColor = Number(this.config.deadNpcMenuColor());
        if (dying && Number.isFinite(deadColor) && deadColor >= 0) {
            return prependColorTag(stripTags(target), deadColor);
        }
        const npc = this.highlightedNpcs.get(ecsId);
        if (npc && (!dying || !this.config.ignoreDeadNpcs())) {
            return recolorMenuTarget(target, this.config.highlightMenuStyle() as MenuHighlightStyle, npc.color);
        }
        return target;
    }

    /**
     * Shift + right-click Examine: Tag/Un-tag, Tag-All/Un-tag-All and, for a highlighted NPC,
     * the Tag color and Tag style submenus. Shown just above Examine, as RuneLite inserts them.
     */
    private tagMenu(ecsId: number, name: string, target: string): SimpleMenuEntry[] {
        const index = this.npcIndex(ecsId);
        const id = this.npcId(ecsId);
        const nameMatch = this.highlights.some((h) => h.toLowerCase() === name.toLowerCase());
        const idMatch = this.npcTags.has(index);
        const wildcardMatch = this.highlights.some(
            (h) => h.toLowerCase() !== name.toLowerCase() && wildcardMatches(h, name),
        );
        const entry = (option: string, onClick: () => void): SimpleMenuEntry =>
            ({ option, target, targetType: MenuTargetType.NONE, onClick });
        const out: SimpleMenuEntry[] = [entry(idMatch ? "Un-tag" : "Tag", () => this.tag(index))];
        if (!wildcardMatch) out.push(entry(nameMatch ? "Un-tag-All" : "Tag-All", () => this.tagAll(name)));
        if (idMatch || nameMatch || wildcardMatch) {
            const current = this.tagColor(id);
            const inUse: number[] = [];
            for (const other of this.osrsClient.npcEcs.getAllActiveIds()) {
                const color = this.tagColor(this.npcId(other));
                if (color !== undefined) inUse.push(color);
            }
            const colors: SimpleMenuEntry[] = tagColorChoices(inUse).map((rgb) => ({
                option: prependColorTag("Set color", rgb),
                target: "",
                onClick: () => this.setTagColor(id, rgb),
            }));
            colors.push({ option: "Pick color", target: "", onClick: () => this.pickTagColor(id) });
            if (current !== undefined) colors.push({ option: "Reset", target: "", onClick: () => this.setTagColor(id) });
            out.push({ ...entry("Tag color", () => {}), subEntries: colors });

            const styles: SimpleMenuEntry[] = TAG_STYLES.map((style) => ({
                option: TAG_STYLE_LABELS[style],
                target: "",
                onClick: () => this.setTagStyle(id, style),
            }));
            if (this.tagStyle(id)) styles.push({ option: "Reset", target: "", onClick: () => this.setTagStyle(id) });
            out.push({ ...entry("Tag style", () => {}), subEntries: styles });
        }
        return out;
    }

    /** Tag / Un-tag one NPC by index (RuneLite's tag()). */
    tag(index: number): void {
        const ecsId = this.osrsClient.npcEcs.getEcsIdForServer(index);
        if (ecsId === undefined || ecsId < 0) return;
        const name = this.npcName(ecsId);
        if (!name) return;
        if (this.highlightedNpcs.has(ecsId)) {
            this.npcTags.delete(index);
            if (!this.highlightMatchesNpcName(name)) {
                this.highlightedNpcs.delete(ecsId);
                this.respawn.forget(index);
            }
        } else {
            if (!ClientState.inInstance) {
                this.memorize(ecsId, name);
                this.npcTags.add(index);
            }
            this.highlightedNpcs.set(ecsId, this.highlightedNpc(ecsId, name));
        }
    }

    /** Tag-All / Un-tag-All: adds the name to, or removes it from, the highlight list. */
    tagAll(name: string): void {
        const list = [...this.highlights];
        const kept = list.filter((h) => h.toLowerCase() !== name.toLowerCase());
        if (kept.length === list.length) kept.push(name);
        this.configManager.setConfiguration(GROUP, "npcToHighlight", toCSV(kept));
    }

    setTagColor(npcId: number, rgb?: number): void {
        if (rgb === undefined) this.configManager.unsetConfiguration(GROUP, HIGHLIGHT_COLOR_PREFIX + npcId);
        else this.configManager.setConfiguration(GROUP, HIGHLIGHT_COLOR_PREFIX + npcId,
            `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`);
        this.rebuild();
    }

    setTagStyle(npcId: number, style?: string): void {
        if (!style) this.configManager.unsetConfiguration(GROUP, TAG_STYLE_PREFIX + npcId);
        else this.configManager.setConfiguration(GROUP, TAG_STYLE_PREFIX + npcId, style);
        this.rebuild();
    }

    /** RuneLite opens a colour chooser; here it is the browser's own colour picker. */
    private pickTagColor(npcId: number): void {
        if (typeof document === "undefined") return;
        document.querySelectorAll("input[data-npc-tag-picker]").forEach((old) => old.remove());
        const input = document.createElement("input");
        input.type = "color";
        input.dataset.npcTagPicker = "";
        input.value = `#${((this.tagColor(npcId) ?? 0xffffff) & 0xffffff).toString(16).padStart(6, "0")}`;
        Object.assign(input.style, { position: "fixed", left: "-100px", top: "0", opacity: "0", pointerEvents: "none" });
        input.addEventListener("change", () => {
            const rgb = parseInt(input.value.slice(1), 16);
            if (Number.isInteger(rgb)) this.setTagColor(npcId, rgb);
            input.remove();
        }, { once: true });
        input.addEventListener("blur", () => setTimeout(() => input.remove(), 0), { once: true });
        document.body.appendChild(input);
        try {
            input.showPicker();
        } catch {
            input.click();
        }
    }
}
