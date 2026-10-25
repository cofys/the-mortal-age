import type { ConfigManager } from "@runelite/client/config/ConfigManager";
import { isCustomPack, mergeSavedPacks, readPack, writePack, type TilePack } from "./tilePackData";

/** The group Tile Packs keeps its packs and list filters in (not the config panel's "tilepacks"). */
export const PACK_GROUP = "tilePacks";
const CUSTOM_ID = "customId";
const PACK_PREFIX = "pack_";
const PACKS = "packs";
const SHOW_VISIBLE = "showVisible";
const SHOW_INVISIBLE = "showInvisible";
const VERSION = "tilePacksVersion";
const LEGACY_CUSTOM_PACKS = "customPacks";
const LEGACY_PACK_CONFIGS = "tilePackConfigs";

/**
 * Tile Packs' TilePackManager, FilterManager and TilePackMigrations: the pack list, which packs
 * are on, custom packs and the list filters, in the same config keys and JSON as the plugin.
 */
export class TilePackStore {
    tilePacks = new Map<number, TilePack>();
    enabledPacks: number[] = [];
    showVisible = true;
    showInvisible = false;

    constructor(private readonly configManager: ConfigManager) {}

    /** TilePackMigrations.migrateToLatest: v1 kept custom packs and visibility in two maps. */
    migrateToLatest(): void {
        const raw = this.get(VERSION);
        const version = raw ? parseInt(raw, 10) : 1;
        if (version < 2) {
            this.migrateV1ToV2();
            this.configManager.setConfiguration(PACK_GROUP, VERSION, 2);
        }
    }

    private migrateV1ToV2(): void {
        const customPacks = parseMap(this.get(LEGACY_CUSTOM_PACKS));
        const packConfigs = parseMap(this.get(LEGACY_PACK_CONFIGS));
        if (!customPacks && !packConfigs) return;
        const ids = new Set<number>([...Object.keys(customPacks ?? {}), ...Object.keys(packConfigs ?? {})].map(Number));
        for (const id of ids) {
            const custom = customPacks?.[id];
            const config = packConfigs?.[id];
            const visible = !config || config.visible === true;
            const pack: TilePack = custom
                ? { id, packName: custom.packName, link: custom.link, packTiles: custom.packTiles, visible }
                : { id, visible };
            this.configManager.setConfiguration(PACK_GROUP, PACK_PREFIX + id, writePack(pack));
        }
        for (const id of ids) {
            const saved = readPack(safeParse(this.get(PACK_PREFIX + id)));
            if (!saved || saved.id !== id) throw new Error(`Saved tile pack config is invalid for id ${id}`);
        }
        this.configManager.unsetConfiguration(PACK_GROUP, LEGACY_CUSTOM_PACKS);
        this.configManager.unsetConfiguration(PACK_GROUP, LEGACY_PACK_CONFIGS);
    }

    /** TilePackManager's and FilterManager's constructors, over the bundled packs. */
    load(bundled: Map<number, TilePack>): void {
        const enabled = safeParse(this.get(PACKS));
        this.enabledPacks = Array.isArray(enabled) ? enabled.map(Number).filter(Number.isInteger) : [];
        this.tilePacks = mergeSavedPacks(bundled, this.loadSavedPacks());
        const showVisible = this.get(SHOW_VISIBLE);
        this.showVisible = showVisible ? showVisible === "true" : true;
        const showInvisible = this.get(SHOW_INVISIBLE);
        this.showInvisible = showInvisible ? showInvisible === "true" : false;
    }

    private loadSavedPacks(): TilePack[] {
        const packs: TilePack[] = [];
        const prefix = `${PACK_GROUP}.${PACK_PREFIX}`;
        for (const key of this.configManager.getConfigurationKeys(prefix)) {
            const id = Number(key.slice(prefix.length));
            if (!Number.isInteger(id)) continue;
            const pack = readPack(safeParse(this.get(PACK_PREFIX + id)));
            if (pack) packs.push(pack);
        }
        return packs;
    }

    isPackEnabled(id: number): boolean {
        return this.enabledPacks.includes(id);
    }

    addEnabledPack(id: number): void {
        this.enabledPacks.push(id);
        this.configManager.setConfiguration(PACK_GROUP, PACKS, JSON.stringify(this.enabledPacks));
    }

    removeEnabledPack(id: number): void {
        const at = this.enabledPacks.indexOf(id);
        if (at >= 0) this.enabledPacks.splice(at, 1);
        if (this.enabledPacks.length === 0) {
            this.configManager.unsetConfiguration(PACK_GROUP, PACKS);
            return;
        }
        this.configManager.setConfiguration(PACK_GROUP, PACKS, JSON.stringify(this.enabledPacks));
    }

    /** The last custom pack id used; 9999 before the first. */
    loadCustomId(): number {
        const raw = this.get(CUSTOM_ID);
        const id = raw ? parseInt(raw, 10) : NaN;
        return Number.isInteger(id) ? id : 9999;
    }

    /** Saves a new custom pack and turns it on. */
    addCustomPack(name: string, tiles: string): TilePack {
        const id = this.loadCustomId() + 1;
        const pack: TilePack = { id, packName: name, packTiles: tiles, visible: true };
        this.savePack(pack);
        this.configManager.setConfiguration(PACK_GROUP, CUSTOM_ID, id);
        this.addEnabledPack(id);
        this.tilePacks.set(id, pack);
        return pack;
    }

    removeCustomPack(id: number): void {
        this.removeEnabledPack(id);
        this.configManager.unsetConfiguration(PACK_GROUP, PACK_PREFIX + id);
        this.tilePacks.delete(id);
    }

    /** Saves a pack's visibility: the whole pack for a custom one, else just {id, visible}. */
    updatePack(pack: TilePack): void {
        this.savePack(isCustomPack(pack) ? pack : { id: pack.id, visible: pack.visible });
    }

    setShowVisible(show: boolean): void {
        this.showVisible = show;
        this.configManager.setConfiguration(PACK_GROUP, SHOW_VISIBLE, show);
    }

    setShowInvisible(show: boolean): void {
        this.showInvisible = show;
        this.configManager.setConfiguration(PACK_GROUP, SHOW_INVISIBLE, show);
    }

    private savePack(pack: TilePack): void {
        this.configManager.setConfiguration(PACK_GROUP, PACK_PREFIX + pack.id, writePack(pack));
    }

    private get(key: string): string | undefined {
        const value = this.configManager.getConfiguration(PACK_GROUP, key);
        return value === "" ? undefined : value;
    }
}

type LegacyEntry = { packName?: string; link?: string; packTiles?: string; visible?: boolean };

function parseMap(json: string | undefined): Record<number, LegacyEntry> | undefined {
    if (!json) return undefined;
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
}

function safeParse(json: string | undefined): unknown {
    if (json === undefined) return undefined;
    try {
        return JSON.parse(json);
    } catch {
        return undefined;
    }
}
